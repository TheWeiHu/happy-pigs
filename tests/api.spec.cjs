const {test,expect}=require('@playwright/test');
async function channel(base,room,token){
  const ws=new WebSocket(`${base.replace('http','ws')}/api/rooms/${room}/connect`),messages=[];
  ws.addEventListener('message',e=>messages.push(JSON.parse(e.data)));
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})});
  ws.send(JSON.stringify({type:'auth',token}));
  await expect.poll(()=>messages.some(x=>x.type==='state')).toBe(true);
  const latest=()=>messages.filter(x=>x.type==='state').at(-1);
  const send=async(type,args={})=>{
    const v=latest(),c={type,id:crypto.randomUUID(),version:v.version,turnId:v.turnId,...args};
    ws.send(JSON.stringify(c));await expect.poll(()=>messages.some(x=>(x.type==='ack'||x.type==='error')&&x.id===c.id)).toBe(true);return c;
  };
  return {ws,messages,latest,send};
}
test('real Worker rejects forged origins and credentials, hides secrets, and deduplicates moves',async({request,baseURL})=>{
  const denied=await request.post('/api/rooms',{headers:{Origin:'https://untrusted.example'},data:{name:'Attacker'}});
  expect(denied.status()).toBe(403);
  const created=await request.post('/api/rooms',{data:{name:'Host'}});expect(created.status()).toBe(201);
  const hostData=await created.json();
  const joined=await request.post(`/api/rooms/${hostData.room}/join`,{data:{name:'Guest'}});expect(joined.status()).toBe(201);
  const guestData=await joined.json();
  const host=await channel(baseURL,hostData.room,hostData.token),guest=await channel(baseURL,hostData.room,guestData.token);
  try{
    await guest.send('start');expect(guest.messages.at(-2).message).toMatch(/host/);
    await host.send('ready',{ready:true});await guest.send('ready',{ready:true});await host.send('start');
    const buy=await host.send('buy',{item:'small'});expect(host.latest().players[0].coins).toBe(39);
    const before=host.messages.length;host.ws.send(JSON.stringify(buy));
    await expect.poll(()=>host.messages.slice(before).some(x=>x.type==='ack'&&x.id===buy.id)).toBe(true);
    expect(host.latest().players[0].coins).toBe(39);
    await guest.send('buy',{item:'small'});expect(guest.messages.some(x=>x.type==='error'&&/turn/.test(x.message))).toBe(true);
    await host.send('done');await guest.send('done');await host.send('choose',{action:'feed'});
    await expect.poll(()=>guest.latest().locked[0]).toBe(true);
    expect(guest.latest().choices).toBe(null);expect(guest.latest().myChoice).toBe(null);
    const wire=JSON.stringify(guest.latest());expect(wire).not.toContain(hostData.token);expect(wire).not.toContain('tokenHash');expect(wire).not.toContain('deck');
    await guest.send('choose',{action:'buy'});expect(guest.latest().choices).toEqual(['feed','buy']);
    const forged=new WebSocket(`${baseURL.replace('http','ws')}/api/rooms/${hostData.room}/connect`);
    const result=await new Promise((resolve,reject)=>{
      forged.addEventListener('open',()=>forged.send(JSON.stringify({type:'auth',token:'x'.repeat(72)})));
      forged.addEventListener('close',e=>resolve(e.code));forged.addEventListener('error',reject);
    });expect(result).toBe(4003);
    const missing=await request.get('/api/rooms/00000000000000000000000000000000/connect');expect(missing.status()).toBe(404);
  }finally{host.ws.close();guest.ws.close()}
});
