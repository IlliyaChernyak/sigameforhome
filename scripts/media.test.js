/** Focused media gate and codec-probe regressions. Run with node --test scripts/media.test.js. */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import AdmZip from 'adm-zip';
import { Room } from '../server/game/Room.ts';
import { ContentPresenter } from '../client/src/contentPresenter.ts';
import { ensureIosCompatibleMedia, MAX_CONCURRENT_TRANSCODES, needsIosVideoTranscode,
  runTranscodeTask } from '../server/packs/mediaTranscoder.ts';
import { collectHtmlAssets } from '../server/packs/htmlAssets.ts';
import { parseSiq } from '../server/packs/siqParser.ts';

test('partial text reveals at reading speed and survives pause and refresh', async () => {
  const rendered = [];
  let visible = '';
  let finished = false;
  const presenter = new ContentPresenter([{ type: 'text', value: 'ABCD' }],
    (_item, _index, _active, _replay, _done) => {
      rendered.push('render');
      return (text) => { visible = text; };
    }, () => { finished = true; }, 0, 10);
  presenter.start();
  assert.equal(visible, '');
  const deadline = Date.now() + 500;
  while (!visible && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(visible.length > 0 && visible.length < 4);
  presenter.setPaused(true);
  const pausedText = visible;
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(visible, pausedText);
  presenter.refresh();
  assert.equal(visible, pausedText);
  assert.equal(rendered.length, 2);
  presenter.setPaused(false);
  const finishDeadline = Date.now() + 600;
  while (!finished && Date.now() < finishDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(visible, 'ABCD');
  assert.equal(finished, true);
  presenter.dispose();
});

test('ordered content waits for media end, preserves pause, and ignores stale playback after refresh', async () => {
  const shown = [];
  const completions = [];
  let finished = 0;
  const presenter = new ContentPresenter([
    { type: 'text' },
    { type: 'video', waitForFinish: true },
    { type: 'image', duration: 0.02 },
  ], (item, index, active, replay, done) => {
    shown.push([index, active, replay]);
    if (item.type === 'video' && active) completions.push(done);
  }, () => { finished++; }, 10);
  presenter.start();
  const deadline = Date.now() + 500;
  while (shown.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(shown.slice(0, 2), [[0, true, false], [1, true, false]]);
  presenter.setPaused(true);
  completions[0]();
  assert.equal(finished, 0);
  presenter.refresh();
  assert.deepEqual(shown.slice(-2), [[0, false, true], [1, true, true]]);
  presenter.setPaused(false);
  // The old media element cannot advance the replacement presentation.
  assert.equal(shown.filter(([index, active]) => index === 2 && active).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(finished, 1);
  assert.equal(presenter.isFinished, true);
  presenter.dispose();
});

test('a screen that starts late runs the script on the shared timeline and catches up', async () => {
  const shown = [];
  const origin = Date.now() - 1000; // the room started this script a second ago
  const presenter = new ContentPresenter([
    { type: 'image', duration: 0.5 },
    { type: 'audio' },
  ], (item, index, active) => { if (active) shown.push([index, Date.now()]); }, () => {}, 0);
  presenter.start(origin);
  const deadline = Date.now() + 300;
  while (shown.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(shown.length, 2, 'the overdue picture step is skipped at once');
  // The clip was due half a second in, so the player seeks it to where the room is.
  assert.equal(presenter.startOf(1), origin + 500);
  presenter.dispose();
});

test('a pause moves the shared timeline later by its length, and a future start waits', async () => {
  const shown = [];
  const origin = Date.now() + 60;
  const presenter = new ContentPresenter([{ type: 'image', duration: 0.05 }, { type: 'audio' }],
    (item, index, active) => { if (active) shown.push(index); }, () => {}, 0);
  presenter.start(origin);
  assert.equal(presenter.startOf(0), origin);
  presenter.setPaused(true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(shown, [0], 'nothing advances while paused');
  presenter.setPaused(false);
  const moved = presenter.startOf(0) - origin;
  assert.ok(moved >= 140 && moved < 400, `the start moved by the pause (${moved} ms)`);
  const deadline = Date.now() + 500;
  while (shown.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(presenter.startOf(1), presenter.startOf(0) + 50);
  presenter.dispose();
});

test('distinct transcodes share a process-wide concurrency limit', async () => {
  let running = 0;
  let peak = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const count = MAX_CONCURRENT_TRANSCODES + 3;
  const jobs = Array.from({ length: count }, (_, index) => runTranscodeTask(async () => {
    running++;
    peak = Math.max(peak, running);
    await gate;
    running--;
    return index;
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(running, MAX_CONCURRENT_TRANSCODES);
  release();
  assert.deepEqual(await Promise.all(jobs), Array.from({ length: count }, (_, index) => index));
  assert.equal(peak, MAX_CONCURRENT_TRANSCODES);
  assert.equal(running, 0);

  await assert.rejects(runTranscodeTask(async () => { throw new Error('conversion failed'); }),
    /conversion failed/);
  assert.equal(await runTranscodeTask(async () => 'next conversion'), 'next conversion');
});

test('pack media names that collide on disk are rejected before extraction', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigame-media-collision-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const packFile = path.join(dir, 'collision.siq');
  const zip = new AdmZip();
  zip.addFile('content.xml', Buffer.from(
    '<package name="Collision" version="5"><rounds><round name="R"><themes><theme name="T"><questions><question price="100"><params><param name="question" type="content"><item type="image" isRef="True">a:b.png</item></param><param name="answer" type="content"><item type="image" isRef="True">a?b.png</item></param></params><right><answer>secret</answer></right></question></questions></theme></themes></round></rounds></package>',
  ));
  zip.addFile('Images/a:b.png', Buffer.from('question'));
  zip.addFile('Images/a?b.png', Buffer.from('answer'));
  zip.writeZip(packFile);
  await assert.rejects(parseSiq(packFile, { mediaBaseUrl: '/media/pack', extractTo: path.join(dir, 'cache') }), /collid/i);
});

test('codec tags split across read chunks are still detected', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigame-media-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clip.mp4');
  const data = Buffer.alloc(64 * 1024 + 8);
  data.write('avc1', 0, 'latin1');
  data.write('av01', 64 * 1024 - 2, 'latin1');
  await fsp.writeFile(file, data);
  assert.equal(await needsIosVideoTranscode(file), true);

  data.fill(0, 64 * 1024 - 2, 64 * 1024 + 2);
  await fsp.writeFile(file, data);
  assert.equal(await needsIosVideoTranscode(file), false);

  // An avc1 string in metadata must not make an HEVC video look like H.264.
  data.write('hvc1', 64 * 1024 - 2, 'latin1');
  await fsp.writeFile(file, data);
  assert.equal(await needsIosVideoTranscode(file), true);

  const forgedAdjacent = `${file}.ios.mp4`;
  await fsp.writeFile(forgedAdjacent, 'pack-authored collision');
  const derivative = path.join(dir, '_derived', 'clip.mp4.ios.mp4');
  await fsp.mkdir(path.dirname(derivative), { recursive: true });
  await fsp.writeFile(derivative, 'already converted');
  assert.equal(await ensureIosCompatibleMedia(file, dir), derivative);
});

test('media tickets authorize only visible items and their matching derivatives', () => {
  const room = new Room();
  const host = room.join('Host').participant;
  room.attach(host.id, 'host-socket');
  room.chooseInitialRole(host.id, 'host');
  const player = room.join('Player').participant;
  room.attach(player.id, 'player-socket');

  const image = '/media/pack/Images/visible.jpg';
  const answer = `${image}.ios.mp4`;
  const video = '/media/pack/Video/clip.webm';
  const audio = '/media/pack/Audio/clip.ogg';
  room.loadedPack = { pack: { logo: null } };
  room.engine.current = {
    type: 'simple',
    answerShown: false,
    question: {
      content: [
        { type: 'image', url: image },
        { type: 'video', url: video },
        { type: 'audio', url: audio },
      ],
      answerContent: [{ type: 'image', url: answer }],
    },
  };
  room.engine.phase = 'reading';

  assert.equal(room.canAccessMedia(player.mediaTicket, image), true);
  assert.equal(room.canAccessMedia(player.mediaTicket, answer), false);
  assert.equal(room.canAccessMedia(host.mediaTicket, answer), true);
  assert.equal(room.canAccessMedia(player.mediaTicket, `${video}.ios.mp4`), false);
  assert.equal(room.canAccessMedia(player.mediaTicket, '/media/pack/_derived/Video/clip.webm.ios.mp4'), true);
  assert.equal(room.canAccessMedia(player.mediaTicket, '/media/pack/_derived/Audio/clip.ogg.ios.mp3'), true);
  assert.equal(room.canAccessMedia(player.mediaTicket, `${video}.ios.mp3`), false);
  assert.equal(room.canAccessMedia('', video), false);

  const oldHostTicket = host.mediaTicket;
  room.detach(host.id, 'host-socket');
  assert.equal(room.canAccessMedia(oldHostTicket, answer), false);
  room.attach(host.id, 'host-reconnected');
  assert.notEqual(host.mediaTicket, oldHostTicket);
  assert.equal(room.canAccessMedia(oldHostTicket, answer), false);
  assert.equal(room.canAccessMedia(host.mediaTicket, answer), true);

  room.engine.phase = 'stakeAuction';
  assert.equal(room.canAccessMedia(player.mediaTicket, video), false);
  room.engine.phase = 'paused';
  room.engine.paused = { phase: 'stakeAuction' };
  assert.equal(room.canAccessMedia(player.mediaTicket, video), false);
  room.remove(player.id);
  assert.equal(room.canAccessMedia(player.mediaTicket, video), false);
  room.engine.reset();
});

test('HTML media grants only its static relative assets while visible', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sigame-html-media-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'html.siq');
  const cache = path.join(dir, 'cache');
  const zip = new AdmZip();
  zip.addFile('content.xml', Buffer.from('<package name="HTML"><rounds><round name="R"><themes><theme name="T"><questions><question price="100"><params><param name="question" type="content"><item type="html" isRef="True">card.html</item></param><param name="answer" type="content"><item type="image" isRef="True">secret.png</item></param></params></question></questions></theme></themes></round></rounds></package>'));
  zip.addFile('Html/card.html', Buffer.from('<link rel="stylesheet" href="style.css"><img src="visible.png"><!-- <img src="secret.png"> --><template><img src="secret.png"></template><script><img src="secret.png"></script><style>/* url(secret.png) */</style>'));
  zip.addFile('Html/style.css', Buffer.from('body { background: url("bg.png") } /* url(secret.png) */'));
  zip.addFile('Html/visible.png', Buffer.from('visible'));
  zip.addFile('Html/bg.png', Buffer.from('background'));
  zip.addFile('Html/secret.png', Buffer.from('hidden answer'));
  zip.writeZip(file);
  const pack = await parseSiq(file, { mediaBaseUrl: '/media/pack', extractTo: cache });
  const htmlAssets = await collectHtmlAssets(pack, cache, 'pack');

  const room = new Room();
  const player = room.join('Player').participant;
  room.attach(player.id, 'player-socket');
  room.loadedPack = { packId: 'pack', file: 'html.siq', pack, htmlAssets };
  room.engine.current = { type: 'simple', answerShown: false, question: pack.rounds[0].themes[0].questions[0] };
  room.engine.phase = 'reading';
  const html = '/media/pack/Html/card.html';
  assert.equal(room.mediaUrl(html, player, 'html'), `/media-html/${player.mediaTicket}/pack/Html/card.html`);
  for (const asset of ['style.css', 'visible.png', 'bg.png']) {
    assert.equal(room.canAccessMedia(player.mediaTicket, `/media/pack/Html/${asset}`), true);
  }
  assert.equal(room.canAccessMedia(player.mediaTicket, '/media/pack/Html/secret.png'), false);
  const oldTicket = player.mediaTicket;
  room.detach(player.id, 'player-socket');
  room.attach(player.id, 'reconnected');
  assert.equal(room.canAccessMedia(oldTicket, html), false);
  room.engine.phase = 'paused';
  room.engine.paused = { phase: 'stakeAuction' };
  assert.equal(room.canAccessMedia(player.mediaTicket, '/media/pack/Html/visible.png'), false);
  room.engine.reset();
});
