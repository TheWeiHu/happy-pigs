const {test,expect}=require('@playwright/test');
const path=require('node:path');
const shot=name=>path.join(__dirname,'..','.context',name);
async function create(page,name){
  await page.goto('/');await page.getByRole('button',{name:'Play Online',exact:true}).click();
  await page.getByRole('textbox',{name:'Your Nickname'}).fill(name);
  await page.getByRole('button',{name:'Create Room',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Game Lobby'})).toBeVisible();return page.url();
}
async function ready(page){await page.getByRole('button',{name:'Ready',exact:true}).click();await expect(page.getByRole('button',{name:'Not Ready',exact:true})).toBeEnabled()}
async function done(page){const b=page.getByRole('button',{name:/^Done/});await expect(b).toBeEnabled();await b.click()}
async function phase(page,value){await expect.poll(()=>page.evaluate(()=>window.__hp?.().phase)).toBe(value)}

test('two independent browsers, private choices, refresh, disconnect, full match and mobile',async({browser})=>{
  const hostContext=await browser.newContext(),guestContext=await browser.newContext({viewport:{width:390,height:844}});
  const host=await hostContext.newPage(),guest=await guestContext.newPage();
  const errors=[];for(const p of [host,guest])p.on('pageerror',e=>errors.push(e.message));
  const url=await create(host,'Rosie');
  await host.getByRole('button',{name:'3 Players',exact:true}).click();
  await expect(host.locator('.online-seat')).toHaveCount(3);
  await host.locator('.online-seat').nth(2).getByRole('button',{name:'Add AI'}).click();
  await guest.goto(url);await guest.getByRole('textbox',{name:'Your Nickname'}).fill('Hamlet');
  await guest.getByRole('button',{name:'Join Game',exact:true}).click();
  await expect(guest.getByRole('heading',{name:'Game Lobby'})).toBeVisible();
  await ready(host);await ready(guest);
  await guest.screenshot({path:shot('multiplayer-lobby-mobile.png')});
  await expect(host.getByRole('button',{name:'Start Game',exact:true})).toBeEnabled();
  await host.getByRole('button',{name:'Start Game',exact:true}).click();
  await phase(host,'opening');await phase(guest,'opening');
  await host.getByRole('button',{name:/Small pig/}).click();
  await expect(host.locator('#coins-0')).toHaveText('$39');await expect(guest.locator('#coins-0')).toHaveText('$39');
  await host.reload();await phase(host,'opening');await expect(host.locator('#coins-0')).toHaveText('$39');
  await done(host);await guest.getByRole('button',{name:/Average pig/}).click();await done(guest);
  await phase(host,'choose');await phase(guest,'choose');
  await host.getByRole('button',{name:'Feed',exact:true}).click();
  await expect(host.locator('#prompt')).toContainText('Locked In');
  await expect(guest.locator('#submenu')).toContainText('Rosie: Locked In');
  await expect(guest.locator('#submenu')).not.toContainText('Rosie: Feed');
  await guest.getByRole('button',{name:'Sell',exact:true}).click();
  await phase(host,'action');await expect(host.locator('#submenu')).toContainText('Rosie: Feed');
  await host.locator('#fields-0 .pigtile').click();await expect(host.locator('#meta-0')).toContainText('(0·0·1·0)');
  await done(host);
  await guest.locator('#fields-1 .pigtile').click();await expect(guest.locator('#coins-1')).toHaveText('$45');
  await guest.locator('.controls').scrollIntoViewIfNeeded();
  await guest.screenshot({path:shot('multiplayer-game-mobile.png')});
  const width=await guest.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));expect(width.scroll).toBeLessThanOrEqual(width.width);
  await guestContext.setOffline(true);
  await expect(guest.locator('.online-bar')).toContainText('Disconnected');
  await expect(guest.getByRole('button',{name:/^Done/})).toBeDisabled();
  await guestContext.setOffline(false);
  await expect(guest.locator('.online-bar')).toContainText('Online · Hamlet',{timeout:20000});
  await done(guest);await phase(host,'choose');
  // Complete all remaining rounds through visible controls in separate browser contexts.
  for(let round=2;round<=16;round++){
    await phase(host,'choose');await phase(guest,'choose');
    await host.getByRole('button',{name:'Buy',exact:true}).click();
    await guest.getByRole('button',{name:'Buy',exact:true}).click();
    await phase(host,'action');
    for(let turn=0;turn<2;turn++){
      await expect.poll(async()=>{
        for(const p of [host,guest])if(await p.getByRole('button',{name:/^Done/}).isVisible())return true;
        return false;
      }).toBe(true);
      const p=await host.getByRole('button',{name:/^Done/}).isVisible()?host:guest;
      await done(p);
      await expect(p.getByRole('button',{name:/^Done/})).not.toBeVisible();
    }
    // Vet visits can leave vaccines to use at a season boundary.
    if(round%4===0){
      for(let step=0;step<3;step++){
        await host.waitForTimeout(100);
        for(const p of [host,guest]){
          const b=p.getByRole('button',{name:'Continue',exact:true});
          if(await b.isVisible())await b.click();
        }
      }
    }
  }
  await phase(host,'finished');await phase(guest,'finished');
  expect(await host.locator('#submenu').innerText()).toEqual(await guest.locator('#submenu').innerText());
  await host.screenshot({path:shot('multiplayer-finished-desktop.png')});
  expect(errors).toEqual([]);await hostContext.close();await guestContext.close();
});

test('local play still works and seat tokens do not grant a second player the same seat',async({browser,page})=>{
  await page.goto('/');await page.getByRole('button',{name:'Start game',exact:false}).click();
  await page.getByRole('button',{name:/ready/}).click();await expect(page.locator('#prompt')).toContainText('Opening market');
  const url=await create(page,'Local');
  await page.getByRole('button',{name:'Add AI'}).click();await ready(page);
  await page.getByRole('button',{name:'Start Game',exact:true}).click();await phase(page,'opening');
  const extra=await page.context().newPage();await extra.goto(url);await phase(extra,'opening');
  await expect(page.locator('.online-bar')).toContainText('Another Tab');
  const strangerContext=await browser.newContext(),stranger=await strangerContext.newPage();
  await stranger.goto(url);await stranger.getByRole('textbox',{name:'Your Nickname'}).fill('Stranger');
  await stranger.getByRole('button',{name:'Join Game',exact:true}).click();
  await expect(stranger.getByRole('alert')).toContainText('already started');
  await strangerContext.close();await extra.close();
});

test('supplement, paired mating and amulet controls submit valid server moves',async({browser})=>{
  const a=await browser.newContext(),b=await browser.newContext();
  const host=await a.newPage(),guest=await b.newPage();
  try{
    const url=await create(host,'Farmer');await guest.goto(url);
    await guest.getByRole('textbox',{name:'Your Nickname'}).fill('Friend');await guest.getByRole('button',{name:'Join Game',exact:true}).click();
    await ready(host);await ready(guest);await host.getByRole('button',{name:'Start Game',exact:true}).click();
    for(const name of [/Average pig/,/Average pig/,/Amulet/,/Piglet/,/Supplement/]){
      const buy=host.getByRole('button',{name});await expect(buy).toBeEnabled();await buy.click();
    }
    await done(guest);await phase(host,'choose');
    // Moving during secret choices broadcasts placement without locking an action.
    const pig=host.locator('#fields-0 .pigtile').first();await pig.scrollIntoViewIfNeeded();const bounds=await pig.boundingBox();
    await host.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await host.mouse.down();
    await host.mouse.move(bounds.x+bounds.width/2+102,bounds.y+bounds.height/2+68,{steps:10});await host.mouse.up();
    await expect.poll(()=>host.evaluate(()=>window.__hp().players[0].pigs[0].y)).toBe(4);
    await expect.poll(()=>guest.evaluate(()=>window.__hp().players[0].pigs[0].y)).toBe(4);
    await host.getByRole('button',{name:'Feed',exact:true}).click();await guest.getByRole('button',{name:'Buy',exact:true}).click();
    await host.locator('#fields-0 .pigtile[title="piglet"]').click();await host.getByRole('button',{name:'Use Supplement',exact:true}).click();
    await expect(host.locator('#meta-0')).toContainText('(0·0·3·0)');
    await host.locator('#fields-0 .pigtile.pick').first().click();
    await expect(host.locator('#meta-0')).toContainText('(0·0·2·1)');
    await host.locator('#fields-0 .pigtile.pick').first().click();
    await expect(host.locator('#meta-0')).toContainText('(0·0·1·2)');await done(host);await done(guest);
    await phase(host,'choose');await host.getByRole('button',{name:'Mate',exact:true}).click();await guest.getByRole('button',{name:'Buy',exact:true}).click();
    await done(guest);
    await host.locator('#fields-0 .pigtile.pick').first().click();await host.locator('#fields-0 .pigtile.pick').first().click();
    await host.getByRole('button',{name:'Use Amulet',exact:true}).click();await expect(host.locator('#meta-0')).toContainText(/\(\d+·1·1·2\)/);
    await expect(guest.locator('#meta-0')).toContainText(/\(\d+·1·1·2\)/);
  }finally{await a.close();await b.close()}
});
