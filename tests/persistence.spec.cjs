const {test,expect}=require('@playwright/test');
const {spawn}=require('node:child_process');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const path=require('node:path');

test('saved game and private choice survive a server process restart',async({browser})=>{
  const storage=mkdtempSync(path.join(tmpdir(),'happy-pigs-restart-'));
  let processHandle;
  async function start(){
    processHandle=spawn(process.execPath,['--experimental-sqlite','server/node.cjs'],{
      env:{...process.env,PORT:'8790',HAPPY_PIGS_DATA_DIR:storage},cwd:path.join(__dirname,'..'),stdio:'ignore',detached:true});
    await expect.poll(async()=>{try{return (await fetch('http://127.0.0.1:8790')).status}catch{return 0}},{timeout:30000}).toBe(200);
  }
  async function stop(){
    const child=processHandle;processHandle=null;if(!child)return;
    const closed=new Promise(resolve=>child.once('exit',resolve));
    process.kill(-child.pid,'SIGTERM');await closed;
    await expect.poll(async()=>{try{await fetch('http://127.0.0.1:8790');return false}catch{return true}}).toBe(true);
  }
  const a=await browser.newContext(),b=await browser.newContext();
  try{
    await start();const host=await a.newPage(),guest=await b.newPage();
    await host.goto('http://127.0.0.1:8790');await host.getByRole('button',{name:'Play Online',exact:true}).click();
    await host.getByRole('textbox',{name:'Your Nickname'}).fill('Persistent');await host.getByRole('button',{name:'Create Room',exact:true}).click();
    await expect(host.getByRole('heading',{name:'Game Lobby'})).toBeVisible();
    await guest.goto(host.url());await guest.getByRole('textbox',{name:'Your Nickname'}).fill('Friend');await guest.getByRole('button',{name:'Join Game',exact:true}).click();
    for(const p of [host,guest]){await p.getByRole('button',{name:'Ready',exact:true}).click();await expect(p.getByRole('button',{name:'Not Ready',exact:true})).toBeEnabled()}
    await host.getByRole('button',{name:'Start Game',exact:true}).click();
    await host.getByRole('button',{name:/Small pig/}).click();await expect(host.locator('#coins-0')).toHaveText('$39');
    await host.getByRole('button',{name:'Done',exact:true}).click();await guest.getByRole('button',{name:'Done',exact:true}).click();
    await host.getByRole('button',{name:'Feed',exact:true}).click();await expect(host.locator('#prompt')).toContainText('Locked In');
    const before=await host.evaluate(()=>window.__hp());
    await stop();await start();await host.reload();await guest.reload();
    await expect(host.locator('#prompt')).toContainText('Locked In');await expect(guest.locator('#submenu')).toContainText('Persistent: Locked In');
    const after=await host.evaluate(()=>window.__hp());expect(after).toEqual(before);
    await expect(guest.locator('#submenu')).not.toContainText('Persistent: Feed');
    await guest.getByRole('button',{name:'Buy',exact:true}).click();await expect(host.locator('#submenu')).toContainText('Persistent: Feed');
  }finally{await a.close();await b.close();await stop();rmSync(storage,{recursive:true,force:true})}
});
