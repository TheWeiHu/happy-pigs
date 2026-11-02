/* Online controls render server snapshots; only the server commits moves. */
function onlineSetup(roomId=null){
  if(location.protocol==='file:'){
    const o=onlineModal('Play Online');
    o.box.append(paragraph('Online play needs the hosted multiplayer site. Local play still works from this file.'));
    o.box.append(button('Back To Local Play',()=>{o.remove();setup()}));return;
  }
  const o=onlineModal(roomId?'Join Game':'Play Online');
  const form=document.createElement('form');form.className='online-form';
  const name=document.createElement('input');name.placeholder='Your Nickname';name.maxLength=14;name.required=true;name.autocomplete='nickname';
  name.setAttribute('aria-label','Your Nickname');
  form.append(name);
  const error=paragraph('');error.setAttribute('role','alert');
  const submit=button(roomId?'Join Game':'Create Room');submit.type='submit';submit.classList.add('primary');
  form.append(submit);o.box.append(paragraph('Private games for 2–3 farmers. Share a link and play from separate devices.'),form,error);
  if(!roomId){
    const join=document.createElement('input');join.placeholder='Paste An Invite Link';join.setAttribute('aria-label','Invite Link');
    o.box.append(join,button('Join An Existing Room',()=>{
      const match=join.value.match(/(?:#room=)?([a-f0-9]{32})$/);
      if(!match){error.textContent='Paste the complete invite link.';return}
      o.remove();history.replaceState(null,'',`#room=${match[1]}`);onlineSetup(match[1]);
    }));
  }
  o.box.append(button('Back To Local Play',()=>{o.remove();history.replaceState(null,'',location.pathname);setup()}));
  form.onsubmit=async e=>{
    e.preventDefault();submit.disabled=true;error.textContent='';
    try{
      localStorage.setItem('hp-storage-check','1');localStorage.removeItem('hp-storage-check');
      const response=await fetch(roomId?`/api/rooms/${roomId}/join`:'/api/rooms',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name.value}),signal:AbortSignal.timeout(15000)});
      if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('This site has no multiplayer server. Open the multiplayer hosting link.');
      const data=await response.json();if(!response.ok)throw new Error(data.error);
      localStorage.setItem(`hp-room-${data.room}`,data.token);
      history.replaceState(null,'',`#room=${data.room}`);o.remove();connectRoom(data.room,data.token);
    }catch(err){error.textContent=err.message;submit.disabled=false}
  };
  name.focus();
}
function paragraph(text){const p=document.createElement('p');p.textContent=text;return p}
function button(text,click){const b=document.createElement('button');b.type='button';b.className='btn';b.textContent=text;if(click)b.onclick=click;return b}
function onlineModal(title){
  const o=document.createElement('div');o.className='overlay online-overlay';
  const box=document.createElement('div');box.className='modal';o.append(box);o.box=box;
  const h=document.createElement('h2');h.textContent=title;box.append(h);document.body.append(o);return o;
}
function connectRoom(room,token){
  let socket,retry=0,retryTimer,heartbeat,view=null,pending=null,connected=false,stopped=false,lobby=null,selection=null,lastSeen=Date.now();
  const bar=document.createElement('div');bar.className='online-bar';
  const connection=document.createElement('span');connection.setAttribute('role','status');
  const message=document.createElement('span');message.setAttribute('role','alert');
  const exit=button('Exit Room',()=>{stopped=true;clearTimeout(retryTimer);clearInterval(heartbeat);socket?.close();location.assign(location.pathname)});
  bar.append(connection,message,exit);document.querySelector('header').after(bar);
  function status(text){connection.textContent=text}
  function send(type,args={}){
    if(!connected||pending||!view)return;
    selection=null;
    pending={...args,type,id:crypto.randomUUID(),version:view.version,turnId:view.turnId};
    socket.send(JSON.stringify(pending));message.textContent='';draw();
  }
  const control=(text,type,args={})=>{
    const b=button(text,()=>send(type,args));b.disabled=!connected||!!pending;return b;
  };
  function drawLobby(){
    if(!lobby)lobby=onlineModal('Game Lobby');
    const box=lobby.box;box.replaceChildren();
    const h=document.createElement('h2');h.textContent='Game Lobby';box.append(h);
    box.append(paragraph('Share this private link. Everyone must be ready before the host starts.'));
    const invite=document.createElement('input');invite.readOnly=true;invite.value=location.href;invite.setAttribute('aria-label','Invite Link');
    const copy=button('Copy Invite Link',async()=>{
      try{await navigator.clipboard.writeText(invite.value);copy.textContent='Copied!'}catch{invite.select();copy.textContent='Select And Copy The Link'}
    });box.append(invite,copy);
    if(view.me===0){
      const counts=document.createElement('div');counts.className='seatcount';
      [2,3].forEach(count=>{
        const bots=view.seats.flatMap((s,i)=>s&&!s.human&&i<count?[i]:[]);
        const b=control(`${count} Players`,'configure',{count,bots});
        b.disabled=b.disabled||view.seats.slice(count).some(s=>s?.human);
        if(count===view.seats.length)b.classList.add('primary');counts.append(b);
      });box.append(counts);
    }
    view.seats.forEach((s,i)=>{
      const row=document.createElement('div');row.className='seat online-seat';
      const label=document.createElement('span');
      label.textContent=s?`${s.human?'🧑‍🌾':'🤖'} ${s.name}${i===view.me?' (You)':''} · ${!s.human?'AI':!s.connected?'Disconnected':s.ready?'Ready':'Not Ready'}`:`Seat ${i+1} · Waiting For A Friend`;
      row.append(label);
      if(view.me===0&&i>0&&!s?.human){
        let bots=view.seats.flatMap((p,j)=>p&&!p.human?[j]:[]);
        bots=s?bots.filter(j=>j!==i):[...bots,i];
        row.append(control(s?'Open For Friend':'Add AI','configure',{count:view.seats.length,bots}));
      }
      box.append(row);
    });
    box.append(control(view.seats[view.me].ready?'Not Ready':'Ready','ready',{ready:!view.seats[view.me].ready}));
    if(view.me===0){const start=control('Start Game','start');start.classList.add('primary');start.disabled=start.disabled||!view.seats.every(s=>s&&s.ready);box.append(start)}
    const stateText=paragraph(`${connection.textContent}${message.textContent?' · '+message.textContent:''}`);stateText.setAttribute('role','status');box.append(stateText);
    box.append(button('Exit Room',()=>exit.click()));
  }
  function pick(filter,onPick){
    players[view.me].pigs.forEach(pg=>{
      const el=pigEl(view.me,pg.id);if(!el)return;
      const ok=filter(pg);el.classList.add(ok?'pick':'dim');
      el.setAttribute('role','button');el.setAttribute('aria-label',`${pg.vacc?'Vaccinated ':''}${pg.size} Pig ${pg.id}`);
      el.tabIndex=ok?0:-1;el.setAttribute('aria-disabled',String(!ok||!connected||!!pending));
      const click=()=>{if(ok&&connected&&!pending)onPick(pg)};el.onclick=click;
      el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();click()}};
    });
  }
  function draw(){
    if(!view)return;
    if(view.phase==='lobby'){drawLobby();return}
    lobby?.remove();lobby=null;
    players=view.players;nP=players.length;Object.assign(state,view.state);
    buildBoard();render();clearTiles();clearSub();clearActive();
    if(state.card)showCard(state.card);
    document.getElementById('log').replaceChildren();
    view.logs.forEach(entry=>log('sys',entry));
    const sub=document.getElementById('submenu'),tiles=document.getElementById('tiles');
    if(view.phase==='finished'){
      const names=view.results.winners.map(i=>players[i].name).join(' & ');
      subPrompt(`<b>${esc(names)} ${view.results.winners.length>1?'Win':'Wins'}!</b>`);
      view.results.scores.forEach(s=>sub.append(paragraph(`${s.name}: $${s.coins} · Tie-Break: $${s.tiebreak}`)));
      sub.append(button('New Game',()=>exit.click()));return;
    }
    if(view.choices?.length){
      const reveal=document.createElement('div');reveal.className='online-reveal';
      view.choices.forEach((a,i)=>{if(a)reveal.append(paragraph(`${players[i].name}: ${ANAME[a]} ×${view.allot[i]??0}`))});
      sub.append(reveal);
    }
    if(view.phase==='choose'){
      activePanel(view.me);
      subPrompt(view.myChoice?`You Locked In <b>${ANAME[view.myChoice]}</b>. Waiting For The Other Farmers…`:'<b>Choose Your Secret Action</b> — revealed when everyone locks in.');
      if(!view.myChoice)ACTIONS.forEach(a=>{
        const b=control(ANAME[a],'choose',{action:a});b.className+=' tile k-'+a;
        const img=document.createElement('img');img.src=UI_ART[a];img.className='atile';img.alt='';b.prepend(img);tiles.append(b);
      });
      view.seats.forEach((s,i)=>sub.append(paragraph(`${s.name}: ${view.locked[i]?'Locked In':'Choosing…'}${!s.connected?' · Disconnected':''}`)));return;
    }
    const name=players[view.actor].name;
    if(view.actor!==view.me){
      const doing=view.phase==='opening'?'Opening Purchases':view.phase==='vaccinate'?'Vaccination':ANAME[view.choices[view.actor]];
      subPrompt(`Waiting For <b>${esc(name)}</b> — ${doing}${view.seats[view.actor].connected?'':' · Disconnected; Their Seat Is Saved'}.`);return;
    }
    activePanel(view.me);
    const p=players[view.me];
    if(view.phase==='vaccinate'){
      subPrompt('<b>Last Chance To Vaccinate</b> — unvaccinated pigs die when the season ends.');
      pick(pg=>!pg.vacc&&p.items.vaccine>0,pg=>send('vaccinate',{pig:pg.id}));
      sub.append(control('Continue','done'));return;
    }
    const action=view.phase==='opening'?'buy':view.choices[view.me];
    subPrompt(`<b>${view.phase==='opening'?'Opening Purchases':ANAME[action]}</b> — ${view.left} Left. ${action==='buy'?'':'Select Your Pigs Below.'}`);
    if(action==='buy'){
      buyOptions(p).forEach(o=>{
        const b=control('', 'buy',{item:o.k});b.innerHTML=`${o.label} <span class="c">$${o.cost}</span>`;
        b.disabled=b.disabled||!o.ok()||(o.k==='field'&&p.fields.length>=16);sub.append(b);
      });
    }else if(action==='sell'){
      pick(()=>true,pg=>send('sell',{pig:pg.id}));
    }else if(action==='feed'){
      if(selection?.type==='feed'){
        subPrompt('Use A Supplement For An Extra Growth Step?');
        sub.append(control('Use Supplement','feed',{pig:selection.pig,supplement:true}),control('Feed Normally','feed',{pig:selection.pig}));
      }else pick(pg=>pg.fedRound!==state.roundSerial&&canGrow(p,pg),pg=>{
        if(p.items.supplement>0&&['piglet','small'].includes(pg.size)){selection={type:'feed',pig:pg.id};draw()}
        else send('feed',{pig:pg.id});
      });
    }else if(action==='mate'){
      if(selection?.type==='amulet'){
        subPrompt('Use An Amulet To Make The Newborn A Small Pig?');
        sub.append(control('Use Amulet','mate',{pigs:selection.pigs,amulet:true}),control('Plain Piglet','mate',{pigs:selection.pigs}));
      }else{
        subPrompt(`<b>Mate</b> — Choose ${selection?'The Second Parent':'Two Average Or Big Pigs'} (${view.left} Left).`);
        pick(pg=>['average','big'].includes(pg.size)&&pg.matedRound!==state.roundSerial&&pg.id!==selection?.pig,pg=>{
          if(!selection){selection={type:'parent',pig:pg.id};draw();return}
          const pigs=[selection.pig,pg.id];
          if(p.items.amulet>0&&canFitNew(p,'small')){selection={type:'amulet',pigs};draw()}
          else send('mate',{pigs});
        });
        if(selection)pigEl(view.me,selection.pig)?.classList.add('sel');
      }
    }
    if(selection)sub.append(button('Cancel Selection',()=>{selection=null;draw()}));
    sub.append(control(view.phase==='opening'?'Done':`Done (+$${view.left})`,'done'));
  }
  async function connect(){
    status(retry?'Reconnecting… Your Seat Is Saved':'Connecting…');
    const url=new URL(`/api/rooms/${room}/connect`,location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
    try{
      const check=await fetch(`/api/rooms/${room}/connect`,{signal:AbortSignal.timeout(10000)});
      if(check.status===404){stopped=true;status('Room Not Found Or Expired');draw();return}
      if(!check.ok)throw new Error('Server unavailable');
    }catch{
      if(!stopped){status('Disconnected · Reconnecting…');draw();retryTimer=setTimeout(connect,Math.min(1000*2**retry++,10000))}
      return;
    }
    if(stopped)return;
    socket=new WebSocket(url);
    socket.onopen=()=>socket.send(JSON.stringify({type:'auth',token}));
    socket.onmessage=e=>{
      lastSeen=Date.now();
      if(e.data==='pong')return;
      const msg=JSON.parse(e.data);
      if(msg.type==='state'){
        const first=!connected;connected=true;retry=0;
        if(view?.turnId!==msg.turnId)selection=null;
        view=msg;status(`Online · ${view.seats[view.me].name}`);
        draw();
        if(first){
          clearInterval(heartbeat);heartbeat=setInterval(()=>{
            if(Date.now()-lastSeen>45000){socket.close(4000,'Connection timed out');return}
            if(socket.readyState===WebSocket.OPEN)socket.send('ping');
          },10000);
          if(pending)socket.send(JSON.stringify(pending));
        }
      }else if(msg.type==='ack'){
        if(pending?.id===msg.id)pending=null;draw();
      }else if(msg.type==='error'){
        if(!msg.id||pending?.id===msg.id)pending=null;
        message.textContent=msg.message;draw();
      }
    };
    socket.onclose=e=>{
      connected=false;clearInterval(heartbeat);
      if(stopped)return;
      if([4001,4003,4004].includes(e.code)){
        stopped=true;status(e.code===4001?'This Seat Is Open In Another Tab':e.code===4004?'Room Expired':'Unable To Restore This Seat');draw();return;
      }
      status('Disconnected · Reconnecting…');draw();
      retryTimer=setTimeout(connect,Math.min(1000*2**retry++,10000));
    };
    socket.onerror=()=>{message.textContent='Cannot reach the room server. Retrying…'};
  }
  window.addEventListener('offline',()=>socket?.close(4000,'Connection lost'));
  window.hpOnline={
    canMove:i=>connected&&!pending&&view?.me===i&&!['lobby','finished'].includes(view.phase),
    move:d=>send(d.kind==='pig'?'movePig':'moveBoard',d.kind==='pig'?{pig:d.pg.id,...d.cand}:{field:d.f,...d.cand}),
  };
  window.__hp=()=>({players,state,phase:view?.phase,me:view?.me});
  connect();
}
if(location.hash.startsWith('#room=')){
  const room=location.hash.slice(6);
  if(/^[a-f0-9]{32}$/.test(room)){
    let token;try{token=localStorage.getItem(`hp-room-${room}`)}catch{}
    if(token)connectRoom(room,token);else onlineSetup(room);
  }else onlineSetup();
}
