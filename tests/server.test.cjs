const {test}=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {WebSocket}=require('ws');
const {createServer}=require('../server/node.cjs');
async function withServer(fn,options={}){
  const dataDir=mkdtempSync(path.join(tmpdir(),'happy-pigs-http-'));
  const app=createServer({dataDir,...options});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  try{await fn(`http://127.0.0.1:${app.server.address().port}`)}finally{await app.close();rmSync(dataDir,{recursive:true,force:true})}
}
const post=(base,url,data)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
test('HTTP payload limits, asset allowlist, proxy origin and concurrent joins',()=>withServer(async base=>{
  assert.equal((await fetch(base+'/.git/config')).status,404);
  assert.equal((await fetch(base+'/game-core.js',{method:'HEAD'})).status,200);
  assert.equal((await fetch(base+'/health')).status,200);
  assert.equal((await fetch(base+'/api/rooms',{method:'POST',headers:{Origin:'https://evil.example'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/rooms',{method:'POST',body:'x'.repeat(5000)})).status,413);
  const created=await (await post(base,'/api/rooms',{name:'Host'})).json();
  const results=await Promise.all(['A','B'].map(name=>post(base,`/api/rooms/${created.room}/join`,{name})));
  assert.deepEqual(results.map(r=>r.status).sort(),[201,400]);
},{publicOrigin:'https://game.example',trustProxy:true}));
test('UTF-8 nicknames survive HTTP chunk boundaries',()=>withServer(async base=>{
  const bytes=Buffer.from(JSON.stringify({name:'🐷'}));
  const result=await new Promise((resolve,reject)=>{
    const req=http.request(base+'/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});
    req.on('error',reject);req.write(bytes.subarray(0,11));setImmediate(()=>req.end(bytes.subarray(11)));
  });assert.equal(result,201);
}));
test('WebSockets reject untrusted origins and stop serving expired rooms',async()=>{
  let now=Date.now();
  await withServer(async base=>{
    const {room,token}=await (await post(base,'/api/rooms',{name:'Host'})).json();
    const url=base.replace('http','ws')+`/api/rooms/${room}/connect`;
    const denied=new WebSocket(url,{headers:{Origin:'https://evil.example'}});
    const rejected=await new Promise(resolve=>{denied.on('unexpected-response',(_,res)=>{res.resume();denied.terminate();resolve(res.statusCode)});denied.on('error',()=>{})});
    assert.equal(rejected,403);
    const ws=new WebSocket(url);await once(ws,'open');const snapshot=once(ws,'message');ws.send(JSON.stringify({type:'auth',token}));await snapshot;
    now+=8*24*60*60*1000;
    assert.equal((await fetch(base+`/api/rooms/${room}/connect`)).status,404);
    const closed=once(ws,'close');ws.send(JSON.stringify({type:'ready'}));assert.equal((await closed)[0],4004);
  },{clock:()=>now});
});
test('canonical and legacy origins can recover the same room without allowing other origins',()=>withServer(async base=>{
  const created=await fetch(base+'/api/rooms',{method:'POST',headers:{Origin:'https://game.example'},body:JSON.stringify({name:'Host'})});
  assert.equal(created.status,201);const {room,token}=await created.json();
  for(const origin of ['https://game.example','https://legacy.example']){
    assert.equal((await fetch(base+`/api/rooms/${room}/connect`,{headers:{Origin:origin}})).status,200);
    const ws=new WebSocket(base.replace('http','ws')+`/api/rooms/${room}/connect`,{headers:{Origin:origin}});
    await once(ws,'open');const snapshot=once(ws,'message');ws.send(JSON.stringify({type:'auth',token}));
    assert.equal(JSON.parse((await snapshot)[0]).me,0);const closed=once(ws,'close');ws.close();await closed;
  }
  for(const origin of ['https://game.example.evil.test','https://legacy.example.evil.test','null']){
    assert.equal((await fetch(base+`/api/rooms/${room}/connect`,{headers:{Origin:origin}})).status,403);
  }
},{publicOrigin:'https://game.example, https://legacy.example'}));
