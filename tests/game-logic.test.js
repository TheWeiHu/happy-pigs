const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const raw=html.match(/<script>([\s\S]*)<\/script>/)[1];
new vm.Script(raw);

const script=raw
  .replace(/^initChrome\(\);$/m,'')
  .replace(/if\(location\.hash\.indexOf\('demo'\)>=0\) autoDemo\(\); else setup\(\);/,'');
const noop=()=>{};
const document={
  addEventListener:noop,removeEventListener:noop,querySelector:()=>null,
  getElementById:()=>({innerHTML:'',prepend:noop,appendChild:noop}),
  createElement:()=>({classList:{add:noop},style:{},appendChild:noop,querySelector:()=>null}),
};
const sandbox={
  assert,console,document,window:{__speed:100000},location:{hash:''},
  getComputedStyle:()=>({getPropertyValue:()=>''}),setTimeout:fn=>fn(),
};
vm.createContext(sandbox);

const tests=`
(async()=>{
  const quiet=()=>{};
  render=quiet; pigEl=()=>null; markBorn=quiet; logP=quiet; log=quiet; floatCoin=quiet;

  players=[mkPlayer('Budget',true)];
  const budget=players[0];
  budget.coins=1;
  assert.equal(doBuy(0,'vaccine'),true);
  assert.equal(doBuy(0,'vaccine'),false);
  assert.equal(budget.coins,0);
  assert.equal(budget.items.vaccine,1);
  budget.coins=2;
  assert.equal(doBuy(0,'piglet'),false);
  assert.equal(budget.coins,2);
  assert.equal(budget.pigs.length,0);
  budget.coins=9;
  assert.equal(doBuy(0,'field'),false);
  assert.equal(budget.coins,9);
  assert.equal(budget.fields.length,1);

  players=[mkPlayer('Human',true)]; nP=1; state.roundSerial=1;
  const human=players[0];
  acquirePig(human,'average'); acquirePig(human,'average');
  const picks=[];
  pickOwnPig=(i,filter,txt,onPick,onDone)=>picks.push({filter,txt,onPick,onDone});
  const humanDone=humanMate(0,2);
  picks[0].onPick(human.pigs[0]);
  picks[1].onPick(human.pigs[1]);
  await humanDone;
  assert.equal(human.pigs.filter(x=>x.size==='piglet').length,1);
  assert.equal(human.pigs.filter(x=>x.size==='average'&&x.matedRound===1).length,2);
  assert.equal(human.coins,46);
  assert.match(picks[1].txt,/second parent/);

  players=[mkPlayer('Bot',false)]; state.roundSerial=2;
  const bot=players[0];
  acquirePig(bot,'average'); acquirePig(bot,'average');
  await aiExecute(0,'mate',2);
  assert.equal(bot.pigs.filter(x=>x.size==='piglet').length,1);
  assert.equal(bot.pigs.filter(x=>x.size==='average'&&x.matedRound===2).length,2);
  assert.equal(bot.coins,46);

  const oldRandom=Math.random;
  assert.equal(variedBest([],x=>x.s),null);
  Math.random=()=>.99;
  assert.equal(variedBest([{v:'best',s:3},{v:'near',s:2}],x=>x.s,1,.25).v,'best');
  Math.random=()=>0;
  assert.equal(variedBest([{v:'best',s:3},{v:'near',s:2},{v:'bad',s:1}],x=>x.s,1,.25).v,'near');
  assert.equal(variedBest([{v:'best',s:3},{v:'bad',s:1}],x=>x.s,1,.25).v,'best');

  players=[mkPlayer('Decider',false)]; state.roundSerial=3; state.round=1; state.season=0;
  acquirePig(players[0],'average'); acquirePig(players[0],'average');
  Math.random=()=>.99;
  assert.equal(aiPick(0),'feed');
  Math.random=()=>0;
  assert.equal(aiPick(0),'mate');
  state.round=3;
  assert.equal(aiPick(0),'buy');

  players=[mkPlayer('Feeder',false)]; state.roundSerial=4;
  const average=acquirePig(players[0],'average');
  const small=acquirePig(players[0],'small');
  Math.random=()=>0;
  await aiExecute(0,'feed',1);
  assert.equal(average.size,'average');
  assert.equal(small.size,'average');

  players=[mkPlayer('Seller',false)]; state.roundSerial=5; state.season=0;
  acquirePig(players[0],'average'); acquirePig(players[0],'small');
  await aiExecute(0,'sell',1);
  assert.deepEqual(players[0].pigs.map(x=>x.size),['average']);
  assert.equal(players[0].coins,51);

  players=[mkPlayer('No pair',true)]; state.roundSerial=6;
  acquirePig(players[0],'average');
  await humanMate(0,2);
  assert.equal(players[0].pigs.length,1);
  assert.equal(players[0].coins,47);
  Math.random=oldRandom;
})()`;

vm.runInContext(script+tests,sandbox).then(()=>console.log('PASS game logic'));
