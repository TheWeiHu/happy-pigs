import {DurableObject} from 'cloudflare:workers';
import game from './game.cjs';
const {createRoom,joinRoom,applyCommand,viewRoom}=game;
const ROOM_LIFETIME=7*24*60*60*1000;
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
const hash=async token=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),x=>x.toString(16).padStart(2,'0')).join('');
const newToken=()=>crypto.randomUUID()+crypto.randomUUID();
async function body(request){
  if(Number(request.headers.get('content-length'))>4096)throw new Error('Request too large.');
  const reader=request.body?.getReader();if(!reader)throw new Error('Missing request body.');
  let size=0,text='';const decoder=new TextDecoder();
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>4096){await reader.cancel();throw new Error('Request too large.')}
    text+=decoder.decode(value,{stream:true});}
  return JSON.parse(text+decoder.decode());
}
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(request);
    if(request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)return json({error:'Invalid origin.'},403);
    try{
      if(request.method==='POST'&&!(await env.ROOM_LIMITER.limit({key:request.headers.get('CF-Connecting-IP')||'local'})).success)return json({error:'Too many room requests. Please wait a minute.'},429);
      if(url.pathname==='/api/rooms'&&request.method==='POST'){
        const input=await body(request);
        const id=crypto.randomUUID().replaceAll('-','');
        return env.ROOMS.get(env.ROOMS.idFromName(id)).fetch(new Request(`${url.origin}/create`,{method:'POST',body:JSON.stringify({name:input.name,id})}));
      }
      const match=url.pathname.match(/^\/api\/rooms\/([a-f0-9]{32})\/(join|connect)$/);
      if(!match)return json({error:'Not found.'},404);
      const forwarded=new Request(`${url.origin}/${match[2]}`,request);
      return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(forwarded);
    }catch(error){return json({error:error.message||'Request failed.'},400)}
  }
};
export class GameRoom extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);this.ctx=ctx;
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)');
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
  }
  read(){
    const rows=this.ctx.storage.sql.exec('SELECT data FROM room WHERE id=1').toArray();
    return rows.length?JSON.parse(rows[0].data):null;
  }
  save(room){
    room.expiresAt=Date.now()+ROOM_LIFETIME;
    this.ctx.storage.sql.exec('INSERT INTO room(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',JSON.stringify(room));
    // Alarms are scheduled separately; expiry is also enforced on every request/message.
    let next=room.expiresAt;
    for(const ws of this.ctx.getWebSockets()){const info=ws.deserializeAttachment();if(info.seat===undefined)next=Math.min(next,info.created+15000)}
    this.ctx.waitUntil(this.ctx.storage.setAlarm(next));
  }
  alive(){const room=this.read();return room&&room.expiresAt>Date.now()?room:null}
  authenticated(){return this.ctx.getWebSockets().filter(ws=>ws.deserializeAttachment()?.seat!==undefined)}
  snapshot(ws,room,extra={}){
    const seat=ws.deserializeAttachment()?.seat;if(seat===undefined)return;
    const online=this.authenticated().map(s=>s.deserializeAttachment().seat);
    ws.send(JSON.stringify({type:'state',...viewRoom(room,seat,online),...extra}));
  }
  broadcast(room){for(const ws of this.authenticated()){try{this.snapshot(ws,room)}catch{ws.close(1011,'Reconnect')}}}
  async fetch(request){
    const path=new URL(request.url).pathname;
    try{
      if(path==='/create'&&request.method==='POST'){
        const input=await body(request),token=newToken(),tokenHash=await hash(token);
        if(this.read())return json({error:'Room already exists.'},409);
        const room=createRoom(input.name,tokenHash);room.id=input.id;
        this.ctx.storage.transactionSync(()=>this.save(room));
        return json({room:room.id,token},201);
      }
      if(path==='/join'&&request.method==='POST'){
        const input=await body(request),token=newToken(),tokenHash=await hash(token);
        const room=this.alive();if(!room)return json({error:'Room not found or expired.'},404);
        joinRoom(room,input.name,tokenHash);
        this.ctx.storage.transactionSync(()=>this.save(room));this.broadcast(room);
        return json({room:room.id,token},201);
      }
      if(path==='/connect'&&request.method==='GET'&&request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return this.alive()?json({active:true}):json({error:'Room not found or expired.'},404);
      if(path==='/connect'&&request.headers.get('Upgrade')?.toLowerCase()==='websocket'){
        const room=this.alive();if(!room)return json({error:'Room not found or expired.'},404);
        if(this.ctx.getWebSockets().length>=12)return json({error:'Too many room connections.'},429);
        const [client,server]=Object.values(new WebSocketPair());
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({created:Date.now(),window:Date.now(),count:0});
        // Remove unauthenticated connections even if they never send a message.
        await this.ctx.storage.setAlarm(Math.min(room.expiresAt,Date.now()+15000));
        return new Response(null,{status:101,webSocket:client});
      }
      return json({error:'Not found.'},404);
    }catch(error){return json({error:error.message||'Request failed.'},400)}
  }
  async webSocketMessage(ws,message){
    let command;
    try{
      if(typeof message!=='string'||message.length>4096)throw new Error('Invalid message.');
      const info=ws.deserializeAttachment();
      if(Date.now()-info.window>10000){info.window=Date.now();info.count=0}
      if(++info.count>60){ws.close(1008,'Too many messages');return}
      ws.serializeAttachment(info);
      command=JSON.parse(message);
      let room=this.alive();if(!room){ws.close(4004,'Room expired');return}
      if(info.seat===undefined){
        if(command.type!=='auth'||typeof command.token!=='string'||command.token.length!==72||Date.now()-info.created>15000){ws.close(4003,'Invalid seat token');return}
        const tokenHash=await hash(command.token);
        // Re-read after the asynchronous digest to avoid a stale lobby snapshot.
        room=this.alive();if(!room){ws.close(4004,'Room expired');return}
        const seat=room.seats.findIndex(s=>s?.tokenHash===tokenHash);
        if(seat<0){ws.close(4003,'Invalid seat token');return}
        for(const old of this.authenticated())if(old!==ws&&old.deserializeAttachment().seat===seat){
          old.serializeAttachment({...old.deserializeAttachment(),seat:undefined});old.close(4001,'Seat opened in another tab');
        }
        ws.serializeAttachment({...info,seat});this.broadcast(room);return;
      }
      const next=applyCommand(room,info.seat,command);
      if(next!==room)this.ctx.storage.transactionSync(()=>this.save(next));
      this.broadcast(next);
      ws.send(JSON.stringify({type:'ack',id:command.id}));
    }catch(error){
      ws.send(JSON.stringify({type:'error',id:command?.id,message:error.message||'Move rejected.'}));
      const room=this.alive();if(room)this.snapshot(ws,room);
    }
  }
  webSocketClose(ws,code,reason){
    ws.serializeAttachment({...ws.deserializeAttachment(),seat:undefined});
    ws.close([1005,1006,1015].includes(code)?1000:code,reason);const room=this.alive();if(room)this.broadcast(room);
  }
  webSocketError(ws){ws.close(1011,'Reconnect')}
  async alarm(){
    const room=this.read();
    if(!room||room.expiresAt<=Date.now()){
      for(const ws of this.ctx.getWebSockets())ws.close(4004,'Room expired');
      this.ctx.storage.sql.exec('DELETE FROM room');
      await this.ctx.storage.deleteAlarm();return;
    }
    let next=room.expiresAt;
    for(const ws of this.ctx.getWebSockets()){
      const info=ws.deserializeAttachment();
      if(info.seat===undefined){
        if(Date.now()-info.created>=15000)ws.close(4003,'Authentication timed out');
        else next=Math.min(next,info.created+15000);
      }
    }
    await this.ctx.storage.setAlarm(next);
  }
}
