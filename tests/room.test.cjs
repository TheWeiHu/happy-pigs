const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRoom,joinRoom,applyCommand,viewRoom,engine}=require('../server/game.cjs');
let serial=0;
const command=(r,i,type,args={})=>({id:`command-${++serial}`,version:r.seats[i].version,turnId:r.turnId,type,...args});
const apply=(r,i,type,args={})=>applyCommand(r,i,command(r,i,type,args),()=>0.2);
function lobby(bots=false){
  let r=createRoom('Host','host-secret');
  if(bots)r=apply(r,0,'configure',{count:3,bots:[1,2]});
  else joinRoom(r,'Guest','guest-secret');
  for(let i=0;i<r.seats.length;i++)if(r.seats[i].human)r=apply(r,i,'ready',{ready:true});
  return r;
}
function opening(bots=false){return apply(lobby(bots),0,'start')}
function choosing(){let r=opening();r=apply(r,0,'done');r=apply(r,1,'done');return r}
function action(type){let r=choosing();r=apply(r,0,'choose',{action:type});return apply(r,1,'choose',{action:'buy'})}
function give(r,i,size){const e=engine(r);const pg=e.rules.acquirePig(r.players[i],size);r.uid=e.rules.getUid();return pg}

test('host controls, occupied seats and readiness are enforced',()=>{
  let r=lobby();
  assert.throws(()=>apply(r,1,'start'),/host/);
  assert.throws(()=>apply(r,0,'configure',{count:2,bots:[1]}),/occupied/);
  r=apply(r,0,'ready',{ready:false});assert.throws(()=>apply(r,0,'start'),/ready/);
  assert.throws(()=>joinRoom(r,'Third','secret'),/full/);
  assert.throws(()=>createRoom('','secret'),/nickname/);
});
test('private snapshots exclude deck, credentials and other secret choices',()=>{
  let r=choosing();r=apply(r,0,'choose',{action:'mate'});
  const v=viewRoom(r,1);assert.equal(v.choices,null);assert.equal(v.myChoice,null);assert.deepEqual(v.locked,[true,false]);
  assert.ok(!JSON.stringify(v).includes('secret'));assert.ok(!('deck' in v));assert.ok(!('seen' in v.seats[0]));
  assert.equal(viewRoom(r,0).myChoice,'mate');
  r=apply(r,1,'choose',{action:'mate'});assert.deepEqual(viewRoom(r,1).choices,['mate','mate']);
  assert.equal(r.allot.reduce((a,b)=>a+b),r.state.card.qty.mate);
});
test('duplicate and stale commands cannot spend twice or skip turns',()=>{
  let r=opening();const c=command(r,0,'buy',{item:'small'});r=applyCommand(r,0,c);
  const snapshot=structuredClone(r);assert.equal(applyCommand(r,0,c),r);assert.deepEqual(r,snapshot);
  assert.throws(()=>applyCommand(r,0,{...c,id:'new-message'}),/changed/);
  assert.throws(()=>apply(r,1,'buy',{item:'small'}),/turn/);
  r=apply(r,0,'done');assert.throws(()=>applyCommand(r,0,{...command(snapshot,0,'done'),version:r.seats[0].version}),/turn changed/);
});
test('rejected commands are atomic, including partially invalid board moves',()=>{
  const r=opening();r.players[0].fields=[{bx:0,by:0},{bx:16,by:0},{bx:32,by:0}];
  const snapshot=structuredClone(r);
  assert.throws(()=>apply(r,0,'moveBoard',{field:1,bx:0,by:8}),/connected/);
  assert.deepEqual(r,snapshot);
  for(const args of [{item:'__proto__'},{item:'constructor'},{item:'toString'}])assert.throws(()=>apply(r,0,'buy',args),/Unknown/);
  assert.throws(()=>apply(r,0,'moveBoard',{field:1,bx:1e8,by:0}),/Invalid/);
});
test('server enforces budget, ownership, geometry and legal purchases',()=>{
  let r=opening();r.players[0].coins=1;const other=give(r,1,'small');
  assert.throws(()=>apply(r,0,'buy',{item:'big'}),/coins/);
  assert.throws(()=>apply(r,0,'movePig',{pig:other.id,x:0,y:0}),/your pigs/);
  r=apply(r,0,'buy',{item:'vaccine'});assert.equal(r.players[0].coins,0);assert.equal(r.left,4);
  assert.throws(()=>apply(r,0,'buy',{item:'vaccine'}),/coins/);
  const pg=give(r,0,'piglet');
  assert.throws(()=>apply(r,0,'movePig',{pig:pg.id,x:0.5,y:0}),/fit/);
  r=apply(r,0,'movePig',{pig:pg.id,x:4,y:2});assert.equal(r.players[0].pigs[0].x,4);
});
test('feeding, supplements, mating pairs and amulets use the shared rules',()=>{
  let r=action('feed');const pg=give(r,0,'piglet');r.players[0].items.supplement=1;
  r=apply(r,0,'feed',{pig:pg.id,supplement:true});assert.equal(r.players[0].pigs[0].size,'average');
  assert.equal(r.players[0].items.supplement,0);
  assert.throws(()=>apply(r,0,'feed',{pig:pg.id}),/cannot be fed/);
  r=action('mate');const a=give(r,0,'average'),b=give(r,0,'big');r.players[0].items.amulet=1;
  assert.throws(()=>apply(r,0,'mate',{pigs:[a.id,a.id]}),/different/);
  r=apply(r,0,'mate',{pigs:[a.id,b.id],amulet:true});assert.equal(r.players[0].pigs.at(-1).size,'small');
  assert.equal(r.players[0].items.amulet,0);
  assert.throws(()=>apply(r,0,'mate',{pigs:[a.id,b.id]}),/cannot mate/);
});
test('sell compensation is paid once and never in opening purchases',()=>{
  let r=opening();r=apply(r,0,'done');assert.equal(r.players[0].coins,45);
  r=action('sell');const pg=give(r,0,'big'),left=r.left;
  r=apply(r,0,'sell',{pig:pg.id});assert.equal(r.players[0].coins,60);
  const c=command(r,0,'done');r=applyCommand(r,0,c);assert.equal(r.players[0].coins,60+left-1);
  assert.equal(applyCommand(r,0,c),r);
});
test('vaccination and season death survive serialization and final scoring resolves ties',()=>{
  let r=opening();r.phase='vaccinate';r.state.season=3;r.state.round=4;r.left=0;
  const a=give(r,0,'big');give(r,0,'piglet');give(r,1,'small');r.players[0].items.vaccine=1;
  r=apply(r,0,'vaccinate',{pig:a.id});
  // With no remaining vaccines, settle advances and scores the final game.
  assert.equal(r.phase,'finished');assert.equal(r.players[0].pigs.length,1);assert.equal(r.players[1].pigs.length,0);
  assert.equal(r.players[0].coins,60);assert.deepEqual(r.results.winners,[0]);
  let tie=opening();tie.phase='vaccinate';tie.state.season=3;tie.state.round=4;
  tie.players[0].items.amulet=1;tie=apply(tie,0,'done');assert.deepEqual(tie.results.winners,[0]);
});
test('full 16-round mixed human/AI games complete after restoring every move',()=>{
  for(let seed=0;seed<8;seed++){
    let r=opening(true),steps=0;
    while(r.phase!=='finished'&&steps++<300){
      r=JSON.parse(JSON.stringify(r));
      if(r.phase==='choose')r=apply(r,0,'choose',{action:['buy','feed','mate','sell'][(r.state.roundSerial+seed)%4]});
      else {
        assert.equal(r.actor,0);
        const e=engine(r),p=r.players[0];
        if(r.phase==='opening')r=apply(r,0,'buy',{item:['small','average','vaccine','supplement','amulet'][5-r.left]});
        else if(r.phase==='vaccinate'){
          const pg=p.pigs.find(x=>!x.vacc);r=pg&&p.items.vaccine?apply(r,0,'vaccinate',{pig:pg.id}):apply(r,0,'done');
        }else if(r.choices[0]==='feed'&&p.pigs.some(pg=>pg.fedRound!==r.state.roundSerial&&e.rules.canGrow(p,pg))){
          const pg=p.pigs.find(pg=>pg.fedRound!==r.state.roundSerial&&e.rules.canGrow(p,pg));r=apply(r,0,'feed',{pig:pg.id});
        }else if(r.choices[0]==='sell'&&p.pigs.length)r=apply(r,0,'sell',{pig:p.pigs[0].id});
        else r=apply(r,0,'done');
      }
      for(const p of r.players){assert.ok(p.coins>=0);assert.ok(Object.values(p.items).every(n=>n>=0))}
      const ids=r.players.flatMap(p=>p.pigs.map(pg=>pg.id));assert.equal(new Set(ids).size,ids.length);
    }
    assert.equal(r.phase,'finished');assert.equal(r.state.roundSerial,16);assert.equal(r.results.scores.length,3);
  }
});

test('buying a field stays connected after farmers rearrange their boards',()=>{
  let r=opening();r.players[0].coins=100;
  r.players[0].fields=[{bx:0,by:0},{bx:0,by:8},{bx:16,by:8}];
  r=apply(r,0,'buy',{item:'field'});
  assert.deepEqual(r.players[0].fields.at(-1),{bx:32,by:8});
});
