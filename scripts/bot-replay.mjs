/**
 * Full replay: every pack, every question, played by a bot host and 4 bot players over sockets.
 * Not part of `npm test` (it needs a running server and takes minutes per big pack).
 *
 * Usage: node scripts/bot-replay.mjs <serverUrl> [packFilter]
 *        MODE=finals node scripts/bot-replay.mjs <serverUrl>   (jump to the final, play every final theme)
 * Start the server on an empty room first (e.g. a fresh ROOM_STATE_FILE); the bot host must be first.
 *
 * Logs each question, unexpected ack errors, stalls (no phase change for STALL_MS) and media fetch
 * failures. In the final and in for-all questions one bot only types (game:draft) and never sends:
 * the host then closes answer time and the bot's draft must reach judging (device playtest F4).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';

const SERVER = process.argv[2] ?? 'http://localhost:3041';
const FILTER = process.argv[3] ?? '';
// MODE=finals: jump to the final round, give every bot points, and play every final theme.
const FINALS = process.env.MODE === 'finals';
const STALL_MS = 25000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const issues = [];
const issue = (msg) => { issues.push(msg); log('ISSUE', msg); };

function client(name) {
  const socket = io(SERVER, { transports: ['websocket'], forceNew: true });
  const c = { name, socket, state: null, id: null, onState: null };
  c.emit = (event, payload = {}) => new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'ack timeout' }), 8000);
    socket.emit(event, payload, (r) => { clearTimeout(t); resolve(r ?? { ok: true }); });
  });
  socket.on('room:state', (s) => { c.state = s; c.id = s.you?.id ?? c.id; c.onState?.(s); });
  return c;
}

const host = client('Host');
// Leave cleanly so a later run can take the seats (an offline seat is held for the reconnect window).
async function leaveAll() { await Promise.all(all.map((c) => c.emit('session:leave').catch(() => {}))); }
process.on('SIGTERM', async () => { await leaveAll(); process.exit(0); });
const players = ['Ann', 'Ben', 'Cid', 'Dee'].map(client);
const all = [host, ...players];
const byId = (id) => players.find((p) => p.id === id);

// Seats survive a crashed run (held for reconnect), so resume saved tokens before joining fresh.
const TOKENS = path.join(os.tmpdir(), `sigame-bot-replay-${new URL(SERVER).port || 'default'}.json`);
let saved = {};
try { saved = JSON.parse(fs.readFileSync(TOKENS, 'utf8')); } catch { /* first run */ }
let r;
for (const c of all) {
  if (saved[c.name]) {
    const res = await c.emit('session:resume', { token: saved[c.name] });
    if (res.ok && res.resumed) continue;
  }
  r = await c.emit('session:join', { nickname: c.name });
  if (!r.ok) throw new Error(`${c.name} join: ${r.error}`);
  saved[c.name] = r.token;
  if (c === host) await host.emit('role:choose', { role: 'host' });
}
fs.writeFileSync(TOKENS, JSON.stringify(saved));
await sleep(500);

// Errors the bots can legitimately cause by racing a phase change.
const benign = /not your turn|closed|No active|already|not open|cannot|no verdict|has changed|Not now|blocked/i;
async function act(c, event, payload, why) {
  const res = await c.emit(event, payload);
  if (!res.ok && !benign.test(res.error ?? '')) issue(`${c.name} ${event} (${why}) -> ${res.error}`);
  return res;
}

async function checkMedia(items, label) {
  for (const item of items ?? []) {
    if (item?.missing) { issue(`media missing in pack for ${label}: ${item.type} ${item.value?.slice(-60)}`); continue; }
    if (!item?.url || typeof item.url !== 'string') continue;
    try {
      const res = await fetch(new URL(item.url, SERVER), { method: 'GET', headers: { Range: 'bytes=0-15' } });
      if (!res.ok && res.status !== 206) issue(`media ${res.status} for ${label}: ${item.type} ${decodeURIComponent(item.url.split('?')[0]).slice(-60)}`);
    } catch (e) { issue(`media fetch error ${label}: ${e.message}`); }
  }
}

async function playPack(file, name) {
  log('=== PACK', name);
  let res = await host.emit('packs:load', { file });
  if (!res.ok) { issue(`load ${name}: ${res.error}`); return; }
  res = await host.emit('settings:update', {
    gameMode: 'classic', timeForQuestionIntro: 1, timeForQuestionReady: 1, timeForThinkingOnQuestion: 3, timeForPrintingAnswer: 5,
    timeForMediaDelay: 0, timeForChoosingQuestion: 30, timeForFinalThinking: 15,
    timeForMakingStake: 10, timeForThinkingOnSpecial: 10, timeForGivingACat: 30, falseStart: true,
    playAllQuestionsInFinalRound: FINALS,
  });
  if (!res.ok) issue(`settings ${name}: ${res.error}`);
  res = await host.emit('game:start');
  if (!res.ok) { issue(`start ${name}: ${res.error}`); return; }
  if (FINALS) {
    const pack = host.state?.pack;
    const finalIndex = (pack?.rounds ?? []).length - 1;
    for (let i = 0; i < 10 && host.state.game.roundIndex < finalIndex; i++) { await host.emit('game:nextRound'); await sleep(300); }
    if (host.state.game.round?.type !== 'final') { log(`(no final round in ${name})`); }
    for (const p of players) await host.emit('score:adjust', { targetId: p.id, delta: 1000 + Math.max(0, -(host.state.participants.find((x) => x.id === p.id)?.score ?? 0)) });
  }

  const seen = new Set();
  let stats = { questions: 0, types: {}, answerTypes: {}, media: {} };
  let lastChange = Date.now();
    let lastKey = ''; let progressKey = '';
  let busy = false;
  let n = 0;
  let appealsTried = 0;

  return new Promise((resolve) => {
    let lastRetry = 0;
    const stallTimer = setInterval(() => {
      // Bots act on their own (possibly lagging) state; re-run the current step every 4 s without progress.
      if (Date.now() - lastChange > 4000 && Date.now() - lastRetry > 4000) { lastRetry = Date.now(); lastKey = ''; step(); }
      if (Date.now() - lastChange > STALL_MS) {
        const g = host.state?.game;
        issue(`STALL ${name}: phase=${g?.phase} round=${g?.roundIndex} timer=${g?.timer?.name ?? '-'} current=${g?.current?.themeName}/${g?.current?.price}`);
        lastChange = Date.now();
        // Nudge forward so one stall does not end the replay.
        host.emit('game:next');
      }
    }, 2000);

    const step = async () => {
      if (busy) return;
      const s = host.state;
      const g = s?.game;
      if (!g) return;
      const key = `${g.phase}|${g.roundIndex}|${g.current?.presentationId ?? ''}|${g.chooserId}|${g.buzzer.winnerId}|${g.buzzer.attempted.length}|${g.auction?.turnId}|${g.final?.wagered.length}|${g.final?.judged.length}|${g.final?.answeredIds.length}|${g.forAll?.submittedIds.length}|${g.forAll?.judgedIds.length}|${g.removedFinalThemes.length}|${g.appeals?.active?.votedIds.length}`;
      if (key === lastKey) return;
      if (key !== progressKey) { progressKey = key; lastChange = Date.now(); }
      lastKey = key;
      busy = true;
      try {
        await handle(s, g);
      } finally { busy = false; setTimeout(step, 50); }
    };

    const handle = async (s, g) => {
      const c = g.current;
      if (c && !seen.has(c.presentationId) && g.phase !== 'intro') {
        seen.add(c.presentationId);
        stats.questions++;
        stats.types[c.type] = (stats.types[c.type] ?? 0) + 1;
        stats.answerTypes[c.answerType] = (stats.answerTypes[c.answerType] ?? 0) + 1;
        for (const it of c.content ?? []) stats.media[it.type] = (stats.media[it.type] ?? 0) + 1;
        log(`Q${stats.questions} r${g.roundIndex} ${g.round?.type ?? ''} ${c.themeName} ${c.price} type=${c.type} ans=${c.answerType} content=${(c.content ?? []).map((i) => i.type).join(',')}`);
        // Players' view: media must be reachable with their own ticket.
        const pv = players[0].state?.game?.current;
        if (pv?.presentationId === c.presentationId) await checkMedia(pv.content, `${c.themeName}/${c.price}`);
      }
      n++;
      switch (g.phase) {
        case 'board': {
          const chooser = byId(g.chooserId) ?? null;
          let ti = -1, qi = -1;
          g.board.forEach((t, a) => t.questions.forEach((q, b) => { if (ti < 0 && q.available) { ti = a; qi = b; } }));
          if (ti < 0) { await act(host, 'game:next', {}, 'board empty'); break; }
          await sleep(100);
          if (chooser) await act(chooser, 'game:select', { themeIndex: ti, questionIndex: qi }, 'pick');
          else await act(host, 'game:select', { themeIndex: ti, questionIndex: qi }, 'host pick');
          break;
        }
        case 'reading':
          if (g.current?.type !== 'forAll') { await sleep(300); await act(host, 'game:openBuzzer', {}, 'open early'); }
          break;
        case 'buzzerOpen': {
          // Mix: two out of three questions get a buzz from someone who has not tried yet.
          if (n % 3 === 0) break;
          const free = players.filter((p) => !g.buzzer.attempted.includes(p.id));
          const p = free[n % Math.max(1, free.length)];
          // Wait for the scheduled green signal: a press before it is a false start.
          if (p) { await sleep(Math.max(0, (g.buzzer.openedAt ?? 0) - Date.now()) + 150); await act(p, 'game:buzz', { clientAt: Date.now() }, 'buzz'); }
          break;
        }
        case 'answering': {
          const w = byId(g.buzzer.winnerId);
          const at = c?.answerType ?? 'text';
          if (at === 'select' && w) {
            const opts = w.state.game.current?.answerOptions ?? [];
            await act(w, 'game:answer', { answer: opts[n % Math.max(1, opts.length)]?.label ?? 'A' }, 'select');
          } else if (at === 'point' && w) {
            await act(w, 'game:answer', { answer: '0.5,0.5' }, 'point');
          } else if (!s.settings.oral && w) {
            const typed = g.buzzer.typedAnswer;
            if (typed && !typed.submitted && !typed.closed) await act(w, 'game:answer', { answer: 'bot answer' }, 'typed');
            else await act(host, 'game:judge', { correct: n % 2 === 0 }, 'judge typed');
          } else {
            const roll = n % 5;
            await act(host, 'game:judge', roll === 0 ? { correct: true, factor: 0.5 } : { correct: roll % 2 === 0 }, 'judge');
          }
          break;
        }
        case 'reveal': {
          // Once per pack: the last wrong verdict gets an appeal.
          const j = g.appeals?.judgments?.at(-1);
          if (j && !j.correct && !j.appealed && appealsTried < 1 && s.settings.useApellations) {
            appealsTried++;
            const req = players.find((p) => p.id !== j.playerId) ?? players[0];
            const ar = await act(byId(j.playerId) ?? req, 'game:appealRequest', { judgmentId: j.id }, 'appeal');
            if (ar.ok) break;
          }
          await sleep(200);
          await act(host, 'game:next', {}, 'next after reveal');
          break;
        }
        case 'appealVote': {
          const a = g.appeals?.active;
          for (const p of players) if (a?.eligibleVoterIds.includes(p.id) && !a.votedIds.includes(p.id)) await act(p, 'game:appealVote', { support: true }, 'vote');
          break;
        }
        case 'specialSetup': {
          const target = players[n % players.length];
          const price = c?.priceRange ? c.priceRange.minimum : c?.price ?? 0;
          await act(host, 'game:configureSpecial', { playerId: target.id, price }, 'special');
          break;
        }
        case 'stakeAuction': {
          const turn = byId(g.auction?.turnId);
          if (!turn) break;
          const me = s.participants.find((p) => p.id === turn.id);
          const bid = g.auction.minimumNextBid;
          if (!g.auction.leaderId && bid <= Math.max(g.auction.minimum, me?.score ?? 0)) await act(turn, 'game:stakeBid', { amount: bid, allIn: false }, 'bid');
          else await act(turn, 'game:stakePass', {}, 'pass');
          break;
        }
        case 'forAllAnswering': {
          // The first eligible bot only types; the others send.
          const eligible = players.filter((p) => g.forAll?.eligibleIds.includes(p.id));
          for (const [i, p] of eligible.entries()) {
            if (g.forAll.submittedIds.includes(p.id)) continue;
            if (i === 0) await act(p, 'game:draft', { text: `${p.name} draft` }, 'forAll draft');
            else await act(p, 'game:forAllAnswer', { answer: `${p.name} says` }, 'forAll');
          }
          await sleep(200);
          if (host.state.game.phase === 'forAllAnswering') await act(host, 'game:closeForAll', {}, 'close forAll');
          break;
        }
        case 'forAllJudge': {
          // The host sees every answer while judging: the typing-only bot's draft must be among them.
          const first = players.find((p) => g.forAll?.eligibleIds.includes(p.id));
          if (first && g.forAll?.answers && g.forAll.answers[first.id] !== `${first.name} draft`) {
            issue(`for-all draft not used for ${first.name}: ${g.forAll.answers[first.id]}`);
          }
          for (const id of g.forAll?.eligibleIds ?? []) if (!g.forAll.judgedIds.includes(id)) await act(host, 'game:judgeForAll', { playerId: id, correct: id.length % 2 === 0 }, 'judge forAll');
          break;
        }
        case 'roundEnd':
          await act(host, 'game:next', {}, 'round end');
          break;
        case 'finalThemes': {
          const chooser = byId(g.chooserId) ?? host;
          const idx = g.board.findIndex((t, i) => !g.removedFinalThemes.includes(i) && t.questions[0]?.available);
          if (idx >= 0) await act(chooser, 'game:removeFinalTheme', { themeIndex: idx }, 'remove theme');
          break;
        }
        case 'finalWager': {
          for (const p of players) {
            const fs = p.state.game.final;
            if (fs?.eligibleIds.includes(p.id) && !fs.wagered.includes(p.id)) {
              const score = s.participants.find((x) => x.id === p.id)?.score ?? 0;
              await act(p, 'game:finalWager', { amount: Math.floor(score / 2) }, 'wager');
            }
          }
          await sleep(200);
          const hf = host.state.game.final;
          if (host.state.game.phase === 'finalWager' && hf && hf.eligibleIds.every((id) => hf.wagered.includes(id))) await act(host, 'game:openFinal', {}, 'open final');
          break;
        }
        case 'finalQuestion': {
          // The first finalist only types; the host then ends answer time early.
          const finalists = players.filter((p) => p.state.game.final?.eligibleIds.includes(p.id));
          for (const [i, p] of finalists.entries()) {
            if (i === 0) await act(p, 'game:draft', { text: `${p.name} draft` }, 'final draft');
            else if (!p.state.game.final.yourAnswer) await act(p, 'game:finalAnswer', { answer: `${p.name} final` }, 'final answer');
          }
          await sleep(200);
          if (host.state.game.phase === 'finalQuestion') await act(host, 'game:closeFinal', {}, 'close final early');
          break;
        }
        case 'finalJudge': {
          const first = players.find((p) => g.final?.eligibleIds.includes(p.id));
          if (first && g.final?.answers && g.final.answers[first.id] !== `${first.name} draft`) {
            issue(`final draft not used for ${first.name}: ${g.final.answers[first.id]}`);
          }
          for (const id of g.final?.eligibleIds ?? []) if (!g.final.judged.includes(id)) await act(host, 'game:judgeFinal', { playerId: id, correct: id.length % 2 === 1 }, 'judge final');
          break;
        }
        case 'gameOver': {
          clearInterval(stallTimer);
          host.onState = null;
          const scores = s.participants.filter((p) => p.role === 'player').map((p) => `${p.name}:${p.score}`).join(' ');
          log(`=== DONE ${name}: ${stats.questions} questions; types ${JSON.stringify(stats.types)}; answer ${JSON.stringify(stats.answerTypes)}; content ${JSON.stringify(stats.media)}; scores ${scores}`);
          resolve(stats);
          break;
        }
        default: break;
      }
    };
    host.onState = () => step();
    step();
  });
}

const list = await host.emit('packs:list');
if (!list.ok) throw new Error(`packs:list: ${list.error}`);
const packs = (list.packs ?? []).filter((p) => !p.error && p.name.includes(FILTER));
log('packs:', packs.map((p) => p.name).join(' | '));
const summary = [];
for (const p of packs) {
  const st = await playPack(p.file, p.name);
  summary.push({ pack: p.name, questions: st?.questions });
  await host.emit('game:stop');
  await sleep(800);
}
log('SUMMARY', JSON.stringify(summary));
log(`ISSUES (${issues.length}):`);
for (const i of issues) log(' -', i);
await leaveAll();
for (const c of all) c.socket.close();
process.exit(0);
