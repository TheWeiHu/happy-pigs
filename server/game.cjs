const {createRules}=require('../game-core.js');
const ACTIONS=['feed','mate','buy','sell'];
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const requireThat=(ok,message)=>{if(!ok)throw new Error(message)};
const nickname=value=>{
  requireThat(typeof value==='string','Enter a nickname.');
  const name=value.trim();
  requireThat(name.length>0&&name.length<=14&&!/[\x00-\x1f\x7f]/.test(name),'Use a nickname of 1–14 characters.');
  return name;
};
function createRoom(name,tokenHash){
  return {schema:1,seats:[{name:nickname(name),human:true,tokenHash,ready:false,version:0,seen:[]},null],
    phase:'lobby',turnId:0,players:[],state:{season:0,round:1,startIdx:0,card:null,roundSerial:0},
    deck:[],uid:0,choices:[],allot:[],actor:0,left:0,step:0,logs:[],results:null};
}
function joinRoom(room,name,tokenHash){
  requireThat(room.phase==='lobby','This game has already started.');
  const i=room.seats.indexOf(null);
  requireThat(i!==-1,'This room is full.');
  name=nickname(name);
  requireThat(!room.seats.some(s=>s&&s.name.toLowerCase()===name.toLowerCase()),'That nickname is taken.');
  room.seats[i]={name,human:true,tokenHash,ready:false,version:0,seen:[]};
  return i;
}
function engine(room,random=Math.random){
  const note=text=>{room.logs.push(text);room.logs=room.logs.slice(-60)};
  const rules=createRules({getPlayers:()=>room.players,getState:()=>room.state,uid:room.uid,random,
    hooks:{log:(_,s)=>note(s),logP:(_,s)=>note(s)}});
  const {VAL,NEXT,FW,FH}=rules;
  function phase(value){room.phase=value;room.turnId++}
  function beginRound(){
    room.state.roundSerial++;
    room.players.forEach(p=>p.soldThisRound=0);
    room.state.card=room.deck[room.state.season*4+room.state.round-1];
    room.choices=room.players.map((p,i)=>p.human?null:rules.aiPick(i));
    room.allot=[];phase('choose');
  }
  function finishGame(){
    room.state.round=4;
    room.players.forEach(p=>{p.coins+=p.pigs.filter(pg=>pg.vacc).reduce((n,pg)=>n+VAL[pg.size],0)});
    const scores=room.players.map((p,i)=>({seat:i,name:p.name,coins:p.coins,
      tiebreak:p.coins+Object.values(p.items).reduce((a,b)=>a+b,0)+p.fields.reduce((sum,_,j)=>sum+rules.fieldPrice(j+1),0)}));
    scores.sort((a,b)=>b.coins-a.coins||b.tiebreak-a.tiebreak);
    const top=scores[0];
    room.results={scores,winners:scores.filter(s=>s.coins===top.coins&&s.tiebreak===top.tiebreak).map(s=>s.seat)};
    note('Game Over.');phase('finished');
  }
  function finishSeason(){
    room.players.forEach(p=>{
      const lost=p.pigs.filter(pg=>!pg.vacc).length;
      p.pigs=p.pigs.filter(pg=>pg.vacc);
      note(`${escapeText(p.name)} lost ${lost} unvaccinated pig(s).`);
    });
    if(room.state.season===3){finishGame();return}
    room.state.season++;room.state.round=1;
    room.state.startIdx=(room.state.startIdx+1)%room.players.length;
    beginRound();
  }
  function nextTurn(){
    room.step++;
    if(room.step<room.players.length){
      room.actor=(room.state.startIdx+room.step)%room.players.length;
      room.left=room.phase==='opening'?5:room.phase==='action'?room.allot[room.actor]:0;
      room.turnId++;return;
    }
    if(room.phase==='opening'){beginRound();return}
    if(room.phase==='vaccinate'){finishSeason();return}
    const effect=rules.EFFECTS[room.state.card.effect];
    note(effect.txt);room.players.forEach((p,i)=>effect.run(p,i));
    if(room.state.round===4){
      room.step=0;room.actor=room.state.startIdx;room.left=0;phase('vaccinate');
    }else{
      room.state.round++;room.state.startIdx=(room.state.startIdx+1)%room.players.length;beginRound();
    }
  }
  function spend(){room.left--;if(room.left===0)nextTurn()}
  function pig(p,id){
    const pg=p.pigs.find(x=>x.id===id);requireThat(pg,'Choose one of your pigs.');return pg;
  }
  function execute(i,c){
    const p=room.players[i];
    if(c.type==='movePig'||c.type==='moveBoard'){
      requireThat(!['lobby','finished'].includes(room.phase),'The game is not in progress.');
      const integer=n=>Number.isSafeInteger(n)&&Math.abs(n)<=512;
      if(c.type==='movePig'){
        const pg=pig(p,c.pig);
        requireThat(integer(c.x)&&integer(c.y)&&rules.canPlaceAt(p,c.x,c.y,pg.size,pg.id),'That pig does not fit there.');
        pg.x=c.x;pg.y=c.y;
      }else{
        requireThat(Number.isInteger(c.field)&&p.fields[c.field]&&integer(c.bx)&&integer(c.by),'Invalid field position.');
        const {bx,by}=c;
        const others=p.fields.filter((_,j)=>j!==c.field);
        requireThat(others.length&&!others.some(b=>bx<b.bx+FW&&bx+FW>b.bx&&by<b.by+FH&&by+FH>b.by),'Fields cannot overlap.');
        requireThat(others.some(b=>(by<b.by+FH&&by+FH>b.by&&(bx===b.bx+FW||bx+FW===b.bx))||
          (bx<b.bx+FW&&bx+FW>b.bx&&(by===b.by+FH||by+FH===b.by))),'Fields must touch along an edge.');
        p.fields[c.field]={bx,by};
        // Check the entire farm, including boards left behind by this move.
        const visited=new Set([0]);let changed=true;
        while(changed){changed=false;p.fields.forEach((a,j)=>{
          if(visited.has(j))return;
          if([...visited].some(k=>{const b=p.fields[k];return (a.by<b.by+FH&&a.by+FH>b.by&&(a.bx===b.bx+FW||a.bx+FW===b.bx))||
            (a.bx<b.bx+FW&&a.bx+FW>b.bx&&(a.by===b.by+FH||a.by+FH===b.by))})){visited.add(j);changed=true}
        })}
        requireThat(visited.size===p.fields.length,'All fields must stay connected.');
        rules.normalize(p);
        if(p.pigs.some(pg=>!rules.canPlaceAt(p,pg.x,pg.y,pg.size,pg.id))){
          const packed=rules.packAll(p);requireThat(packed,'Moving this field leaves pigs without room.');rules.applyPack(p,packed);
        }
      }
      return;
    }
    if(room.phase==='choose'){
      requireThat(c.type==='choose'&&ACTIONS.includes(c.action),'Choose Feed, Mate, Buy, or Sell.');
      requireThat(room.choices[i]===null,'Your choice is already locked.');
      room.choices[i]=c.action;return;
    }
    requireThat(room.actor===i,'Wait for your turn.');
    if(room.phase==='vaccinate'){
      requireThat(c.type==='vaccinate'||c.type==='done','Choose a pig to vaccinate, or continue.');
      if(c.type==='done'){nextTurn();return}
      const pg=pig(p,c.pig);requireThat(!pg.vacc&&p.items.vaccine>0,'No vaccine available for this pig.');
      pg.vacc=true;p.items.vaccine--;return;
    }
    requireThat(room.phase==='opening'||room.phase==='action','The game is not accepting moves.');
    if(c.type==='done'){
      if(room.phase==='action')p.coins+=room.left;
      nextTurn();return;
    }
    requireThat(room.left>0,'No actions remaining.');
    const action=room.phase==='opening'?'buy':room.choices[i];
    requireThat(c.type===action,'That action is not available this turn.');
    if(action==='buy'){
      requireThat(typeof c.item==='string'&&(own(VAL,c.item)||own(rules.ITEM_PRICE,c.item)||c.item==='field'),'Unknown purchase.');
      // Bounds protect allocation sizes; this exceeds ordinary full-game purchases.
      requireThat(c.item!=='field'||p.fields.length<16,'Maximum of 16 fields reached.');
      requireThat(rules.doBuy(i,c.item),'You need enough coins and room for that purchase.');
    }else if(action==='feed'){
      const pg=pig(p,c.pig);
      requireThat(pg.fedRound!==room.state.roundSerial&&rules.canGrow(p,pg),'That pig cannot be fed.');
      requireThat(c.supplement===undefined||typeof c.supplement==='boolean','Invalid supplement choice.');
      if(c.supplement)requireThat(p.items.supplement>0&&['piglet','small'].includes(pg.size),'No usable supplement.');
      if(c.supplement)p.items.supplement--;
      rules.growPig(p,pg);if(c.supplement)rules.growPig(p,pg);pg.fedRound=room.state.roundSerial;
      note(`${escapeText(p.name)} fed a pig → ${pg.size}.`);
    }else if(action==='mate'){
      requireThat(Array.isArray(c.pigs)&&c.pigs.length===2&&c.pigs[0]!==c.pigs[1],'Choose two different parents.');
      const parents=c.pigs.map(id=>pig(p,id));
      requireThat(parents.every(pg=>['average','big'].includes(pg.size)&&pg.matedRound!==room.state.roundSerial),'These pigs cannot mate this round.');
      requireThat(c.amulet===undefined||typeof c.amulet==='boolean','Invalid amulet choice.');
      if(c.amulet)requireThat(p.items.amulet>0&&rules.canFitNew(p,'small'),'No usable amulet or room for a small pig.');
      if(c.amulet)p.items.amulet--;
      parents.forEach(pg=>pg.matedRound=room.state.roundSerial);
      const baby=rules.acquirePig(p,c.amulet?'small':'piglet');
      note(baby?`${escapeText(p.name)} gained a ${baby.size}.`:'No room — the newborn returned to the reserve.');
    }else if(action==='sell'){
      const pg=pig(p,c.pig);p.coins+=VAL[pg.size];p.soldThisRound++;p.pigs=p.pigs.filter(x=>x.id!==pg.id);
      note(`${escapeText(p.name)} sold a ${pg.size} for $${VAL[pg.size]}.`);
    }
    spend();
  }
  function botMove(i){
    const p=room.players[i];
    if(room.phase==='vaccinate'){
      const pg=p.pigs.filter(x=>!x.vacc).sort((a,b)=>VAL[b.size]-VAL[a.size])[0];
      return pg&&p.items.vaccine?{type:'vaccinate',pig:pg.id}:{type:'done'};
    }
    const action=room.phase==='opening'?'buy':room.choices[i];
    if(room.phase==='opening'){
      const item=['small','small','average','vaccine','supplement'][5-room.left];
      return {type:'buy',item};
    }
    if(action==='buy'){
      const need=p.pigs.filter(pg=>!pg.vacc&&VAL[pg.size]>=6).length;
      let item;
      if(need>p.items.vaccine&&p.coins>=1)item='vaccine';
      else if(p.coins>=6&&rules.canFitNew(p,'small')&&room.state.season<3)item='small';
      else if(p.coins>=3&&rules.canFitNew(p,'piglet')&&room.state.season<2)item='piglet';
      else if(!rules.canFitNew(p,'piglet')&&p.fields.length<16&&p.coins>=rules.fieldPrice(p.fields.length+1))item='field';
      else if(p.items.supplement<1&&p.coins>=1&&room.state.season<3)item='supplement';
      return item?{type:'buy',item}:{type:'done'};
    }
    if(action==='feed'){
      const pg=rules.variedBest(p.pigs.filter(x=>x.fedRound!==room.state.roundSerial&&rules.canGrow(p,x)),x=>VAL[NEXT[x.size]]-VAL[x.size],1);
      return pg?{type:'feed',pig:pg.id,supplement:p.items.supplement>0&&['piglet','small'].includes(pg.size)}:{type:'done'};
    }
    if(action==='mate'){
      const parents=p.pigs.filter(x=>['average','big'].includes(x.size)&&x.matedRound!==room.state.roundSerial).slice(0,2);
      return parents.length===2?{type:'mate',pigs:parents.map(x=>x.id),amulet:p.items.amulet>0&&rules.canFitNew(p,'small')}:{type:'done'};
    }
    const pg=rules.variedBest(p.pigs,x=>VAL[x.size],4);
    return pg&&p.soldThisRound<(room.state.season===3?2:1)&&!(VAL[pg.size]<6&&p.coins>10)?{type:'sell',pig:pg.id}:{type:'done'};
  }
  function settle(){
    for(let guard=0;guard<1000;guard++){
      if(['lobby','finished'].includes(room.phase))break;
      if(room.phase==='choose'){
        if(room.choices.some(x=>x===null))break;
        room.allot=rules.distribute(room.state.card,room.choices);room.step=0;room.actor=room.state.startIdx;
        room.left=room.allot[room.actor];phase('action');
        note(room.players.map((p,i)=>`${escapeText(p.name)}: ${room.choices[i]} ×${room.allot[i]}`).join(' · '));
        continue;
      }
      const p=room.players[room.actor];
      if(room.phase==='action'&&room.left===0){nextTurn();continue}
      if(room.phase==='vaccinate'&&(!p.items.vaccine||p.pigs.every(pg=>pg.vacc))){nextTurn();continue}
      if(p.human)break;
      execute(room.actor,botMove(room.actor));
      if(guard===999)throw new Error('Game advance limit reached.');
    }
    room.uid=rules.getUid();
  }
  return {execute,settle,beginRound,rules};
}
function escapeText(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function applyCommand(original,i,command,random=Math.random){
  requireThat(command&&typeof command==='object'&&!Array.isArray(command),'Invalid command.');
  const seat=original.seats[i];requireThat(seat?.human,'Invalid seat.');
  requireThat(typeof command.id==='string'&&/^[a-zA-Z0-9-]{8,64}$/.test(command.id),'Invalid command ID.');
  if(seat.seen.includes(command.id))return original;
  requireThat(command.version===seat.version,'Your game changed. Please try again.');
  requireThat(command.turnId===original.turnId,'The turn changed. Please try again.');
  // Copy first so a rejected move cannot partially mutate the saved game.
  const room=structuredClone(original),s=room.seats[i];
  if(room.phase==='lobby'){
    if(command.type==='ready'){
      requireThat(typeof command.ready==='boolean','Invalid ready state.');s.ready=command.ready;
    }else if(command.type==='configure'){
      requireThat(i===0,'Only the host can configure the room.');
      const {count,bots}=command;
      requireThat([2,3].includes(count)&&Array.isArray(bots)&&bots.every(j=>Number.isInteger(j)&&j>0&&j<count)&&new Set(bots).size===bots.length,'Invalid room settings.');
      room.seats.forEach((p,j)=>requireThat(!p?.human||(j<count&&!bots.includes(j)),'An occupied human seat cannot be removed.'));
      room.seats=Array.from({length:count},(_,j)=>room.seats[j]?.human?room.seats[j]:bots.includes(j)?{name:`AI ${j}`,human:false,ready:true}:null);
      room.seats.forEach(p=>{if(p?.human)p.ready=false});
    }else if(command.type==='start'){
      requireThat(i===0,'Only the host can start.');
      requireThat(room.seats.every(p=>p&&p.ready),'Every seat must be filled and ready.');
      const e=engine(room,random);
      room.players=room.seats.map(p=>e.rules.mkPlayer(p.name,p.human));room.deck=e.rules.buildDeck();
      room.phase='opening';room.turnId++;room.actor=0;room.step=0;room.left=5;
      e.settle();
    }else throw new Error('Unknown lobby command.');
  }else{
    const e=engine(room,random);e.execute(i,command);e.settle();
  }
  s.version++;s.seen.push(command.id);s.seen=s.seen.slice(-32);
  return room;
}
function viewRoom(room,i,online=[]){
  return {phase:room.phase,turnId:room.turnId,version:room.seats[i].version,me:i,
    seats:room.seats.map((s,j)=>s?{name:s.name,human:s.human,ready:s.ready,connected:!s.human||online.includes(j)}:null),
    players:room.players,state:room.state,actor:room.actor,left:room.left,
    choices:room.phase==='choose'?null:room.choices,myChoice:room.choices[i]??null,
    locked:room.choices.map(c=>c!==null),allot:room.allot,logs:room.logs,results:room.results};
}
module.exports={createRoom,joinRoom,applyCommand,viewRoom,engine};
