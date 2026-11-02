# 🐷 Happy Pigs

A farming board game for **2–3 players**, with local pass-and-play and private online rooms. Mix human and AI farmers.

### ▶️ [Play it now](https://theweihu.github.io/happy-pigs/)

![Happy Pigs gameplay](happy-pigs.gif)

## How to play

Take turns through the four seasons: place workers on action boards, buy items at the market, and raise the happiest pigs. Full rules are built into the game — hit the rulebook button in-game.

## Run locally

Open `index.html` with `game-core.js` and `online.js` beside it for local play.

For multiplayer development (Node 22.12+):

```sh
npm ci
npm run dev
```

Open the displayed URL, choose **Play Online**, enter a nickname, and share the room link. Everyone marks themselves **Ready**, then the host starts. Each human uses a separate browser or device. Refreshing restores a seat in the same browser; a second tab takes over that seat. Rooms expire after seven days without a move or join. Disconnected players keep their seats, and play waits for their input. Online farms support up to 16 connected fields.

The online server uses Cloudflare Workers, WebSockets, and SQLite-backed Durable Objects. Each room stores its own deck, secret choices, and game progress. Clients send moves; the server checks ownership, turn, budget, placement, and repeated requests. AI runs on the server. Offline and online play share `game-core.js`.

Run `npm test` for rules and server tests. Run `npx playwright install chromium` once, then `npm run test:e2e` for separate-browser and mobile checks. `npm run deploy` publishes the frontend and backend together to an authenticated Cloudflare account. GitHub Pages serves local play only; online invite links must use the Worker URL.
