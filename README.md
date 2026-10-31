# SIGame Local

A self-hosted, LAN-only Jeopardy-style game for a room full of phones, inspired by
[SIGame](https://github.com/VladimirKhil/SI) / [SIOnline](https://github.com/VladimirKhil/SIOnline).
One Windows, macOS, or Linux computer runs the server. Everyone else opens the link in a browser.
The app uses TypeScript throughout. The browser client uses pinned Rolldown Vite 7 for Rust-backed bundling.

## Quick start

1. Install **Node.js 20.19+ or 22.12+** from https://nodejs.org.
2. On Windows, double-click **`start.bat`**. On macOS or Linux, run **`./start.sh`**. You can also run **`npm start`** on any platform. The launcher installs dependencies for the current OS and CPU when needed, builds the TypeScript/Vite client, then starts the server.

### Standalone executable

Run `npm run build:exe` with Node.js 22 or newer on the target OS. The output is
`dist/sigame-local-<platform>-<architecture>` (`.exe` on Windows). Move that one
file to a writable folder and run it; players then open the printed LAN URL.
No Node.js or npm installation is needed on the host running the built executable.
The executable includes the web client, demo packs, pack parser, FFmpeg, and the
Steam desktop integration. On first run it extracts runtime assets and creates
`packs/`, `data/`, and `tools/` beside itself. Keep those folders when replacing
the executable to retain downloaded packs and room recovery. Build separately
on each operating system and CPU architecture you distribute.
3. The console shows `http://192.168.x.x:3000` plus a QR code. Share either one with your players.
4. The **first person to join** chooses **Host** or **Player**. Everyone after that becomes a Player,
   or a Spectator once the player slots are full.
   If the first person chooses Player, appoint another participant as Host in the lobby before starting.
   If the host disconnects during play, a connected player inherits moderation after the reconnect
   window. They can release the offline host seat and appoint a connected spectator as host.
5. In the host panel, upload a `.siq` pack or paste a Steam Workshop link. You can also put packs in `packs/`.

Open `http://<server-address>:3000/?tv` on a shared screen after a participant joins. It joins as a spectator.
Room seats, scores, settings, and the board are saved under `data/room-state.json` for restart recovery.
An interrupted question returns to the board for replay after restart.
The host can pause and resume the current phase; question media and round countdowns pause with it.
Pack media URLs carry a viewer ticket; the server only serves the current question and
revealed answer media to players. Keep room links within the local network.
Pack HTML displays in a sandbox with static relative images and styles; scripts are blocked.
Pack uploads are limited to 200 MB, validated before they appear in the list, and require a connected host (or the room owner while no host is present).
Workshop updates keep prior pack versions so a saved game can resume with the same questions after a restart.

Guided classic mode supports standard, no-risk, secret, secret gifts without a question, stake auctions, for-all questions, and final questions.
In a stake auction, players bid in turn, may go all-in or pass, and the high bidder answers for the winning amount.
For-all questions collect each player's private text answer, then the host judges them separately for the fixed question value.
The host selects secret recipients. In the final round, players submit private wagers and the host
judges each answer. Final themes are removed one by one before the question is chosen. The optional
“Play all final themes” setting repeats this flow for the first question of every final theme.
After a revealed verdict, players can request an appeal. Eligible players vote privately; an accepted appeal
corrects the score and, when needed, the next chooser.
Pack files are limited to 200 MB compressed, 1 GB extracted, and 256 MB per media file.

> Allow Node.js through your firewall so phones can connect. To use a different port,
> set `PORT=3001` before starting (`set PORT=3001` on Windows, `PORT=3001 ./start.sh` on macOS/Linux).

> The server only accepts its own pages, reached by an IP address, `localhost`, a `*.local` name,
> or this computer's name. If guests reach it by another name (a router DNS name or a reverse proxy),
> start it with `ALLOWED_HOSTS=quiz.home` (comma-separated), or `ALLOW_ANY_ORIGIN=1` to turn the check off.
> Each device may hold up to 32 connections that have not joined yet; change it with `SOCKET_CAP_PER_ADDRESS`.

## Quick start (macOS)

1. Install **Node.js 20.19+ or 22.12+** from https://nodejs.org (or via Homebrew: `brew install node`).
2. Double-click **`start.command`** in Finder, or run **`./start.sh`** in Terminal:
   ```bash
   chmod +x start.sh start.command
   ./start.sh
   ```
   *(If macOS Gatekeeper blocks double-clicking `start.command` after cloning/downloading, either Right-Click → **Open**, or run `xattr -d com.apple.quarantine start.command start.sh` once in Terminal).*
3. On the first run it installs dependencies, creates demo packs if `packs/` is empty, and prints your Mac's LAN link (`http://192.168.x.x:3000`) + a QR code for phones. To use a different port: `PORT=3001 ./start.sh`.

For Steam Workshop downloads, keep the Steam desktop app open and signed in with SIGame added to your library. If the desktop download fails, the server installs Valve's macOS SteamCMD in `tools/steamcmd/` and tries it automatically. SIGame is listed for Windows only on Steam, and some Workshop items deny anonymous SteamCMD access. If this happens, download the item through Steam on a Windows computer and upload its `.siq` file in the host panel. SteamCMD can also use `STEAM_USER` and `STEAM_PASS` for an account with SIGame access. SteamCMD receives the password on its command line, so other users of this computer can see it in process listings; use a dedicated Steam account, not your main one.

Want a pack to test with? Run `npm run make-sample` to create two demo packs (modern v5 format and legacy v4 format).

## Project structure

```
sigamelocal/
├─ start.bat / start.sh / start.command   Platform entry points
├─ scripts/start.js          Shared installer, builder, and server launcher
├─ tsconfig.json             TypeScript checks for client, server, and scripts
├─ package.json
├─ server/
│  ├─ index.ts               Express + Socket.io server; serves the Vite client
│  ├─ config.ts              Typed paths, port, Steam app id (env-overridable)
│  ├─ game/
│  │  ├─ constants.ts        ROLES, PHASES, Role/Phase union types
│  │  ├─ settings.ts         GameSettings interface + schema based on SIGame's AppSettings/TimeSettings
│  │  ├─ Room.ts             Participants, sessions/reconnect, role assignment, RoomSnapshot type
│  │  └─ GameEngine.ts       Game rules, timers, and judging
│  ├─ socket/handlers.ts     Typed Socket.io event API + permission checks
│  ├─ packs/
│  │  ├─ siqParser.ts        .siq (zip + content.xml v4/v5) → Package model, safe media extraction
│  │  ├─ mediaTranscoder.ts  Automatic AV1/VP9/Opus → H.264/AAC transcoding for iPhone/iPad
│  │  └─ packManager.ts      List, load and cache packs
│  ├─ steam/
│  │  ├─ workshop.ts         Link → id → Steam API → local Steam / Steamworks UGC / steamcmd → .siq
│  └─ utils/                 Network (LAN IPs), filesystem helpers
├─ client/                   TypeScript browser client and Vite build output
├─ vite.config.ts            Vite build and development proxy
│  │  ├─ workshop.ts         Link → id → Steam API → local Steam / Steamworks UGC / steamcmd → .siq
│  │  ├─ localSteam.ts       Local Steam library scanner + Steamworks UGC downloader
│  │  └─ steamcmd.ts         Installs steamcmd automatically and runs workshop_download_item
│  └─ utils/                 Network (LAN IPs), filesystem helpers (.ts)
├─ client/                   TypeScript browser client and Vite build output
├─ vite.config.ts            Vite build and development proxy
├─ scripts/                  inspect-pack.ts, make-sample-pack.ts, smoke-test.ts
├─ packs/                    Your .siq files
├─ data/cache/               Extracted & iOS-transcoded media (safe to delete)
└─ tools/steamcmd/           Created if the steamcmd fallback is used
```

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Install platform dependencies if needed, build the client, then start the server |
| `npm run dev` | Build the client, then auto-restart the server on changes |
| `npm run dev:client` | Vite client dev server on port 5173; proxies sockets and media to the server on port 3000 |
| `npm run build` | Type-check and bundle the client into `client/dist` |
| `npm run make-sample` | Create demo packs in `packs/` |
| `npm run inspect-pack -- packs/X.siq [--json]` | Print a pack summary, or the full parsed model with `--json` |
| `npm run smoke` | End-to-end test against a running, freshly started server |
| `npm test` | Isolated answer privacy, media access, host recovery, game-rule, and restart tests |

For client changes, run `npm run dev` and `npm run dev:client` in separate terminals, then open
port 5173. If the server uses another `PORT`, set the same value for `dev:client`.

## Socket API (summary)

Every client event is `(payload, ack)`. The ack returns `{ ok: true, ... }` or `{ ok: false, error }`.

| Event | Who | Payload |
|---|---|---|
| `session:join` / `session:resume` / `session:leave` | anyone / returning player / member | `{ nickname }` / `{ token }` / `{}` |
| `role:choose` | first joiner | `{ role: 'host' \| 'player' }` |
| `role:set` | self / host | `{ targetId, role }` |
| `participant:kick`, `score:adjust` | host | `{ targetId }`, `{ targetId, delta }` |
| `packs:list`, `packs:load`, `steam:download` | host | `{ file }`, `{ link }` |
| `settings:schema`, `settings:update` | anyone / host | patch object |
| `game:start`, `game:stop`, `game:pause`, `game:resume`, `game:select`, `game:openBuzzer`, `game:buzz`, `game:judge`, `game:reveal`, `game:next`, `game:nextRound` | as appropriate | |
| `game:answer` | selected player in written-answer mode | `{ answer }` (1–350 characters before the answer deadline) |
| `game:contentFinished` | current moderator | `{ presentationId }` for a finished wait-for-media question |
| `game:undoJudgment` | current moderator | `{ presentationId, judgmentId }` from `game.undoJudgment` in the latest room view |
| `game:stakeBid`, `game:stakePass` | current bidder | `{ amount, allIn }`, `{}` |
| `game:forAllAnswer`, `game:closeForAll`, `game:judgeForAll` | player / host / host | `{ answer }`, `{}`, `{ playerId, correct }` |
| `game:appealRequest`, `game:appealVote`, `game:appealClose` | player / eligible voter / host | `{ judgmentId }`, `{ support }`, `{}` |

Server → client: `room:state` (a personalised snapshot; players never get answers early), `game:event`,
`steam:progress`, `packs:changed`, `session:kicked`.

Written answers are visible only to the current moderator and answerer until judged. Undo applies
to the latest verdict in the current question; it cannot erase an answer already seen by viewers.

The host panel uploads packs with `POST /api/packs/upload` using the room session token in an
`Authorization: Bearer` header and a URI-encoded filename in `X-Pack-Name`.

## Roadmap

- [x] Step 1: project setup, cross-platform launcher
- [x] Step 2: server, role assignment, sessions/reconnect, core game loop
- [x] Step 3: `.siq` parser (v4 and v5 formats)
- [x] Step 4: Steam Workshop downloader
- [x] Step 5: TypeScript + Vite client (host dashboard, player buzzer, big-screen "TV" view)
- [x] Step 6: special questions (secret/"cat in a poke", stake/auction, no-risk, for-all), final round
- [x] Step 7: pause/resume, browser pack upload, sound cues
- [x] Step 7: appeals
- [x] Single-executable packaging
