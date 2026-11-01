/** The host's "reset game" restarts mid-game: same pack and players, scores zeroed, round one. */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-game-restart-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
await import('./make-sample-pack.ts');
const [{ Room }, { loadPack }] = await Promise.all([
  import('../server/game/Room.ts'), import('../server/packs/packManager.ts'),
]);
const loaded = await loadPack('Demo pack (v5 format).siq');
after(async () => rm(root, { recursive: true, force: true }));

function game(t) {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const players = ['Alice', 'Bob'].map((name, i) => {
    const p = room.join(name).participant;
    room.attach(p.id, `player-${i}`);
    return p;
  });
  room.setPack({ ...loaded, pack: structuredClone(loaded.pack) });
  room.updateSettings(host.id, { ...INSTANT_BUZZER, gameMode: 'classic', timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  room.engine.start();
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  return { room, host, players };
}

test('restart mid-question zeroes scores and replays round one from a fresh board', (t) => {
  const { room, host, players } = game(t);
  const engine = room.engine;
  engine.selectQuestion(host.id, true, 0, 0);
  players.forEach((p) => { p.score = 500; });
  engine.restart();
  assert.equal(engine.roundIndex, 0);
  assert.equal(engine.phase, 'board');
  assert.equal(engine.current, null);
  assert.equal(engine.played.size, 0);
  assert.deepEqual(room.players().map((p) => p.score), [0, 0]);
  assert.ok(players.some((p) => p.id === engine.chooserId));
});

test('restart also works from pause and from a later round', (t) => {
  const { room } = game(t);
  const engine = room.engine;
  engine.enterRound(1);
  engine.pause();
  engine.restart();
  assert.equal(engine.roundIndex, 0);
  assert.equal(engine.phase, 'board');
  assert.equal(engine.paused, null);
});

test('a refused restart leaves the running game untouched', (t) => {
  const { room, host, players } = game(t);
  const engine = room.engine;
  engine.selectQuestion(host.id, true, 0, 0);
  players.forEach((p) => { p.score = 300; });
  const phase = engine.phase;
  room.participants.get(host.id).connected = false;
  assert.throws(() => engine.restart(), /connected host/);
  assert.equal(engine.phase, phase);
  assert.deepEqual(room.players().map((p) => p.score), [300, 300]);
});

test('start still refuses mid-game; only restart may interrupt', (t) => {
  const { room } = game(t);
  assert.throws(() => room.engine.start(), /Stop the current game/);
});

test('the restart command is host-level on the server and confirmed on the client', async () => {
  const handlers = await readFile(new URL('../server/socket/handlers.ts', import.meta.url), 'utf8');
  assert.match(handlers, /on\('game:restart', 'manager', \(\) => room\.engine\.restart\(\)\)/);
  const app = await readFile(new URL('../client/src/app.ts', import.meta.url), 'utf8');
  assert.match(app, /if \(act === 'game:restart'\) \{\s*return \{ title: t\('Restart this game\?'\)/);
});
