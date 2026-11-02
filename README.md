# 🐷 Happy Pigs

A farming board game for **2–3 players**, with local pass-and-play and private online rooms. Mix human and AI farmers.

### ▶️ [Online Multiplayer Preview](https://happy-pigs.100-24-248-180.sslip.io/#online) · [Local Play](https://theweihu.github.io/happy-pigs/)

![Happy Pigs gameplay](happy-pigs.gif)

## How to play

Take turns through the four seasons: place workers on action boards, buy items at the market, and raise the happiest pigs. Full rules are built into the game — hit the rulebook button in-game.

## Run locally

Open `index.html` with `game-core.js` and `online.js` beside it for local play.

For multiplayer development (Node 22.13+):

```sh
npm ci
npm run dev
```

Open the displayed URL, choose **Play Online**, enter a nickname, and share the room link. Everyone marks themselves **Ready**, then the host starts. Each human uses a separate browser or device. Refreshing restores a seat in the same browser; a second tab takes over that seat. Rooms expire after seven days without a move or join. Disconnected players keep their seats, and play waits for their input. Online farms support up to 16 connected fields.

The online server runs on AWS Lightsail using Node.js, WebSockets, and SQLite. Each accepted move is committed before broadcasting. One server process owns the live connections; the database persists across restarts and releases. AI runs on the server, and both play modes share `game-core.js`.

`HAPPY_PIGS_DATA_DIR` selects the database directory (default: `~/Dropbox/Apps/happy-pigs-data`). `PORT` and `HOST` select the listener. Production uses `PUBLIC_ORIGIN` for origin checks and `TRUST_PROXY=1` behind the loopback nginx proxy.

Run `npm test` for rules and server tests. Run `npx playwright install chromium` once, then `npm run test:e2e` for separate-browser, restart, and mobile checks. `deploy/` contains the systemd service, nginx template, and release uploader. Once the AWS host is configured, set `HAPPY_PIGS_SSH_TARGET` and optionally `HAPPY_PIGS_SSH_KEY`, then run `deploy/push.sh`. Releases are isolated from `/var/lib/happy-pigs/rooms.sqlite`; failed health checks restore the previous release.
