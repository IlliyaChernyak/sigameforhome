/**
 * The host seats, unseats and removes people at any moment of the game, also mid-question. The
 * engine moves on whatever turn the seat held, and a player cannot leave their seat to dodge one.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { INSTANT_BUZZER } from './test-settings.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'sigame-host-seating-'));
process.env.PACKS_DIR = path.join(root, 'packs');
process.env.CACHE_DIR = path.join(root, 'cache');
await import('./make-sample-pack.ts');
const [{ Room }, { loadPack }] = await Promise.all([
  import('../server/game/Room.ts'), import('../server/packs/packManager.ts'),
]);
const loaded = await loadPack('Demo pack (v5 format).siq');
after(async () => rm(root, { recursive: true, force: true }));

/** The sample pack's third question in each theme is a secret one. */
const SECRET = 2;

/** Host plus Alice, Bob and Cara in a started game on the board, Alice holding 300 points. */
function started(t) {
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
  room.engine.start();
  players[0].score = 300;
  return { room, host, players, engine: room.engine };
}

/** Alice buzzes in on the first question and is answering. */
function aliceAnswering(t) {
  const setup = started(t);
  const { engine, host, players: [alice] } = setup;
  engine.selectQuestion(host.id, true, 0, 0);
  engine.openBuzzer();
  engine.buzz(alice.id);
  assert.equal(engine.phase, 'answering');
  return setup;
}

test('the host moves the answerer to spectators: no penalty, the buttons reopen for the others', (t) => {
  const { room, host, engine, players: [alice] } = aliceAnswering(t);
  room.setRole(host.id, alice.id, 'spectator');
  assert.equal(alice.role, 'spectator');
  assert.equal(alice.score, 300, 'the score stays with them');
  assert.equal(engine.phase, 'buzzerOpen');
  assert.equal(engine.buzzer.winnerId, null);
});

test('the host removes the answerer mid-answer and the question moves on', (t) => {
  const { room, host, engine, players: [alice] } = aliceAnswering(t);
  room.kick(host.id, alice.id);
  assert.equal(room.participants.has(alice.id), false);
  assert.equal(engine.phase, 'buzzerOpen');
});

test('a player cannot leave their own seat while they owe an answer', (t) => {
  const { room, engine, players: [alice, bob] } = aliceAnswering(t);
  assert.throws(() => room.setRole(alice.id, alice.id, 'spectator'), /Wait until the question is over/);
  room.setRole(bob.id, bob.id, 'spectator');
  assert.equal(bob.role, 'spectator', 'someone without a turn may still step out');
  assert.equal(engine.buzzer.winnerId, alice.id);
});

test('an assigned player unseated before their turn: the answer shows, nobody answers', (t) => {
  const { room, host, engine, players: [alice] } = started(t);
  engine.selectQuestion(host.id, true, 0, SECRET);
  assert.equal(engine.phase, 'specialSetup');
  engine.configureSpecial(alice.id);
  engine.chooseSpecialPrice(alice.id, 100);
  assert.throws(() => room.setRole(alice.id, alice.id, 'spectator'), /Wait until the question is over/);
  room.setRole(host.id, alice.id, 'spectator');
  engine.openBuzzer();
  assert.equal(engine.phase, 'reveal');
  assert.equal(alice.score, 300);
});

test('the host seats a spectator and gives an offline seat back mid-question', (t) => {
  const { room, host, engine, players: [alice, bob] } = aliceAnswering(t);
  room.setRole(host.id, bob.id, 'spectator');
  room.setRole(host.id, bob.id, 'player');
  assert.equal(bob.role, 'player');

  room.detach(alice.id, 'player-0');
  assert.equal(engine.buzzer.winnerId, alice.id, 'an offline answerer keeps the turn');
  const newcomer = room.join('Alice 2').participant;
  room.attach(newcomer.id, 'alice-new');
  room.giveSeat(host.id, alice.id, newcomer.id);
  assert.equal(alice.connected, true);
  assert.equal(engine.buzzer.winnerId, alice.id, 'the given seat keeps its turn');
});

test('the host appoints a player to an empty host seat mid-question; a player claiming it waits', (t) => {
  const { room, host, players: [alice, bob] } = aliceAnswering(t);
  room.remove(host.id);
  // With no host the owner (the first seated player) stands in and may moderate.
  assert.equal(room.ownerId, alice.id);
  assert.throws(() => room.setRole(bob.id, bob.id, 'host'), /Wait until the question is over/);
  room.setRole(alice.id, bob.id, 'host');
  assert.equal(room.host()?.id, bob.id);
});

test('unseating the last unjudged finalist closes the final', (t) => {
  const { room, host, engine, players: [alice, bob] } = started(t);
  bob.score = 200;
  engine.enterRound(2);
  while (engine.phase === 'finalThemes') engine.removeFinalTheme(host.id, true, engine.finalThemeIndices()[0]);
  engine.setFinalWager(alice.id, 100);
  engine.setFinalWager(bob.id, 100);
  engine.openFinal();
  engine.closeFinal();
  engine.judgeFinal(bob.id, true);
  assert.equal(engine.phase, 'finalJudge');
  room.setRole(host.id, alice.id, 'spectator');
  assert.equal(engine.phase, 'reveal');
});

test('the host sets an exact score, 0 included; nobody else can', (t) => {
  const { room, host, players: [alice, bob] } = started(t);
  room.setScore(host.id, alice.id, 0);
  assert.equal(alice.score, 0);
  room.setScore(host.id, alice.id, -400);
  assert.equal(alice.score, -400);
  assert.throws(() => room.setScore(bob.id, alice.id, 0), /Only the host/);
  assert.throws(() => room.setScore(host.id, alice.id, 1.5), /whole number/);
});
