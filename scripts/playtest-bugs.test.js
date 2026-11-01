/** Playtest bugs: a returning host reclaims the empty seat, lobby readiness, and passing after a buzz. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-playtest-bugs-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
await import('./make-sample-pack.ts');
const [{ Room }, { loadPack }] = await Promise.all([
  import('../server/game/Room.ts'), import('../server/packs/packManager.ts'),
]);
const loaded = await loadPack('Demo pack (v5 format).siq');
after(async () => rm(root, { recursive: true, force: true }));

function lobby(t) {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const players = ['Alice', 'Bob', 'Cara'].map((name, index) => {
    const player = room.join(name).participant;
    room.attach(player.id, `player-${index}`);
    return player;
  });
  room.setPack(loaded);
  room.updateSettings(host.id, { ...INSTANT_BUZZER, gameMode: 'classic', timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  return { room, host, players, engine: room.engine };
}

function rejoin(room, name, socketId) {
  const participant = room.join(name).participant;
  room.attach(participant.id, socketId);
  return participant;
}

/* ------------------------------------------------------------ host reclaim */

test('a host who pressed Leave rejoins as a player and takes the empty host seat back', (t) => {
  const { room, host } = lobby(t);
  room.remove(host.id);
  const back = rejoin(room, 'Host', 'host-2');
  assert.equal(back.role, 'player');
  assert.notEqual(room.ownerId, back.id, 'ownership moved on while they were away');
  room.setRole(back.id, back.id, 'host');
  assert.equal(room.host()?.id, back.id);
  assert.equal(room.snapshotFor(back.id).you.canModerate, true);
});

test('only the claimant or a moderator can fill the empty host seat', (t) => {
  const { room, host, players: [alice, bob] } = lobby(t);
  room.remove(host.id);
  const notOwner = room.ownerId === alice.id ? bob : alice;
  const other = notOwner === alice ? bob : alice;
  assert.throws(() => room.setRole(notOwner.id, other.id, 'host'), /Only the host can appoint/);
  room.setRole(notOwner.id, notOwner.id, 'host');
  assert.throws(() => room.setRole(other.id, other.id, 'host'), /host seat is taken/);
});

test('mid-game a player claims the empty host seat only between questions; a spectator any time', (t) => {
  const { room, host, players: [alice, bob], engine } = lobby(t);
  engine.start();
  room.remove(host.id);
  const back = rejoin(room, 'Host', 'host-2');
  assert.equal(back.role, 'player', 'a free slot seats the newcomer mid-game');
  engine.chooserId = back.id;
  engine.selectQuestion(alice.id, true, 0, 0);
  assert.throws(() => room.setRole(back.id, back.id, 'host'), /Wait until the question is over/);
  room.setRole(back.id, back.id, 'spectator');
  room.setRole(back.id, back.id, 'host');
  assert.equal(room.host()?.id, back.id);
  room.setRole(back.id, back.id, 'player');

  engine.openBuzzer();
  engine.buzz(alice.id);
  engine.judge(true);
  engine.next();
  assert.equal(engine.phase, 'board');
  engine.chooserId = back.id;
  room.setRole(back.id, back.id, 'host');
  assert.equal(room.host()?.id, back.id);
  assert.ok([alice.id, bob.id].includes(engine.chooserId), 'the pick passes to a seated player');
});

/* -------------------------------------------------------------- readiness */

test('players mark themselves ready in the lobby; a start or role change clears it', (t) => {
  const { room, host, players: [alice, bob], engine } = lobby(t);
  room.setReady(alice.id, true);
  room.setReady(bob.id, true);
  const seat = (id) => room.snapshotFor(host.id).participants.find((p) => p.id === id);
  assert.equal(seat(alice.id).ready, true);
  room.setReady(bob.id, false);
  assert.equal(seat(bob.id).ready, false);
  assert.throws(() => room.setReady(host.id, true), /Only players/);

  room.setReady(bob.id, true);
  room.setRole(bob.id, bob.id, 'spectator');
  room.setRole(bob.id, bob.id, 'player');
  assert.equal(seat(bob.id).ready, false, 'a reseated player confirms again');

  engine.start();
  assert.equal(seat(alice.id).ready, false);
  assert.throws(() => room.setReady(alice.id, true), /already started/);
});

/* ------------------------------------------------------------------- pass */

// Only the host passes, for the answerer who says "pass"; players have no Pass of their own.
test('the host passes for the answerer: no penalty, out for this question, buttons reopen for the rest', (t) => {
  const { room, host, players: [alice, bob, cara], engine } = lobby(t);
  engine.start();
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();
  assert.throws(() => engine.passAnswer(), /Nobody is answering/, 'nobody is answering yet');
  engine.buzz(alice.id);
  engine.passAnswer();
  assert.equal(alice.score, 0);
  assert.equal(engine.phase, 'buzzerOpen');
  assert.equal(engine.buzz(alice.id).result, 'ignored', 'the passed player is out for this question');
  assert.equal(engine.current.judgments.length, 0, 'a pass is not a verdict');

  engine.buzz(bob.id);
  engine.passAnswer();
  engine.buzz(cara.id);
  engine.passAnswer();
  assert.equal(engine.phase, 'reveal', 'nobody left: the answer is shown');
  assert.equal(room.players().every((p) => p.score === 0), true);
});

test('an assigned question cannot be passed', (t) => {
  const { host, players: [alice], engine } = lobby(t);
  engine.start();
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();
  engine.buzz(alice.id);
  engine.current.type = 'secret';
  assert.throws(() => engine.passAnswer(), /must be answered/);
});

test('the admin panel (packs and settings) belongs to the host, not an owner who sits as a player', (t) => {
  const room = new Room();
  const owner = room.join('Owner').participant;
  room.attach(owner.id, 'owner');
  room.chooseInitialRole(owner.id, 'player');
  const host = rejoin(room, 'Host', 'host');
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
  // With no host yet, the owner runs the room and picks the pack.
  assert.equal(room.canManage(owner.id), true);
  room.setRole(owner.id, host.id, 'host');

  assert.equal(room.canManage(host.id), true);
  assert.equal(room.canManage(owner.id), false);
  assert.equal(room.snapshotFor(owner.id).you.canManage, false);
  assert.throws(() => room.updateSettings(owner.id, { oral: true }), /Only the host/);
});
