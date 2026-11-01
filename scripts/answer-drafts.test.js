/**
 * Typed but unsent answers survive the end of answer time (device playtest F4).
 * The server keeps them as drafts, uses them only at close, never shows them, and never lets them
 * close answer time early.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-drafts-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
await import('./make-sample-pack.ts');
const [{ Room }, { loadPack }, { registerSocketHandlers }] = await Promise.all([
  import('../server/game/Room.ts'), import('../server/packs/packManager.ts'), import('../server/socket/handlers.ts'),
]);
const loaded = await loadPack('Demo pack (v5 format).siq');
after(async () => rm(root, { recursive: true, force: true }));

function cleanup(t, room) {
  t.after(() => {
    room.engine.reset();
    for (const timer of room.removalTimers.values()) clearTimeout(timer);
  });
}

/** Host plus Alice and Bob, both finalists with 500 points, in the final question. */
function finalQuestion(t) {
  const room = new Room();
  cleanup(t, room);
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const [alice, bob] = ['Alice', 'Bob'].map((name, i) => {
    const p = room.join(name).participant;
    room.attach(p.id, `player-${i}`);
    return p;
  });
  const pack = structuredClone(loaded.pack);
  pack.rounds[2].themes = [pack.rounds[2].themes[0]];
  room.setPack({ ...loaded, pack });
  room.updateSettings(host.id, { gameMode: 'classic' });
  const engine = room.engine;
  engine.start();
  alice.score = 500;
  bob.score = 500;
  engine.enterRound(2); // one final theme: its question starts at once
  if (engine.phase === 'board') engine.selectQuestion(host.id, true, 0, 0);
  engine.setFinalWager(alice.id, 100);
  engine.setFinalWager(bob.id, 100);
  engine.openFinal();
  assert.equal(engine.phase, 'finalQuestion');
  return { room, engine, host, alice, bob };
}

/** Host plus Alice and Bob in the answer phase of a for-all question. */
function forAllAnswering(t) {
  const room = new Room();
  cleanup(t, room);
  const host = room.join('Host').participant;
  room.attach(host.id, 'host');
  room.chooseInitialRole(host.id, 'host');
  const [alice, bob] = ['Alice', 'Bob'].map((name, i) => {
    const p = room.join(name).participant;
    room.attach(p.id, `player-${i}`);
    return p;
  });
  const pack = structuredClone(loaded.pack);
  pack.rounds[0].themes[0].questions[0].type = 'forAll';
  room.setPack({ ...loaded, pack });
  room.updateSettings(host.id, { gameMode: 'classic', timeForQuestionIntro: 0, timeForQuestionReady: 0 });
  const engine = room.engine;
  engine.start();
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openForAllAnswers();
  assert.equal(engine.phase, 'forAllAnswering');
  return { room, engine, host, alice, bob };
}

test('final: a draft becomes the answer when the host ends answer time early', (t) => {
  const { engine, alice, bob } = finalQuestion(t);
  engine.saveDraft(alice.id, '  Lyon ');
  engine.submitFinalAnswer(bob.id, 'Paris');
  assert.equal(engine.phase, 'finalQuestion', 'a draft never counts as answered');
  engine.closeFinal();
  assert.equal(engine.finalAnswers.get(alice.id), 'Lyon');
  assert.equal(engine.finalAnswers.get(bob.id), 'Paris');
});

test('final: a draft is used when the clock runs out and when its writer is offline', (t) => {
  const { room, engine, alice, bob } = finalQuestion(t);
  engine.saveDraft(alice.id, 'Rome');
  engine.saveDraft(bob.id, 'Oslo');
  room.detach(bob.id, 'player-1');
  assert.equal(engine.timer?.name, 'final');
  engine.closeFinal(); // what the 'final' timer calls when it runs out
  assert.equal(engine.phase, 'finalJudge');
  assert.equal(engine.finalAnswers.get(alice.id), 'Rome');
  assert.equal(engine.finalAnswers.get(bob.id), 'Oslo');
});

test('final: an edit after sending wins; sending again clears the draft', (t) => {
  const { engine, alice } = finalQuestion(t);
  engine.submitFinalAnswer(alice.id, 'Paris');
  engine.saveDraft(alice.id, 'Lyon');
  engine.closeFinal();
  assert.equal(engine.finalAnswers.get(alice.id), 'Lyon');
});

test('final: another player\'s last answer never locks in a half-typed edit', (t) => {
  const { room, engine, host, alice, bob } = finalQuestion(t);
  engine.submitFinalAnswer(alice.id, 'Lyon');
  assert.equal(engine.saveDraft(alice.id, 'P'), true, 'the host hears that Alice is changing her answer');
  assert.deepEqual(room.snapshotFor(host.id).game.final.editingIds, [alice.id]);
  assert.deepEqual(room.snapshotFor(bob.id).game.final.editingIds, [], 'only the host sees who is changing');
  engine.submitFinalAnswer(bob.id, 'Rome');
  assert.equal(engine.phase, 'finalQuestion', 'an edit after sending holds the auto-close');
  assert.equal(engine.saveDraft(alice.id, 'Paris'), false);
  assert.equal(engine.saveDraft(alice.id, 'Lyon'), true, 'typing the sent text back ends the edit and closes');
  assert.equal(engine.phase, 'finalJudge');
  assert.equal(engine.finalAnswers.get(alice.id), 'Lyon');
});

test('final: clearing an edit lets the held final close with the sent answer', (t) => {
  const { engine, alice, bob } = finalQuestion(t);
  engine.submitFinalAnswer(alice.id, 'Lyon');
  engine.saveDraft(alice.id, 'Par');
  engine.submitFinalAnswer(bob.id, 'Rome');
  assert.equal(engine.saveDraft(alice.id, ''), true);
  assert.equal(engine.phase, 'finalJudge');
  assert.equal(engine.finalAnswers.get(alice.id), 'Lyon');
});

test('final: an edit dropped during a pause lets the final close on resume', (t) => {
  const { engine, alice, bob } = finalQuestion(t);
  engine.submitFinalAnswer(alice.id, 'Lyon');
  engine.saveDraft(alice.id, 'Par');
  engine.submitFinalAnswer(bob.id, 'Rome');
  engine.pause();
  engine.saveDraft(alice.id, '');
  assert.equal(engine.phase, 'paused', 'nothing closes while paused');
  engine.resume();
  assert.equal(engine.phase, 'finalJudge');
  assert.equal(engine.finalAnswers.get(alice.id), 'Lyon');
});

test('final: a draft older than the last sent answer loses', (t) => {
  const { engine, alice } = finalQuestion(t);
  engine.saveDraft(alice.id, 'Lyon');
  engine.submitFinalAnswer(alice.id, 'Paris');
  engine.closeFinal();
  assert.equal(engine.finalAnswers.get(alice.id), 'Paris');
});

test('final: drafts survive a pause and may be typed during it', (t) => {
  const { engine, alice } = finalQuestion(t);
  engine.saveDraft(alice.id, 'Madrid');
  engine.pause();
  engine.saveDraft(alice.id, 'Berlin');
  engine.resume();
  engine.closeFinal();
  assert.equal(engine.finalAnswers.get(alice.id), 'Berlin');
});

test('final: an empty draft clears, and bad drafts are refused', (t) => {
  const { room, engine, host, alice } = finalQuestion(t);
  engine.saveDraft(alice.id, 'Lyon');
  engine.saveDraft(alice.id, '   ');
  assert.throws(() => engine.saveDraft(alice.id, 'x'.repeat(351)), /at most 350/);
  assert.throws(() => engine.saveDraft(host.id, 'Host text'), /not playing this final/);
  const late = room.join('Late').participant;
  room.attach(late.id, 'late');
  assert.throws(() => engine.saveDraft(late.id, 'Late text'), /not playing this final/);
  engine.closeFinal();
  assert.equal(engine.finalAnswers.has(alice.id), false);
  assert.throws(() => engine.saveDraft(alice.id, 'Too late'), /Answers are closed/);
});

test('final: a judged finalist cannot leave a draft', (t) => {
  const { engine, alice } = finalQuestion(t);
  engine.finalJudged.add(alice.id); // auto-zeroed, e.g. removed and re-added
  assert.throws(() => engine.saveDraft(alice.id, 'Lyon'), /not playing this final/);
});

test('drafts never appear in any snapshot', (t) => {
  const { room, engine, host, alice, bob } = finalQuestion(t);
  engine.saveDraft(alice.id, 'SecretDraftText');
  for (const viewer of [host, alice, bob]) {
    assert.equal(JSON.stringify(room.snapshotFor(viewer.id)).includes('SecretDraftText'), false, viewer.name);
  }
});

test('for-all: a draft fills an empty answer at close, a sent answer is kept', (t) => {
  const { engine, alice, bob } = forAllAnswering(t);
  engine.saveDraft(alice.id, 'Draft A');
  engine.submitForAllAnswer(bob.id, 'Sent B');
  assert.equal(engine.phase, 'forAllAnswering', 'a draft never counts as answered');
  assert.throws(() => engine.saveDraft(bob.id, 'Late B'), /cannot answer/);
  engine.closeForAllAnswers();
  assert.equal(engine.forAll.answers.get(alice.id), 'Draft A');
  assert.equal(engine.forAll.answers.get(bob.id), 'Sent B');
});

test('for-all: drafts from one question never reach the next', (t) => {
  const { engine, alice } = forAllAnswering(t);
  engine.saveDraft(alice.id, 'Old');
  engine.closeForAllAnswers();
  assert.equal(engine.drafts.size, 0, 'closing uses or drops every draft');
  engine.reset();
  assert.equal(engine.drafts.size, 0);
});

class FakeSocket extends EventEmitter {
  constructor(id) { super(); this.id = id; this.data = {}; this.handshake = { address: '127.0.0.1' }; this.received = []; }
  join() {}
  leave() {}
  disconnect() { this.emit('disconnect'); }
}

test('game:draft is quiet: saved without a room-wide snapshot', async (t) => {
  const room = new Room();
  cleanup(t, room);
  let onConnection;
  const sockets = new Map();
  const io = {
    sockets: { sockets },
    on(event, callback) { if (event === 'connection') onConnection = callback; },
    to(id) { return { emit(event, payload) { sockets.get(id)?.received.push([event, payload]); } }; },
  };
  registerSocketHandlers(io, room);
  const connect = (id) => { const s = new FakeSocket(id); sockets.set(id, s); onConnection(s); return s; };
  const send = (socket, event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));
  const hostSocket = connect('host');
  await send(hostSocket, 'session:join', { nickname: 'Host' });
  await send(hostSocket, 'role:choose', { role: 'host' });
  const playerSocket = connect('player');
  await send(playerSocket, 'session:join', { nickname: 'Alice' });
  const pack = structuredClone(loaded.pack);
  pack.rounds[2].themes = [pack.rounds[2].themes[0]];
  room.setPack({ ...loaded, pack });
  const engine = room.engine;
  const alice = room.participants.get(playerSocket.data.pid);
  engine.start();
  alice.score = 500;
  engine.enterRound(2);
  if (engine.phase === 'board') engine.selectQuestion(hostSocket.data.pid, true, 0, 0);
  engine.setFinalWager(alice.id, 100);
  engine.openFinal();

  await new Promise((resolve) => setTimeout(resolve, 50)); // let earlier joins settle
  let changes = 0;
  room.on('change', () => { changes++; });
  const reply = await send(playerSocket, 'game:draft', { text: 'Lyon' });
  assert.equal(reply.ok, true);
  await new Promise(setImmediate);
  assert.equal(changes, 0, 'no room change for a draft');
  assert.equal(engine.drafts.get(alice.id), 'Lyon');
  assert.equal(engine.phase, 'finalQuestion');
  const refused = await send(hostSocket, 'game:draft', { text: 'Host' });
  assert.equal(refused.ok, false);
  // Clearing the only finalist's edit after sending closes the final: that one is broadcast.
  engine.submitFinalAnswer(alice.id, 'Paris');
  assert.equal(engine.phase, 'finalJudge', 'a lone finalist with no edit closes at once');
});

test('client draft sender: debounced, deduplicated, retried, reset per question', async () => {
  const { createDraftSender } = await import('../client/src/draftSender.ts');
  const sent = [];
  let online = true;
  const drafts = createDraftSender((text) => { if (!online) return false; sent.push(text); return true; }, 5);
  drafts.update('q1', 'Ly');
  drafts.update('q1', 'Lyon ');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent, ['Lyon'], 'only the last text after the pause goes out, trimmed');
  drafts.update('q1', 'Lyon');
  drafts.flush();
  assert.deepEqual(sent, ['Lyon'], 'unchanged text is not resent');
  online = false;
  drafts.update('q1', 'Paris');
  drafts.flush();
  online = true;
  drafts.flush();
  assert.deepEqual(sent, ['Lyon', 'Paris'], 'a send that could not go out is retried');
  drafts.submitted('q1', 'Rome');
  drafts.update('q1', 'Rome');
  drafts.flush();
  assert.deepEqual(sent, ['Lyon', 'Paris'], 'text equal to the sent answer needs no draft');
  drafts.update('q2', 'Paris');
  drafts.flush();
  assert.deepEqual(sent, ['Lyon', 'Paris', 'Paris'], 'a new question starts fresh');
});
