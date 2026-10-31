/** A throw inside a game timer is logged and the game keeps going (audit CONN-1). */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-safe-timer-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
await import('./make-sample-pack.ts');
const [{ safeTimeout }, { Room }, { listPacks, loadPack }] = await Promise.all([
  import('../server/utils/safeTimer.ts'),
  import('../server/game/Room.ts'),
  import('../server/packs/packManager.ts'),
]);
const loaded = await loadPack((await listPacks()).find((pack) => pack.name.includes('v5')).file);
after(async () => rm(root, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a throwing callback is logged, the process survives, and onError runs', async (t) => {
  const warn = mock.method(console, 'warn', () => {});
  t.after(() => warn.mock.restore());
  let recovered = 0;
  safeTimeout('test boom', () => { throw new Error('boom'); }, 1, () => { recovered++; });
  await sleep(20);
  assert.equal(recovered, 1);
  assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('test boom')));
});

test('the handle is unref\'d (real timer)', () => {
  const handle = safeTimeout('idle', () => {}, 60_000);
  assert.equal(handle.hasRef(), false);
  clearTimeout(handle);
});

test('a throw inside the buzz window grant leaves the engine usable', async (t) => {
  const warn = mock.method(console, 'warn', () => {});
  t.after(() => warn.mock.restore());
  const room = new Room();
  t.after(() => room.engine.reset());
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const player = room.join('Player').participant;
  room.attach(player.id, 'player-socket');
  room.setPack(loaded);
  room.updateSettings(host.id, { ...INSTANT_BUZZER, timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  room.engine.start();
  room.engine.selectQuestion(host.id, true, 0, 0);
  room.engine.openBuzzer();
  assert.equal(room.engine.phase, 'buzzerOpen');

  let changes = 0;
  room.on('change', () => { changes++; });
  room.engine.grantPendingBuzz = () => { throw new Error('forced grant failure'); };
  room.engine.buzzer.pending = [{ playerId: player.id }];
  room.engine.scheduleBuzzWindow(1);
  await sleep(30);

  assert.ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('buzz window')));
  assert.ok(changes > 0, 'room re-broadcasts after the failure');
  // The engine still accepts moderator actions afterwards.
  delete room.engine.grantPendingBuzz;
  assert.doesNotThrow(() => room.engine.buzz(player.id));
});
