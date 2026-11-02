const http=require('node:http');
const {createHash,randomUUID}=require('node:crypto');
const {readFileSync,mkdirSync,existsSync}=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {WebSocketServer,WebSocket}=require('ws');
const {createRoom,joinRoom,applyCommand,viewRoom}=require('./game.cjs');
const ROOM_LIFETIME=7*24*60*60*1000;
const hash=token=>createHash('sha256').update(token).digest('hex');
const failure=(status,message)=>Object.assign(new Error(message),{status});
function readBody(req){
  return new Promise((resolve,reject)=>{
    let size=0,failed=false;const chunks=[];
    req.on('data',chunk=>{
      size+=chunk.length;
      if(size>4096){if(!failed)reject(failure(413,'Request too large.'));failed=true;return}
      chunks.push(chunk);
    });
    req.on('end',()=>{if(!failed){try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{reject(failure(400,'Invalid JSON.'))}}});
    req.on('error',reject);
  });
}
function createServer({dataDir=process.env.HAPPY_PIGS_DATA_DIR||path.join(os.homedir(),'Dropbox','Apps','happy-pigs-data'),
  publicOrigin=process.env.PUBLIC_ORIGIN||'',trustProxy=process.env.TRUST_PROXY==='1',clock=Date.now}={}){
  const publicOrigins=new Set(publicOrigin.split(',').map(origin=>origin.trim()).filter(Boolean));
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  const db=new DatabaseSync(path.join(dataDir,'rooms.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms(expires)');
  const get=db.prepare('SELECT data FROM rooms WHERE id=? AND expires>?');
  const put=db.prepare('INSERT INTO rooms(id,expires,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires,data=excluded.data');
  const expired=db.prepare('SELECT id FROM rooms WHERE expires<=?');
  const prune=db.prepare('DELETE FROM rooms WHERE expires<=?');
  const read=id=>{const row=get.get(id,clock());return row?JSON.parse(row.data):null};
  const save=room=>{room.expiresAt=clock()+ROOM_LIFETIME;put.run(room.id,room.expiresAt,JSON.stringify(room))};
  const atomic=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(error){db.exec('ROLLBACK');throw error}};
  const releaseFile=path.join(__dirname,'..','RELEASE');
  const version=process.env.APP_VERSION||(existsSync(releaseFile)?readFileSync(releaseFile,'utf8').trim():'development');
  const peers=new Map(),rates=new Map();let stopping=false;
  const assets=new Map(['/','/index.html','/game-core.js','/online.js'].map(url=>[url,{
    body:readFileSync(path.join(__dirname,'..','dist',url==='/'?'index.html':url.slice(1))),
    type:url.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8'}]));
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
  function remote(req){
    const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    return trustProxy&&local?req.headers['x-real-ip']||req.socket.remoteAddress:req.socket.remoteAddress;
  }
  function limited(req,kind,max){
    const key=`${kind}:${remote(req)}`,now=clock();let r=rates.get(key);
    if(!r||now-r.start>=60000){
      if(rates.size>=10000&&!r)return true;
      r={start:now,count:0};rates.set(key,r);
    }
    return ++r.count>max;
  }
  function originOK(req){return !req.headers.origin||(publicOrigins.size?publicOrigins.has(req.headers.origin):req.headers.origin===`http://${req.headers.host}`)}
  function authenticated(id){return [...(peers.get(id)||[])].filter(ws=>ws.seat!==undefined&&ws.readyState===WebSocket.OPEN)}
  function snapshot(ws,room){
    if(ws.seat===undefined||ws.readyState!==WebSocket.OPEN)return;
    if(ws.bufferedAmount>1024*1024){ws.close(1013,'Connection too slow');return}
    ws.send(JSON.stringify({type:'state',...viewRoom(room,ws.seat,authenticated(room.id).map(s=>s.seat))}));
  }
  function broadcast(room){for(const ws of authenticated(room.id))snapshot(ws,room)}
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
    try{
      if(stopping)throw failure(503,'Server restarting.');
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/health'&&req.method==='GET')return json(res,200,{ok:db.prepare('SELECT 1 AS ok').get().ok===1,version});
      if(!url.pathname.startsWith('/api/')){
        const asset=assets.get(url.pathname);
        if(!asset||!['GET','HEAD'].includes(req.method))throw failure(404,'Not found.');
        res.writeHead(200,{'Content-Type':asset.type,'Cache-Control':'no-cache','Content-Length':asset.body.length});
        return res.end(req.method==='HEAD'?undefined:asset.body);
      }
      if(!originOK(req))throw failure(403,'Invalid origin.');
      if(limited(req,'api',120))throw failure(429,'Too many requests. Please wait a minute.');
      if(req.method==='POST'&&limited(req,'rooms',20))throw failure(429,'Too many room requests. Please wait a minute.');
      if(url.pathname==='/api/rooms'&&req.method==='POST'){
        const input=await readBody(req),token=randomUUID()+randomUUID(),room=createRoom(input?.name,hash(token));
        room.id=randomUUID().replaceAll('-','');atomic(()=>save(room));return json(res,201,{room:room.id,token});
      }
      const match=url.pathname.match(/^\/api\/rooms\/([a-f0-9]{32})\/(join|connect)$/);
      if(!match)throw failure(404,'Not found.');
      if(match[2]==='join'&&req.method==='POST'){
        const input=await readBody(req),token=randomUUID()+randomUUID();
        const room=atomic(()=>{
          const r=read(match[1]);if(!r)throw failure(404,'Room not found or expired.');
          joinRoom(r,input?.name,hash(token));save(r);return r;
        });broadcast(room);return json(res,201,{room:room.id,token});
      }
      if(match[2]==='connect'&&req.method==='GET'){
        if(!read(match[1]))throw failure(404,'Room not found or expired.');
        return json(res,200,{active:true});
      }
      throw failure(404,'Not found.');
    }catch(error){json(res,error.status||400,{error:error.message||'Request failed.'})}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  const wss=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{
    const reject=(status,text)=>{socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`)};
    if(stopping)return reject(503,'Unavailable');
    if(!originOK(req))return reject(403,'Forbidden');
    if(limited(req,'connect',60))return reject(429,'Too Many Requests');
    const match=req.url.match(/^\/api\/rooms\/([a-f0-9]{32})\/connect$/);
    if(!match||!read(match[1]))return reject(404,'Not Found');
    if((peers.get(match[1])?.size||0)>=12||wss.clients.size>=500)return reject(429,'Too Many Connections');
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,match[1]));
  });
  wss.on('connection',(ws,id)=>{
    if(!peers.has(id))peers.set(id,new Set());peers.get(id).add(ws);
    ws.window=clock();ws.count=0;ws.lastSeen=clock();
    const authTimeout=setTimeout(()=>ws.close(4003,'Authentication timed out'),15000);authTimeout.unref();
    ws.on('pong',()=>ws.lastSeen=clock());
    ws.on('error',()=>ws.terminate());
    ws.on('close',()=>{
      clearTimeout(authTimeout);peers.get(id)?.delete(ws);if(peers.get(id)?.size===0)peers.delete(id);
      if(!stopping){const room=read(id);if(room)broadcast(room)}
    });
    ws.on('message',(data,binary)=>{
      let command;
      try{
        if(stopping||ws.readyState!==WebSocket.OPEN)return;
        ws.lastSeen=clock();
        if(clock()-ws.window>10000){ws.window=clock();ws.count=0}
        if(++ws.count>60){ws.close(1008,'Too many messages');return}
        if(binary)throw new Error('Invalid message.');
        const raw=data.toString();
        if(raw==='ping'&&ws.seat!==undefined){ws.send('pong');return}
        command=JSON.parse(raw);
        let room=read(id);if(!room){ws.close(4004,'Room expired');return}
        if(ws.seat===undefined){
          if(command?.type!=='auth'||typeof command.token!=='string'||command.token.length!==72){ws.close(4003,'Invalid seat token');return}
          const seat=room.seats.findIndex(s=>s?.tokenHash===hash(command.token));
          if(seat<0){ws.close(4003,'Invalid seat token');return}
          for(const old of authenticated(id))if(old!==ws&&old.seat===seat){old.seat=undefined;old.close(4001,'Seat opened in another tab')}
          ws.seat=seat;clearTimeout(authTimeout);broadcast(room);return;
        }
        room=atomic(()=>{const latest=read(id);if(!latest)throw new Error('Room expired.');
          const next=applyCommand(latest,ws.seat,command);if(next!==latest)save(next);return next});
        broadcast(room);ws.send(JSON.stringify({type:'ack',id:command.id}));
      }catch(error){
        if(ws.readyState!==WebSocket.OPEN)return;
        ws.send(JSON.stringify({type:'error',id:command?.id,message:error.message||'Move rejected.'}));
        const room=read(id);if(room)snapshot(ws,room);
      }
    });
  });
  const cleanup=setInterval(()=>{
    for(const {id} of expired.all(clock()))for(const ws of peers.get(id)||[])ws.close(4004,'Room expired');
    prune.run(clock());
    for(const [key,r] of rates)if(clock()-r.start>=60000)rates.delete(key);
    for(const ws of wss.clients){if(clock()-ws.lastSeen>60000)ws.terminate();else if(ws.readyState===WebSocket.OPEN)ws.ping()}
  },30000);cleanup.unref();
  async function close(){
    if(stopping)return;stopping=true;clearInterval(cleanup);
    for(const ws of wss.clients)ws.close(1012,'Server restarting');
    const end=setTimeout(()=>{for(const ws of wss.clients)ws.terminate();server.closeAllConnections()},500);end.unref();
    await new Promise(resolve=>server.close(resolve));clearTimeout(end);db.close();
  }
  return {server,close};
}
if(require.main===module){
  const {server,close}=createServer();
  const port=Number(process.env.PORT||8787),host=process.env.HOST||'127.0.0.1';
  server.listen(port,host,()=>console.log(`Happy Pigs listening on http://${host}:${port}`));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>close().then(()=>process.exit(0)));
}
module.exports={createServer};
