import { io, type Socket } from 'socket.io-client';
import { askConfirm, type ConfirmOptions } from './confirmDialog';
import { ContentPresenter } from './contentPresenter';
import { avatar, formatScore, questionTypeLabel, replicFor, roleLabels, sayReplic, toast, type ReplicTone } from './ui';
import { audioCue, drawPins, drawRing, fitText, imageFrame, makePickable, optionText, optionTiles, parsePoint,
  setBackdrop, type Pin } from './stageParts';
import { buzzerView, createPressTracker, phaseLabel } from './buzzerFeedback';
import { createConnectionMonitor, noticeText } from './connection';
import { fullscreenSupported, toggleFullscreen } from './fullscreen';
import { betweenQuestions, giveSeatForm, removeConfirmBody, renameForm, unreadyPlayers } from './seatActions';
import { inviteChoices, resultsText } from './sharing';
import { setupKeepAwake } from './wakeLock';
import { releasePointerFocus } from './pointerFocus';
import { createDraftSender } from './draftSender';
import { auctionTurnHint, formatReaction } from './statusText';
import { hostBannerText } from './hostBanner';
import { keepInViewport } from './keepInViewport';
import { addSteppers } from './numberStepper';
import { lang, serverText, setLang, t, tn, translatePage, type Lang } from './i18n';
import type { Ack, ClientToServerEvents, CommandEvent, CommandPayloads, ContentItem,
  GameEvent, JoinAck, NoPayloadCommand, PackListItem, RoomState, ServerToClientEvents } from './types';

/* Client UI with clear reading/buzzer orientiers & pre-game falseStart setting. */
(() => {
  // Before anything reads labels from the page, so they already carry the device's language.
  translatePage();

  function $(selector: string): HTMLElement {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) throw new Error(`Missing UI element: ${selector}`);
    return element;
  }

  function input(selector: string): HTMLInputElement {
    const element = $(selector);
    if (!(element instanceof HTMLInputElement)) throw new Error(`Expected input: ${selector}`);
    return element;
  }

  function textarea(selector: string): HTMLTextAreaElement {
    const element = $(selector);
    if (!(element instanceof HTMLTextAreaElement)) throw new Error(`Expected textarea: ${selector}`);
    return element;
  }

  function select(selector: string): HTMLSelectElement {
    const element = $(selector);
    if (!(element instanceof HTMLSelectElement)) throw new Error(`Expected select: ${selector}`);
    return element;
  }

  function button(selector: string): HTMLButtonElement {
    const element = $(selector);
    if (!(element instanceof HTMLButtonElement)) throw new Error(`Expected button: ${selector}`);
    return element;
  }

  type ActiveRoomState = RoomState & { you: NonNullable<RoomState['you']> };
  const hasActivePlayer = (value: RoomState | null): value is ActiveRoomState => value?.you != null;
  function activeState(): ActiveRoomState {
    if (!hasActivePlayer(state)) throw new Error('Game state is not ready');
    return state;
  }

  const controlCommands = new Set<string>([
    'game:pause', 'game:resume', 'game:openBuzzer', 'game:reveal',
    'game:next', 'game:prevRound', 'game:nextRound', 'game:stop', 'game:closeForAll', 'game:appealClose',
    'game:passAnswer',
  ] satisfies NoPayloadCommand[]);
  const isNoPayloadCommand = (value: string): value is NoPayloadCommand => controlCommands.has(value);
  const tvMode = new URLSearchParams(location.search).has('tv');
  const TOKEN_KEY = tvMode ? 'sigame.tv.token' : 'sigame.token';
  if (tvMode) document.body.classList.add('tv-mode');
  // tryAllTransports: fall back to polling when a network blocks WebSockets (audit CONN-7).
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({ transports: ['websocket', 'polling'], tryAllTransports: true });
  const buzzPress = createPressTracker(() => updateOrientiers());
  // Keep the screen on during play (QOL-1): native where allowed, opt-in video elsewhere.
  const refreshKeepAwake = setupKeepAwake({ toggle: $('#keep-awake') as HTMLLabelElement, checkbox: input('#pref-keepAwake'),
    isGameRunning: () => !!state && !['lobby', 'gameOver'].includes(state.game.phase) });
  // A cold-cache pack load can take minutes; 8 s reported "outcome unknown" and invited a second click (audit UX-1).
  const slowCommandMs: Partial<Record<CommandEvent, number>> = { 'packs:load': 120_000, 'packs:list': 120_000 };

  let state: RoomState | null = null;
  let clockOffset = 0; // serverTime - Date.now()
  let bestRtt = Infinity;
  // Typical round trip, sent with each probe so the server can fit the buzzer open lead and
  // comparison window to the slowest phone (server/game/buzzTiming.ts).
  let smoothRtt: number | null = null;
  let actionUncertain = false;
  const uncertainActionMessage = t('Action outcome unknown. It may still have applied; check the game state before retrying.');
  const unsentActionMessage = t('Action was not sent. Reconnect before trying again.');

  // Lowest-latency samples give client timestamps a stable server clock estimate.
  function syncClockSample() {
    if (!socket.connected) return;
    const sentAt = Date.now();
    socket.emit('clock:ping', smoothRtt == null ? {} : { rtt: Math.round(smoothRtt) }, (res) => {
      if (!res?.ok || !Number.isFinite(res.serverTime)) return;
      const receivedAt = Date.now();
      const rtt = receivedAt - sentAt;
      smoothRtt = smoothRtt == null ? rtt : smoothRtt * 0.7 + rtt * 0.3;
      const sampleOffset = res.serverTime + rtt / 2 - receivedAt;
      if (rtt <= bestRtt) {
        bestRtt = rtt;
        clockOffset = sampleOffset;
      } else if (rtt <= bestRtt * 1.5 + 10) {
        // A slow sample's offset can be wrong by half its extra delay (uneven up/down links), so
        // only near-best samples refine the estimate; blending every sample let jitter creep in.
        clockOffset = clockOffset * 0.8 + sampleOffset * 0.2;
      }
    });
  }

  async function calibrateClockBurst() {
    bestRtt = Infinity;
    // A reconnect may be on another network; measure the round trip afresh.
    smoothRtt = null;
    for (let i = 0; i < 4; i++) {
      syncClockSample();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  setInterval(syncClockSample, 8000);

  /* ---------------- Volume ---------------- */
  // Each device keeps its own level, so a loud TV and a quiet phone can share one room.
  const VOLUME_KEY = 'sigame.volume';
  let volume = 1;
  try {
    const saved = localStorage.getItem(VOLUME_KEY);
    if (saved !== null && Number.isFinite(Number(saved))) volume = Math.min(1, Math.max(0, Number(saved)));
  } catch { /* Private mode: keep full volume. */ }
  // iPhone and iPad ignore media.volume, so same-origin clips play through a Web Audio gain instead.
  let masterGain: GainNode | null = null;
  const routedMedia = new WeakSet<HTMLMediaElement>();
  function routeThroughVolume(el: HTMLMediaElement, url: string) {
    el.volume = volume;
    // A suspended context would silence the clip, and cross-origin clips play silent through Web Audio.
    if (!audioCtx || audioCtx.state !== 'running' || new URL(url, location.href).origin !== location.origin) return;
    try {
      if (!masterGain) {
        masterGain = audioCtx.createGain();
        masterGain.connect(audioCtx.destination);
      }
      audioCtx.createMediaElementSource(el).connect(masterGain);
      masterGain.gain.value = volume;
      el.volume = 1; // The gain does the work; also lowering the element would square the level.
      routedMedia.add(el);
    } catch { /* Keep the plain element volume. */ }
  }
  // With "Sound on host and TV only" the room hears one speaker instead of every phone out of sync.
  const playsSoundHere = () => !state?.settings.soundOnHostOnly || tvMode || state.you?.role === 'host';
  function applyVolume() {
    if (masterGain) masterGain.gain.value = volume;
    for (const media of questionMedia()) media.volume = routedMedia.has(media) ? 1 : volume;
    input('#volume-range').value = String(Math.round(volume * 100));
    // The filled part of the track is painted from this, since only Firefox styles range progress natively.
    input('#volume-range').style.setProperty('--fill', `${Math.round(volume * 100)}%`);
    $('#volume-value').textContent = `${Math.round(volume * 100)}%`;
    button('#btn-volume').dataset.icon = volume === 0 ? 'mute' : 'volume';
    const mute = button('#volume-mute');
    mute.dataset.icon = volume === 0 ? 'volume' : 'mute';
    mute.title = volume === 0 ? t('Unmute') : t('Mute');
    mute.querySelector('.label')!.textContent = mute.title;
  }
  function setVolume(next: number) {
    volume = Math.min(1, Math.max(0, next));
    try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* Not saved; still applies now. */ }
    applyVolume();
  }
  // Mute remembers the last level, so unmuting returns to it instead of to full blast.
  let volumeBeforeMute = volume || 1;
  input('#volume-range').addEventListener('input', () => setVolume(Number(input('#volume-range').value) / 100));
  button('#volume-mute').onclick = () => {
    if (volume > 0) { volumeBeforeMute = volume; setVolume(0); } else setVolume(volumeBeforeMute);
  };
  button('#btn-volume').onclick = (event) => {
    event.stopPropagation();
    const open = $('#volume-pop').classList.toggle('hidden') === false;
    button('#btn-volume').setAttribute('aria-expanded', String(open));
    // On a phone the speaker sits mid-bar, so the right-aligned menu ran off the left edge.
    if (open) keepInViewport($('#volume-pop'));
  };
  document.addEventListener('click', (event) => {
    if (!(event.target as Element).closest?.('.volume')) {
      $('#volume-pop').classList.add('hidden');
      button('#btn-volume').setAttribute('aria-expanded', 'false');
    }
  });

  /* ---------------- Web Audio cues ---------------- */
  let audioCtx: AudioContext | null = null;
  // Mobile browsers require audio to be unlocked during a user gesture.
  const unlockAudio = () => {
    try {
      audioCtx ??= new AudioContext();
      void audioCtx.resume().catch(() => {});
    } catch { /* audio is optional */ }
  };
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });
  function playTone(freq: number, durationMs: number, type: OscillatorType = 'sine', secondFreq: number | null = null) {
    try {
      audioCtx ??= new AudioContext();
      if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => {});
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      if (secondFreq) {
        osc.frequency.setValueAtTime(secondFreq, audioCtx.currentTime + durationMs / 2000);
      }
      if (volume === 0) return;
      gain.gain.setValueAtTime(0.14 * volume, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + durationMs / 1000);
    } catch {
      /* audio not unlocked yet */
    }
  }

  function send<Event extends keyof CommandPayloads>(event: Event, payload: CommandPayloads[Event]): Promise<Ack>;
  function send(event: NoPayloadCommand): Promise<Ack>;
  function send(event: CommandEvent, payload: Record<string, unknown> = {}): Promise<Ack> {
    if (!socket.connected) {
      if (!actionUncertain) $('#connection-status').textContent = unsentActionMessage;
      return Promise.resolve({ ok: false, error: unsentActionMessage });
    }
    // Overloads check each command at call sites; this cast only joins their union for Socket.IO.
    const emit = socket.emit.bind(socket) as
      (name: CommandEvent, data: Record<string, unknown>, ack: (result: Ack) => void) => void;
    return new Promise((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: Ack, uncertain = false) => {
        if (settled) return; // A late acknowledgement must not show a second result.
        settled = true;
        if (timeout) clearTimeout(timeout);
        socket.off('disconnect', onDisconnect);
        if (uncertain) {
          actionUncertain = true;
          $('#connection-status').textContent = uncertainActionMessage;
        } else if (!result.ok) {
          toast(result.error ? serverText(result.error) : t('Request failed'));
        } else if (actionUncertain) {
          actionUncertain = false;
          $('#connection-status').textContent = '';
        }
        resolve(result);
      };
      const onDisconnect = () => finish({ ok: false, error: uncertainActionMessage }, true);
      socket.once('disconnect', onDisconnect);
      timeout = setTimeout(() => finish({ ok: false, error: uncertainActionMessage }, true), slowCommandMs[event] ?? 8000);
      emit(event, payload, (result) => finish(result ?? { ok: false, error: t('Request failed') }));
    });
  }

  const show = (id: string) => {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
  };

  const nowServer = () => Date.now() + clockOffset;
  /** The buttons are open on the server but the scheduled green signal has not come yet. */
  const signalPending = (game: RoomState['game']) =>
    game.phase === 'buzzerOpen' && nowServer() < (game.buzzer.openedAt ?? 0);

  /* ---------------- session ---------------- */

  socket.on('connect', () => {
    void calibrateClockBurst();
    $('#connection-status').textContent = actionUncertain ? uncertainActionMessage : '';
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      if (tvMode) {
        socket.emit('session:join', { nickname: `TV ${Math.floor(Math.random() * 10000)}`, asSpectator: true }, (res: JoinAck) => {
          if (res.ok) { localStorage.setItem(TOKEN_KEY, res.token); syncClockSample(); }
          else { show('screen-join'); $('#join-error').textContent = serverText(res.error); }
        });
        return;
      }
      return show('screen-join');
    }
    socket.emit('session:resume', { token }, (res: { resumed?: boolean }) => {
      // Probes sent before the seat was bound carry no round trip for the buzzer; send one now.
      if (res?.resumed) syncClockSample();
      else {
        localStorage.removeItem(TOKEN_KEY);
        actionUncertain = false;
        $('#connection-status').textContent = '';
        if (tvMode) location.reload();
        else {
          $('#join-error').textContent = t('Previous session expired. Join again.');
          show('screen-join');
        }
      }
    });
  });
  socket.on('disconnect', () => {
    // Reconnection rotates media tickets, so rebuild the question with fresh URLs.
    renderedQuestionKey = null;
    presenterAckingId = null;
    $('#connection-status').textContent = actionUncertain
      ? uncertainActionMessage : t('Disconnected — reconnecting…');
  });
  // Wake probe, "open on another tab" and "can't reach the server" (audits CONN-3, CONN-5, CONN-6).
  const connection = createConnectionMonitor(socket, { onNotice: (notice) => {
    $('#connection-notice').hidden = notice === 'none';
    $('#connection-notice-text').textContent = notice === 'none' ? '' : noticeText[notice];
    $('#connection-reclaim').hidden = notice !== 'otherTab';
    if (notice === 'otherTab') $('#connection-status').textContent = ''; // it will not reconnect by itself
  } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) connection.hidden(); else void connection.visible(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) void connection.restored(); });
  $('#connection-reclaim').addEventListener('click', () => connection.reclaim());

  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#join-error').textContent = '';
    // The role picker can take a second to appear; a busy button stops a second tap from joining twice.
    const submit = $('#join-form').querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const label = submit.textContent;
    submit.disabled = true;
    submit.textContent = t('Joining…');
    // A lost reply must not leave the button stuck on "Joining…".
    socket.timeout(8000).emit('session:join', { nickname: input('#nickname').value }, (err: Error | null, res: JoinAck) => {
      submit.disabled = false;
      submit.textContent = label;
      if (err) return ($('#join-error').textContent = t('No reply from the game. Check the connection and try again.'));
      if (!res.ok) return ($('#join-error').textContent = serverText(res.error));
      localStorage.setItem(TOKEN_KEY, res.token);
      syncClockSample();
    });
  });

  for (const b of document.querySelectorAll<HTMLElement>('[data-role]')) {
    b.addEventListener('click', () => {
      const role = b.dataset.role;
      if (role === 'host' || role === 'player') send('role:choose', { role });
    });
  }

  socket.on('session:kicked', () => {
    localStorage.removeItem(TOKEN_KEY);
    actionUncertain = false;
    $('#connection-status').textContent = '';
    toast(t('The host removed you from the room.'));
    show('screen-join');
  });

  async function leaveRoom() {
    // Leaving frees the seat for good: rejoining makes a new player at 0. Say so while points are at stake.
    const me = state?.participants.find((p) => p.id === state?.you?.id);
    const inGame = !!state && !['lobby', 'gameOver'].includes(state.game.phase);
    const body = me?.role === 'player' && inGame
      ? t('Your seat and your {score} points are given up. Joining again starts a new player at 0.', { score: formatScore(me.score) })
      : t('You leave the game on this device.');
    if (!(await askConfirm({ title: t('Leave this room?'), body, confirmLabel: t('Leave room'), danger: true }))) return;
    const result = await send('session:leave');
    if (!result.ok) return;
    // The server has removed this socket, so a later reconnect must not resume the old seat.
    localStorage.removeItem(TOKEN_KEY);
    state = null;
    actionUncertain = false;
    $('#connection-status').textContent = '';
    show('screen-join');
  }
  button('#btn-leave').onclick = leaveRoom;
  button('#btn-leave-role').onclick = leaveRoom;

  /* ---------------- state & events ---------------- */

  /*
   * The pick's signature move: the lit cell grows into the question card, and after the reveal the card
   * shrinks back into the played cell. Only these two changes animate. It is skipped when buttons open
   * at once (the transition overlay would eat early taps), with reduced motion, or without the API.
   */
  let lastPick: { round: number; theme: number; question: number } | null = null;
  let pickTransitionRunning = false;
  function pickTransition(prev: RoomState | null, next: RoomState): boolean {
    if (!prev?.game || !('startViewTransition' in document) || pickTransitionRunning) return false;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    const from = prev.game.phase, to = next.game.phase;
    // The card now opens on the get-ready countdown, or straight into reading when that is off.
    if (from === 'intro' && (to === 'ready' || to === 'reading')) return true;
    return from === 'reveal' && to === 'board' && lastPick?.round === next.game.roundIndex;
  }

  // Host shortcuts pause briefly whenever the step changes (see the keydown handler below).
  let stepKey = '';
  let stepChangedAt = 0;
  socket.on('room:state', (s: RoomState) => {
    const prev = state;
    state = s;
    const key = `${s.game?.phase}:${s.game?.timer?.name ?? ''}:${s.game?.current?.presentationId ?? ''}`;
    if (key !== stepKey) { stepKey = key; stepChangedAt = Date.now(); }
    if (!Number.isFinite(bestRtt)) clockOffset = s.serverTime - Date.now();
    const c = s.game?.current;
    if (c && ['intro', 'ready', 'reading'].includes(s.game.phase)) {
      lastPick = { round: s.game.roundIndex, theme: c.themeIndex, question: c.questionIndex };
    }
    if (!pickTransition(prev, s)) return render();
    pickTransitionRunning = true;
    const transition = document.startViewTransition(() => render());
    void transition.finished.finally(() => { pickTransitionRunning = false; });
  });

  // A short line over the podium shows what just happened to whom, like the show's speech bubbles.
  function replicOf(evt: GameEvent): [string, string, ReplicTone] | null {
    if (!('playerId' in evt) || !evt.playerId) return null;
    switch (evt.type) {
      // An assigned player never pressed a button, so "Buzzed!" would be wrong.
      case 'buzzAccepted': return [evt.playerId, evt.assigned ? t('Answering') : t('Buzzed!'), 'plain'];
      case 'falseStart': return [evt.playerId, t('Too early'), 'stop'];
      case 'answerJudged': {
        const delta = evt.delta ?? 0;
        if (evt.correct) return [evt.playerId, delta ? `+${formatScore(delta)}` : t('Correct'), 'go'];
        return [evt.playerId, delta ? formatScore(delta) : t('Wrong'), 'stop'];
      }
      case 'stakeBid': {
        const amount = formatScore(evt.amount);
        return [evt.playerId, evt.allIn ? t('All in: {amount}', { amount }) : t('Bid {amount}', { amount }), 'lamp'];
      }
      case 'stakePass': return [evt.playerId, t('Pass'), 'plain'];
      case 'answerPassed': return [evt.playerId, t('Pass'), 'plain'];
      case 'stakeWon': return [evt.playerId, t('Takes it for {amount}', { amount: formatScore(evt.amount) }), 'lamp'];
      case 'giftAwarded': return [evt.playerId, t('Gift +{amount}', { amount: formatScore(evt.price) }), 'go'];
      default: return null;
    }
  }

  socket.on('game:event', (evt) => {
    const replic = replicOf(evt);
    if (replic) {
      sayReplic(replic[0], replic[1], replic[2], () => { if (hasActivePlayer(state)) renderPlayers(); });
      if (hasActivePlayer(state)) renderPlayers();
    }
    if (evt.type === 'questionSelected') {
      playTone(440, 160, 'triangle', 660);
    } else if (evt.type === 'buzzAccepted') {
      playTone(520, 260, 'square', 780);
    } else if (evt.type === 'falseStart') {
      playTone(210, 320, 'sawtooth', 150);
    } else if (evt.type === 'answerJudged') {
      if (evt.correct) playTone(587, 300, 'triangle', 880);
      else playTone(240, 300, 'sawtooth', 180);
    }
  });

  function render() {
    if (!state) return;
    const { you, game } = state;
    if (!you) return show('screen-join');
    if (you.role === 'pending') return show('screen-role');
    show('screen-game');
    $('#screen-game').dataset.phase = game.phase;
    renderTopbar();
    // Keep the screen on during play (QOL-1) and offer fullscreen to the TV and host (QOL-4).
    refreshKeepAwake();
    $('#btn-fullscreen').hidden = !(fullscreenSupported() && (tvMode || you.canModerate));
    const hostAway = hostBannerText(state) ?? '';
    $('#host-banner').hidden = !hostAway;
    // Rewriting the same text in a live region would re-announce it on every snapshot.
    if ($('#host-banner').textContent !== hostAway) $('#host-banner').textContent = hostAway;
    if (tvMode) {
      renderPlayers();
      renderResults();
      renderBoard();
      renderQuestion();
      renderTypedAnswer();
      renderStakeAuction();
      renderForAll();
      renderAppeals();
      syncQuestionMedia();
      updateOrientiers();
      return;
    }

    renderPlayers();
    renderResults();
    renderManage();
    renderBoard();
    renderQuestion();
    renderTypedAnswer();
    renderStakeAuction();
    renderForAll();
    renderAppeals();
    syncQuestionMedia();
    renderSpecialSetup();
    renderFinal();
    renderHostControls();
    updateOrientiers();
  }

  // Top bar answers "where are we" (round, step) and "who am I"; live timing lives in the status panel.
  function renderTopbar() {
    const { you, game, pack, participants } = activeState();
    const phase = $('#phase');
    phase.replaceChildren();
    if (game.phase === 'lobby') phase.textContent = pack ? pack.name : t('Lobby');
    else if (game.phase === 'gameOver') phase.textContent = t('Game over');
    else if (game.round) {
      // Packs often name rounds "1", "2"…; "2 2/3" would repeat the number, so those read "Round 2 of 3".
      const numbered = /^\d+$/.test(game.round.name.trim());
      phase.append(Object.assign(document.createElement('b'), { textContent: roundTitle(game.round.name) }));
      if (pack?.rounds.length) {
        phase.append(Object.assign(document.createElement('span'), {
          className: 'round-count',
          textContent: numbered ? t('of {total}', { total: pack.rounds.length }) : `${game.roundIndex + 1}/${pack.rounds.length}`,
        }));
      }
    }
    // Round arrows replace the old menu items: one tap, right next to the round name.
    const roundNav = you.canModerate && !tvMode && game.phase !== 'lobby' && !!pack;
    const prev = button('#btn-prev-round');
    const next = button('#btn-next-round');
    prev.classList.toggle('hidden', !roundNav);
    next.classList.toggle('hidden', !roundNav);
    prev.disabled = game.roundIndex <= 0 && game.phase !== 'gameOver';
    next.disabled = game.phase === 'gameOver';
    const nextLabel = pack && game.roundIndex >= pack.rounds.length - 1 ? t('Finish the game') : t('Next round');
    next.setAttribute('aria-label', nextLabel);
    next.title = nextLabel;
    const host = participants.find((p) => p.role === 'host');
    const hostChip = $('#host-chip');
    // Your own chip already says "Host", so the label names someone else or the empty seat.
    hostChip.classList.toggle('hidden', host?.id === you.id);
    hostChip.classList.toggle('vacant', !host);
    hostChip.replaceChildren();
    // Phones drop the "Hosted by" words but keep the avatar and name.
    if (host) hostChip.append(avatar(host.id, host.name),
      Object.assign(document.createElement('span'), { className: 'host-prefix', textContent: `${t('Hosted by')} ` }), host.name);
    else hostChip.textContent = t('No host yet');
    hostChip.title = host ? t('Hosted by {name}', { name: host.name }) : t('No host yet');
    // Anyone may take the empty seat, so a host who pressed Leave can come back to it.
    // A player waits for a calm moment; the server refuses mid-question.
    if (!host && !tvMode && (you.role !== 'player' || betweenQuestions(game))) {
      const take = Object.assign(document.createElement('button'), { type: 'button', className: 'small primary', textContent: t('Become host') });
      take.onclick = () => send('role:set', { targetId: you.id, role: 'host' });
      hostChip.append(take);
    }
    const me = $('#me');
    me.replaceChildren();
    if (tvMode) me.textContent = t('TV view');
    else {
      // A player's own score sits in the top bar at every width, visible without finding the podium.
      const score = you.role === 'player' && game.phase !== 'lobby' ? participants.find((p) => p.id === you.id)?.score : undefined;
      me.append(avatar(you.id, you.name), Object.assign(document.createElement('span'), { className: 'me-name', textContent: you.name }),
        Object.assign(document.createElement('span'), { className: 'role', textContent: roleLabels[you.role] ?? you.role }));
      if (score != null) me.append(Object.assign(document.createElement('span'), {
        className: 'me-score' + (score < 0 ? ' negative' : ''), textContent: formatScore(score),
      }));
    }
    renderHostMenu();
  }

  /*
   * Phone host menu: the round arrows and the host pill do not fit a 375 px bar next to the round name,
   * so below 600 px they hide and this menu offers the same actions. Each item presses the real button,
   * so labels, confirmations and disabled states stay in one place.
   */
  function renderHostMenu() {
    const menu = $('#host-menu') as HTMLDetailsElement;
    const tools = $('#host-tools');
    const roundNav = !button('#btn-prev-round').classList.contains('hidden');
    menu.classList.toggle('hidden', !roundNav && tools.classList.contains('hidden'));
    const panel = $('#host-menu-panel');
    panel.replaceChildren();
    for (const id of ['btn-prev-round', 'btn-next-round', 'btn-pause', 'btn-resume', 'btn-settings', 'btn-stop']) {
      const real = button(`#${id}`);
      if (real.classList.contains('hidden') || (id !== 'btn-prev-round' && id !== 'btn-next-round' && tools.classList.contains('hidden'))) continue;
      const item = Object.assign(document.createElement('button'), {
        type: 'button', className: 'quiet', disabled: real.disabled,
        textContent: real.getAttribute('aria-label') ?? real.title ?? real.textContent ?? '',
      });
      if (real.dataset.icon) item.dataset.icon = real.dataset.icon;
      item.onclick = () => { menu.open = false; real.click(); };
      panel.append(item);
    }
  }

  /** The host action that is the obvious next step in this phase, or null when there is none. */
  function hostPrimaryAct(game: RoomState['game']): string | null {
    if (game.phase === 'reading' && game.current?.type !== 'forAll') return 'game:openBuzzer';
    if (game.phase === 'reveal' || game.phase === 'roundEnd') return 'game:next';
    return null;
  }

  function renderHostControls() {
    const state = activeState();
    const { you, game } = state;
    const mod = you.canModerate && game.phase !== 'lobby';
    $('#host-controls').classList.toggle('hidden', !mod);
    if (!mod) $('#host-controls').classList.remove('slot-reserved');
    $('#host-tools').classList.toggle('hidden', !mod || tvMode);
    if (!mod) return renderHostMenu();
    button('#btn-pause').classList.toggle('hidden', game.phase === 'paused');
    button('#btn-pause').disabled = game.phase === 'gameOver';
    button('#btn-resume').classList.toggle('hidden', game.phase !== 'paused');
    // A stand-in host never rules on their own answer; the server refuses it (Room.assertNotOwnRuling).
    const ownAnswer = game.phase === 'answering' && game.buzzer.winnerId === you.id;
    button('#btn-undo-judgment').classList.toggle('hidden', !game.undoJudgment || game.undoJudgment.playerId === you.id);
    for (const button of $('#host-controls').querySelectorAll('button')) {
      const action = button.dataset.act;
      // Tapped answers judge themselves; written ones wait for the text or its deadline.
      const tapAnswer = (game.current?.answerType ?? 'text') !== 'text';
      if (action?.startsWith('judge-')) button.disabled = game.phase !== 'answering' || ownAnswer ||
        ((!state.settings.oral || tapAnswer) && !game.buzzer.typedAnswer?.submitted && !game.buzzer.typedAnswer?.closed);
      // Mirrors GameEngine.passAnswer.
      if (action === 'game:passAnswer') button.disabled = game.phase !== 'answering' || ownAnswer || !!game.current?.assignedId ||
        !!game.buzzer.typedAnswer?.submitted || !!game.buzzer.typedAnswer?.closed;
      if (action === 'game:reveal') button.disabled = game.current?.type === 'forAll' || ownAnswer ||
        !(['reading', 'buzzerOpen', 'answering'].includes(game.phase) ||
          (game.phase === 'reveal' && !game.current?.answerShown));
      // Nothing to skip while the picked cell is still animating; once the card is up, the host may skip it.
      // During the get-ready countdown Next starts reading early instead of skipping.
      if (action === 'game:next') button.disabled = !['ready', 'reading', 'buzzerOpen', 'reveal', 'roundEnd', 'specialSetup', 'stakeAuction'].includes(game.phase);
      if (action === 'game:next') {
        const finalReveal = game.phase === 'reveal' && game.round?.type === 'final';
        const moreFinalThemes = game.board.some((theme) => theme.questions[0]?.available);
        button.textContent = finalReveal && state.settings.playAllQuestionsInFinalRound
          ? moreFinalThemes ? t('Next final theme') : t('Finish game')
          : game.phase === 'specialSetup' ? t('Skip question')
            : game.phase === 'ready' ? t('Start now')
            : game.phase === 'reading' || game.phase === 'buzzerOpen' ? t('Skip question') : t('Next');
      }
    }

    const openBtn = button('#btn-open-buzzer');
    openBtn.classList.toggle('hidden', game.phase !== 'reading' || game.current?.type === 'forAll');
    openBtn.disabled = game.phase !== 'reading' || game.current?.type === 'forAll';
    openBtn.textContent = t('Open buzzer now');
    // One filled button per moment: the step the host is expected to take next. Verdicts are a pair, so
    // answering has none; the special-setup form and final controls bring their own primary button.
    const primaryAct = hostPrimaryAct(game);
    for (const control of $('#host-controls').querySelectorAll<HTMLButtonElement>(':scope > button[data-act]')) {
      control.classList.toggle('primary', control.dataset.act === primaryAct);
    }
    // Skipping a question being read is a side action, so it stays quiet next to Open buzzer.
    button('#host-controls [data-act="game:next"]').classList.toggle('quiet', game.phase === 'reading' || game.phase === 'buzzerOpen');
    // Keep unavailable phase actions out of the primary control strip.
    for (const control of $('#host-controls').querySelectorAll<HTMLButtonElement>(':scope > button[data-act]')) {
      control.classList.toggle('hidden', control.disabled);
    }
    // An empty bar is just a blue strip; hide it until this step has something to press.
    // It keeps its slot (layout.css, .slot-reserved) so the table does not resize every step.
    const busy = [...$('#host-controls').children].some((el) => !el.classList.contains('hidden'));
    $('#host-controls').classList.toggle('slot-reserved', !busy);
    renderHostMenu();
  }

  // No confirm step: the answer reveal moves on by itself after a few seconds, so a dialog made the
  // host lose that race and confirm a stale undo. Undo is reversible anyway (the host judges again).
  button('#btn-undo-judgment').title = t('Take back the last verdict and judge again. Viewers may already have seen the answer.');
  button('#btn-undo-judgment').onclick = () => {
    const undo = state?.game.undoJudgment;
    if (!undo) return;
    send('game:undoJudgment', { presentationId: undo.presentationId, judgmentId: undo.judgmentId });
  };

  let gameMediaPaused = false;
  let pausedForAnswer = false;
  let playingMediaIndices = new Set<number>();
  const manuallyPausedMedia = new WeakSet<HTMLMediaElement>();
  const gamePausedMedia = new WeakSet<HTMLMediaElement>();
  function questionMedia(): HTMLMediaElement[] {
    const media = [...document.querySelectorAll<HTMLMediaElement>('#question audio, #question video')];
    for (const frame of document.querySelectorAll<HTMLIFrameElement>('#question iframe.question-html')) {
      // Sandboxed pack HTML shares our origin but may navigate away inside its frame.
      try { media.push(...frame.contentDocument?.querySelectorAll<HTMLMediaElement>('audio, video') ?? []); }
      catch { /* An external frame cannot expose its media controls. */ }
    }
    return media;
  }
  function syncQuestionMedia() {
    const state = activeState();
    const playbackPaused = state.game.phase === 'paused' || state.game.phase === 'answering';
    questionPresenter?.setPaused(playbackPaused);
    const media = questionMedia();
    if (playbackPaused) {
      if (state.game.phase === 'answering') pausedForAnswer = true;
      // Capture once so repeated renders do not resume clips the user had paused.
      if (!gameMediaPaused) {
        playingMediaIndices = new Set(media.flatMap((item, index) => item.paused ? [] : [index]));
        gameMediaPaused = true;
      }
      media.forEach((item) => {
        item.autoplay = false;
        if (!item.paused) gamePausedMedia.add(item);
        item.pause();
      });
    } else if (gameMediaPaused) {
      // Revealing the key ends question playback; only a wrong answer resumes it.
      if (pausedForAnswer && state.game.phase !== 'buzzerOpen' && state.game.phase !== 'reading') {
        playingMediaIndices.clear();
        gameMediaPaused = false;
        pausedForAnswer = false;
        return;
      }
      // Indices survive a media URL rebuild when a paused client reconnects.
      media.forEach((item, index) => {
        if (playingMediaIndices.has(index)) item.play().catch(() => {});
      });
      playingMediaIndices.clear();
      gameMediaPaused = false;
      pausedForAnswer = false;
    }
  }

  /*
   * When a panel becomes your move (bid, wager, written answer), bring it on screen once (playtest
   * F5): on small phones it can sit below the fold while its clock runs. Once per turn, so it never
   * fights the player's own scrolling.
   */
  let revealedTurn = '';
  function revealTurnPanel(panel: HTMLElement, turnKey: string) {
    if (turnKey === revealedTurn) return;
    revealedTurn = turnKey;
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    requestAnimationFrame(() => panel.scrollIntoView({ block: 'nearest', behavior }));
  }

  function renderFinal() {
    const state = activeState();
    const { game, you, participants } = state;
    const final = game.final;
    const finalist = !!final && final.eligibleIds.includes(you.id);
    const wagering = game.phase === 'finalWager';
    $('#final-wager').classList.toggle('hidden', !wagering || !finalist);
    $('#final-host').classList.toggle('hidden', !final);
    if (!final) {
      $('#final-answer').classList.add('hidden');
      return;
    }
    if (wagering && finalist) {
      revealTurnPanel($('#final-wager'), `wager:${game.current?.presentationId}`);
      const score = Math.max(0, participants.find((p) => p.id === you.id)?.score ?? 0);
      input('#final-amount').max = String(score);
      // The saved wager sits in the field label: below the buttons it fell off small phone screens.
      $('#final-amount-label').textContent = final.wagered.includes(you.id)
        ? t('Saved: {wager}. You can change it (0 to {max}).', { wager: formatScore(final.yourWager ?? 0), max: formatScore(score) })
        : t('Your final wager, 0 to {max}', { max: formatScore(score) });
    }
    // Finalists write their answer so the host judges what was actually said.
    const answering = game.phase === 'finalQuestion' && finalist && !final.judged.includes(you.id);
    $('#final-answer').classList.toggle('hidden', !answering);
    if (answering) {
      revealTurnPanel($('#final-answer'), `final:${game.current?.presentationId}`);
      const field = textarea('#final-answer-input');
      if (final.yourAnswer && document.activeElement !== field && !field.value) field.value = final.yourAnswer;
      // Unsent text is kept as a draft and counts if time runs out (playtest F4); say so plainly.
      const draft = field.value.trim();
      $('#final-answer-status').textContent = !draft ? (final.yourAnswer ? t('Sent: {answer}', { answer: final.yourAnswer }) : '')
        : !final.yourAnswer ? t('Draft kept. Press Submit answer to lock it in.')
          : draft !== final.yourAnswer ? t('Changed since you sent it. The newest text counts.')
            : t('Sent. You can change it until time is up.');
    }
    const host = you.canModerate && ['finalWager', 'finalQuestion', 'finalJudge'].includes(game.phase);
    $('#final-host').classList.toggle('hidden', !host);
    if (!host) return;
    const finalists = participants.filter((p) => final.eligibleIds.includes(p.id));
    const waiting = finalists.filter((p) => p.connected && !final.wagered.includes(p.id));
    button('#btn-open-final').classList.toggle('hidden', !wagering);
    button('#btn-open-final').disabled = waiting.length > 0;
    button('#btn-close-final').classList.toggle('hidden', game.phase !== 'finalQuestion');
    const answered = finalists.filter((p) => final.answeredIds.includes(p.id)).length;
    // Name who the room waits for (playtest F11); offline finalists do not hold anything up.
    const unsent = finalUnsent();
    const changing = participants.filter((p) => final.editingIds.includes(p.id));
    const names = (list: { name: string }[]) => list.map((p) => p.name).join(', ');
    const total = finalists.length;
    $('#final-host-status').textContent = !total ? t('Nobody has a positive score, so nobody plays the final.')
      : wagering ? t('{done} of {total} wagers saved', { done: total - waiting.length, total }) +
        (waiting.length ? ` · ${t('Waiting for {names}', { names: names(waiting) })}` : '')
        : game.phase === 'finalQuestion' ? t('{done} of {total} answers in', { done: answered, total }) +
          (unsent.length ? ` · ${t('Not sent: {names}', { names: names(unsent) })}` : '') +
          // A finalist changing a sent answer holds the automatic close (see GameEngine).
          (changing.length ? ` · ${t('Changing: {names}', { names: names(changing) })}` : '')
          : t('Judge each answer on the podiums');
  }

  $('#final-wager').addEventListener('submit', (event) => {
    event.preventDefault();
    send('game:finalWager', { amount: Number(input('#final-amount').value) });
  });
  button('#final-all-in').onclick = () => {
    const field = input('#final-amount');
    field.value = field.max;
    send('game:finalWager', { amount: Number(field.max) });
  };
  /*
   * Unsent answer text goes to the server quietly while the player types. It counts only when answer
   * time closes without a newer sent answer, so ending the time early never loses it (playtest F4).
   * A raw emit on purpose: a draft that fails must not toast or flag the connection.
   */
  const drafts = createDraftSender((text) => {
    if (!socket.connected) return false;
    socket.emit('game:draft', { text }, () => {});
    return true;
  });
  const draftKey = () => state?.game.current?.presentationId ?? '';
  // Registered after the session-resume connect handler, which binds this socket to the seat first;
  // a draft sent before that would be refused and dropped.
  socket.on('connect', () => drafts.flush());
  document.addEventListener('visibilitychange', () => { if (document.hidden) drafts.flush(); });
  for (const field of ['#final-answer-input', '#for-all-answer']) {
    textarea(field).addEventListener('input', () => drafts.update(draftKey(), textarea(field).value));
    textarea(field).addEventListener('blur', () => drafts.flush());
  }

  $('#final-answer').addEventListener('submit', (event) => {
    event.preventDefault();
    const answer = textarea('#final-answer-input').value.trim();
    if (!answer) return;
    drafts.submitted(draftKey(), answer);
    send('game:finalAnswer', { answer });
  });
  // Answers are one line: Enter sends (Shift+Enter still breaks the line). People pressed Enter and
  // assumed the answer was in.
  for (const [field, form] of [['#final-answer-input', '#final-answer'], ['#for-all-answer', '#for-all-answer-form'],
    ['#typed-answer-input', '#typed-answer-form']] as const) {
    textarea(field).addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      ($(form) as HTMLFormElement).requestSubmit();
    });
  }
  textarea('#final-answer-input').addEventListener('input', () => { if (state) renderFinal(); });

  $('#btn-open-final').onclick = () => send('game:openFinal');
  /** Online finalists still to send an answer; judged (auto-zeroed) and offline ones are not waited for. */
  function finalUnsent(): { name: string }[] {
    const final = state?.game.final;
    if (!state || !final) return [];
    return state.participants.filter((p) => final.eligibleIds.includes(p.id) && p.connected &&
      !final.judged.includes(p.id) && !final.answeredIds.includes(p.id));
  }
  $('#btn-close-final').onclick = async () => {
    // Someone changing a sent answer gets their newest text too, so no question is needed for them.
    const unsent = finalUnsent();
    // Unsent text is kept as a draft on the server, so closing early uses it instead of dropping it.
    if (unsent.length && !(await askConfirm({
      title: t('End answer time now?'),
      body: tn(unsent.length, '{names} has not sent an answer.', '{names} have not sent an answer.',
        { names: unsent.map((p) => p.name).join(', ') }) + ' ' + t('Anything they typed is used as their answer.'),
      confirmLabel: t('End answer time'),
    }))) return;
    send('game:closeFinal');
  };

  function renderSpecialSetup() {
    const state = activeState();
    const visible = state.you.canModerate && state.game.phase === 'specialSetup';
    $('#special-setup').classList.toggle('hidden', !visible);
    const current = state.game.current;
    if (!visible || !current) return;
    const gift = current.type === 'secretNoQuestion';
    $('#special-setup-title').textContent = gift ? t('Gift') : t('Special question');
    $('#special-setup button[type="submit"]').textContent = gift ? t('Award points') : t('Show question');
    const playerSelect = select('#special-player');
    const previous = playerSelect.value;
    playerSelect.replaceChildren();
    // A secret marked "except current" may not go back to the player who opened it.
    const excluded = current.type.startsWith('secret') && current.selectionMode === 'exceptCurrent' ? state.game.chooserId : null;
    const eligible = state.participants.filter((p) => p.role === 'player' && p.connected && p.id !== excluded);
    for (const player of eligible) playerSelect.add(new Option(player.name, player.id));
    if (eligible.some((p) => p.id === previous)) playerSelect.value = previous;
    const range = current.priceRange;
    const priceInput = input('#special-price');
    priceInput.min = String(gift ? current.price : range?.minimum ?? current.price);
    priceInput.max = String(gift ? current.price : range?.maximum ?? Math.max(current.price,
      state.participants.find((p) => p.id === playerSelect.value)?.score ?? 0));
    priceInput.step = String(range?.step || 1);
    priceInput.readOnly = gift;
    if (document.activeElement !== priceInput) priceInput.value = priceInput.min;
  }

  $('#special-setup').addEventListener('submit', (event) => {
    event.preventDefault();
    send('game:configureSpecial', { playerId: select('#special-player').value, price: Number(input('#special-price').value) });
  });

  function renderStakeAuction() {
    const { game, you, participants } = activeState();
    const auction = game.auction;
    const pausedAuction = game.phase === 'paused' && game.pausedPhase === 'stakeAuction';
    const visible = (game.phase === 'stakeAuction' || pausedAuction) && auction !== null;
    $('#stake-auction').classList.toggle('hidden', !visible);
    if (!visible || !auction) return;

    const playerName = (id: string | null) => participants.find((p) => p.id === id)?.name ?? t('Player');
    $('#stake-auction-status').textContent = !auction.leaderId
      ? t('Opening bid: {amount} points.', { amount: auction.minimum })
      : auction.allIn ? t('{name} leads with {amount} points (all in).', { name: playerName(auction.leaderId), amount: auction.amount })
        : t('{name} leads with {amount} points.', { name: playerName(auction.leaderId), amount: auction.amount });

    const myTurn = game.phase === 'stakeAuction' && you.role === 'player' && auction.turnId === you.id;
    $('#stake-bid-form').classList.toggle('hidden', !myTurn);
    const score = participants.find((p) => p.id === you.id)?.score ?? 0;
    const maxRegular = Math.max(game.current?.price ?? auction.minimum, score);
    const canBid = !auction.allIn && maxRegular >= auction.minimumNextBid;
    const canAllIn = !(score < auction.minimum || score <= auction.amount);
    $('#stake-auction-hint').textContent = pausedAuction ? t('The auction is paused.') : myTurn
      ? auctionTurnHint(auction.minimumNextBid, canBid, canAllIn)
      : auction.turnId
        // A dropped bidder keeps the turn for a few seconds (playtest F16); say why it waits.
        ? participants.find((p) => p.id === auction.turnId)?.connected === false
          ? t('{name} is reconnecting. Their turn waits a few seconds.', { name: playerName(auction.turnId) })
          : t('{name} is choosing a bid.', { name: playerName(auction.turnId) })
        : t('Auction is ending…');
    if (!myTurn) return;
    revealTurnPanel($('#stake-auction'), `stake:${game.current?.presentationId}:${auction.leaderId}:${auction.amount}`);

    const bidInput = input('#stake-bid-amount');
    bidInput.min = String(auction.minimumNextBid);
    bidInput.max = String(maxRegular);
    bidInput.step = '1';
    bidInput.disabled = !canBid;
    button('#stake-bid-form button[type="submit"]').disabled = !canBid;
    button('#stake-all-in').disabled = !canAllIn;
    if (document.activeElement !== bidInput &&
        (!bidInput.value || Number(bidInput.value) < auction.minimumNextBid || Number(bidInput.value) > maxRegular)) {
      bidInput.value = String(auction.minimumNextBid);
    }
  }

  $('#stake-bid-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const amount = Number(input('#stake-bid-amount').value);
    if (Number.isInteger(amount)) send('game:stakeBid', { amount, allIn: false });
  });
  button('#stake-all-in').onclick = () => {
    const { you, participants } = activeState();
    const amount = participants.find((p) => p.id === you.id)?.score ?? 0;
    send('game:stakeBid', { amount, allIn: true });
  };
  button('#stake-pass').onclick = () => send('game:stakePass');

  let forAllQuestionKey: string | null = null;
  function renderForAll() {
    const { game, you, participants } = activeState();
    const phase = game.phase === 'paused' ? game.pausedPhase : game.phase;
    const forAll = game.forAll;
    const visible = game.current?.type === 'forAll' && !!forAll &&
      ['ready', 'reading', 'forAllAnswering', 'forAllJudge'].includes(phase ?? '');
    $('#for-all').classList.toggle('hidden', !visible);
    if (!visible || !forAll || !game.current) {
      forAllQuestionKey = null;
      return;
    }

    const key = `${game.roundIndex}:${game.current.themeIndex}:${game.current.questionIndex}`;
    const answerInput = $('#for-all-answer') as HTMLTextAreaElement;
    if (forAllQuestionKey !== key) {
      answerInput.value = '';
      forAllQuestionKey = key;
    }
    const playerCount = forAll.eligibleIds.length;
    const submitted = forAll.submittedIds.filter((id) => forAll.eligibleIds.includes(id)).length;
    const judged = forAll.judgedIds.filter((id) => forAll.eligibleIds.includes(id)).length;
    $('#for-all-status').textContent = phase === 'reading' || phase === 'ready'
      ? t('Read the question. Private answers open shortly.')
      : phase === 'forAllAnswering'
        ? t('{done} of {total} players answered.', { done: submitted, total: playerCount }) +
          (game.phase === 'paused' ? ` ${t('Paused.')}` : '')
        : t('Answers closed. {done} of {total} players judged.', { done: judged, total: playerCount });

    const isPlayer = you.role === 'player';
    const hasSubmitted = forAll.submittedIds.includes(you.id);
    const canAnswer = game.phase === 'forAllAnswering' && isPlayer &&
      forAll.eligibleIds.includes(you.id) && !hasSubmitted;
    $('#for-all-answer-form').classList.toggle('hidden', !canAnswer);
    if (canAnswer) revealTurnPanel($('#for-all'), `forAll:${game.current.presentationId}`);
    if (forAll.yourAnswer !== null) $('#for-all-status').textContent += ` ${t('Your answer is saved.')}`;

    const host = you.canModerate;
    $('#for-all-host').classList.toggle('hidden', !host);
    const close = button('#for-all-close');
    close.classList.toggle('hidden', phase !== 'forAllAnswering');
    close.disabled = game.phase !== 'forAllAnswering';
    const list = $('#for-all-answers');
    const moveFocusAfterJudging = list.contains(document.activeElement);
    list.replaceChildren();
    if (!host || phase !== 'forAllJudge' || !forAll.answers) return;

    for (const player of participants.filter((p) => forAll.eligibleIds.includes(p.id))) {
      const row = document.createElement('div');
      row.className = 'for-all-response';
      const heading = document.createElement('strong');
      heading.textContent = player.name;
      const answer = document.createElement('p');
      answer.textContent = forAll.answers[player.id] || t('(No answer submitted)');
      row.append(heading, answer);
      if (forAll.judgedIds.includes(player.id)) {
        const judged = document.createElement('span');
        judged.textContent = t('Judged');
        row.append(judged);
      } else {
        for (const [label, correct] of [[t('Correct'), true], [t('Wrong'), false]] as const) {
          const judgeButton = document.createElement('button');
          judgeButton.type = 'button';
          judgeButton.className = correct ? 'ok' : 'bad';
          judgeButton.dataset.icon = correct ? 'check' : 'cross';
          judgeButton.textContent = label;
          judgeButton.setAttribute('aria-label', correct ? t('{name}: mark answer correct', { name: player.name })
            : t('{name}: mark answer wrong', { name: player.name }));
          judgeButton.disabled = game.phase !== 'forAllJudge' || player.id === you.id;
          judgeButton.onclick = () => send('game:judgeForAll', { playerId: player.id, correct });
          row.append(judgeButton);
        }
      }
      list.append(row);
    }
    // A verdict rerenders this list; keep keyboard focus on the next decision.
    if (moveFocusAfterJudging) list.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  $('#for-all-answer-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const answer = ($('#for-all-answer') as HTMLTextAreaElement).value.trim();
    if (!answer) return;
    drafts.submitted(draftKey(), answer);
    send('game:forAllAnswer', { answer });
  });
  button('#for-all-close').onclick = () => send('game:closeForAll');

  function renderAppeals() {
    const { game, you, participants, settings } = activeState();
    const phase = game.phase === 'paused' ? game.pausedPhase : game.phase;
    const appeals = game.appeals;
    const visible = !!appeals && (appeals.judgments.length > 0 || !!appeals.active) &&
      (phase === 'reveal' || phase === 'appealVote');
    $('#appeals').classList.toggle('hidden', !visible);
    if (!visible || !appeals) return;

    const nameOf = (id: string) => participants.find((p) => p.id === id)?.name ?? t('Player');
    const active = appeals.active;
    const voteOpen = game.phase === 'appealVote' && !!active;
    const voteActions = $('#appeal-vote-actions');
    const mayVote = voteOpen && active.eligibleVoterIds.includes(you.id) &&
      !active.votedIds.includes(you.id) && you.role === 'player';
    voteActions.classList.toggle('hidden', !mayVote);
    const close = button('#appeal-close');
    close.classList.toggle('hidden', !voteOpen || !you.canModerate);
    close.disabled = !voteOpen;

    if (active) {
      const voted = active.votedIds.filter((id) => active.eligibleVoterIds.includes(id)).length;
      // "Cid appealed Cid's answer" read oddly; a player appealing their own verdict is the common case.
      // Whole sentences per case, so each language can order the names its own way.
      const own = active.requesterId === active.targetId;
      const names = { name: nameOf(active.requesterId), target: nameOf(active.targetId) };
      const appealed = active.kind === 'for'
        ? own ? t('{name} appealed their own rejected answer.', names) : t('{name} appealed {target}’s rejected answer.', names)
        : own ? t('{name} appealed their own accepted answer.', names) : t('{name} appealed {target}’s accepted answer.', names);
      $('#appeal-status').textContent = `${appealed} ` +
        t('{done} of {total} votes received. Votes are private.', { done: voted, total: active.eligibleVoterIds.length }) +
        (active.votedIds.includes(you.id) ? ` ${t('Your vote is saved.')}` : '') +
        (game.phase === 'paused' ? ` ${t('Paused.')}` : '');
    } else {
      $('#appeal-status').textContent = settings.useApellations
        ? t('Players may request a review before the next question.') : t('Appeals are disabled.');
    }

    const list = $('#appeal-judgments');
    list.replaceChildren();
    const connectedPlayers = participants.filter((p) => p.role === 'player' && p.connected).length;
    for (const judgment of appeals.judgments) {
      const row = document.createElement('div');
      row.className = 'appeal-judgment';
      const verdict = judgment.voided ? t('Voided') : judgment.correct ? t('Accepted') : t('Rejected');
      const shownDelta = judgment.voided ? 0 : judgment.delta;
      const delta = shownDelta > 0 ? `+${shownDelta}` : String(shownDelta);
      const label = document.createElement('span');
      label.textContent = `${nameOf(judgment.playerId)}: ${verdict} (${delta})${judgment.appealed ? ` · ${t('appeal reviewed')}` : ''}`;
      row.append(label);

      const targetIsPlayer = participants.some((p) => p.id === judgment.playerId && p.role === 'player');
      const ownRejected = !judgment.correct && judgment.playerId === you.id &&
        !(game.current?.type === 'forAll' && game.forAll?.yourAnswer === null);
      const challengeAccepted = judgment.correct && judgment.playerId !== you.id && connectedPlayers >= 4;
      if (game.phase === 'reveal' && settings.useApellations && you.role === 'player' &&
          targetIsPlayer && !judgment.appealed && !judgment.voided &&
          (ownRejected || challengeAccepted)) {
        const request = document.createElement('button');
        request.type = 'button';
        request.textContent = ownRejected ? t('Appeal rejection') : t('Challenge acceptance');
        request.setAttribute('aria-label', ownRejected ? t('Appeal rejection for {name}', { name: nameOf(judgment.playerId) })
          : t('Challenge acceptance for {name}', { name: nameOf(judgment.playerId) }));
        request.onclick = () => send('game:appealRequest', { judgmentId: judgment.id });
        row.append(request);
      }
      list.append(row);
    }
    // Verdicts already show on the podiums; the panel appears only when someone can act on it.
    if (!active && !list.querySelector('button')) $('#appeals').classList.add('hidden');
  }

  button('#appeal-support').onclick = () => send('game:appealVote', { support: true });
  button('#appeal-oppose').onclick = () => send('game:appealVote', { support: false });
  button('#appeal-close').onclick = () => send('game:appealClose');

  button('#btn-copy-results').onclick = async () => {
    const { participants, pack } = activeState();
    const ranking = participants.filter((p) => p.role === 'player').sort((a, b) => b.score - a.score);
    try {
      await navigator.clipboard.writeText(resultsText(ranking, pack?.name));
      toast(t('Results copied.'), 'info');
    } catch { toast(t('Copying needs the host computer (the browser blocks it on this address).')); }
  };
  function renderResults() {
    const { game, participants, you, pack } = activeState();
    const finished = game.phase === 'gameOver';
    $('#results').classList.toggle('hidden', !finished);
    if (!finished) return;

    const ranking = participants.filter((p) => p.role === 'player')
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const winners = ranking.filter((p) => p.score === ranking[0]?.score);
    $('#results-winner').textContent = winners.length > 1
      ? t('Shared win: {names}', { names: winners.map((p) => p.name).join(', ') })
      : winners.length ? t('{name} wins', { name: winners[0].name }) : t('No player scores.');
    const list = $('#results-list');
    list.replaceChildren();
    for (const player of ranking) {
      const item = document.createElement('li');
      item.classList.toggle('winner', winners.includes(player));
      item.append(avatar(player.id, player.name),
        Object.assign(document.createElement('span'), { className: 'name', textContent: player.name }),
        Object.assign(document.createElement('span'), { className: 'pts', textContent: formatScore(player.score) }));
      list.append(item);
    }

    const canRematch = !tvMode && you.canManage;
    const ready = !!pack && participants.some((p) => p.role === 'host' && p.connected) &&
      participants.some((p) => p.role === 'player' && p.connected);
    button('#btn-rematch').classList.toggle('hidden', !canRematch);
    button('#btn-rematch').disabled = !ready;
    $('#results-hint').textContent = canRematch
      ? ready ? t('A rematch starts from round one and resets scores.')
        : t('A connected host and player are needed for a rematch.')
      : t('Waiting for the host to start a rematch.');
  }

  button('#btn-rematch').onclick = async () => {
    if (await askConfirm({ title: t('Start a rematch?'), body: t('Everyone’s score goes back to zero.'), confirmLabel: t('Start rematch') })) {
      send('game:start');
    }
  };

  function renderPlayers() {
    const state = activeState();
    const { participants, game, you } = state;
    const now = nowServer();
    const blockedMap = new Map((game.buzzer?.blockedPlayers ?? []).map((b) => [b.id, b.until]));
    const attemptedSet = new Set(game.buzzer?.attempted ?? []);
    const seats = $('#players');
    const hostSeat = $('#host-seat');
    // The host sits in the host column, like the show's presenter, not on the scoreboard.
    const hostInColumn = game.phase !== 'gameOver';

    // Snapshots rebuild seats; preserve open menus and a half-typed score change while scores change.
    const containers = [seats, hostSeat];
    const openMenus = new Set(containers.flatMap((box) =>
      Array.from(box.querySelectorAll<HTMLDetailsElement>('details[open]')).map((menu) => menu.dataset.playerId)));
    const drafts = new Map(containers.flatMap((box) =>
      Array.from(box.querySelectorAll<HTMLInputElement>('.score-form input')).map((field) =>
        [field.dataset.playerId ?? '', field.value] as const)));
    const focusedDraft = document.activeElement instanceof HTMLInputElement &&
      document.activeElement.closest('.score-form') ? document.activeElement.dataset.playerId : undefined;
    // A half-typed new name survives the rebuild the same way (QOL-2).
    const nameDrafts = new Map(containers.flatMap((box) =>
      Array.from(box.querySelectorAll<HTMLInputElement>('.rename-form input')).map((field) =>
        [field.dataset.playerId ?? '', field.value] as const)));
    const focusedName = document.activeElement instanceof HTMLInputElement &&
      document.activeElement.closest('.rename-form') ? document.activeElement.dataset.playerId : undefined;
    seats.replaceChildren();
    hostSeat.replaceChildren();

    for (const p of participants) {
      // TV connections are display devices, not contestants on the scoreboard.
      if (p.displayOnly && game.phase !== 'lobby') continue;
      const el = document.createElement('div');
      el.className = 'player';
      el.classList.add(`role-${p.role}`);
      if (p.id === you.id) el.classList.add('you');
      if (!p.connected) el.classList.add('off');
      const isChooser = p.id === game.chooserId && (game.phase === 'board' || game.phase === 'finalThemes');
      if (isChooser) el.classList.add('chooser');

      const isAnswering = p.id === game.buzzer.winnerId && game.phase === 'answering';
      const blockedUntil = blockedMap.get(p.id) ?? 0;
      const isBlocked = blockedUntil > now;
      const hasTried = attemptedSet.has(p.id);

      if (isAnswering) el.classList.add('answering');
      else if (isBlocked) el.classList.add('blocked');
      else if (hasTried) el.classList.add('tried');

      const name = Object.assign(document.createElement('b'), { textContent: p.name, title: p.name });
      el.append(avatar(p.id, p.name), name);
      if (p.role === 'player') {
        el.append(Object.assign(document.createElement('div'), {
          className: `score${p.score < 0 ? ' negative' : ''}`, textContent: formatScore(p.score),
        }));
      } else {
        el.append(Object.assign(document.createElement('span'), { className: 'role-label', textContent: roleLabels[p.role] ?? p.role }));
      }
      const slot = document.createElement('div');
      slot.className = 'badge-slot';
      const badge = (className: string, text: string) =>
        slot.append(Object.assign(document.createElement('span'), { className: `badge ${className}`, textContent: text }));
      if (!p.connected) badge('off-badge', t('Offline'));
      else if (isAnswering) badge('answering-badge', state.settings.oral ? t('Answering') : t('Writing'));
      else if (isBlocked) badge('blocked-badge', t('Blocked {seconds}s', { seconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)) }));
      else if (hasTried) badge('tried-badge', t('Answered'));
      else if (isChooser) badge('chooser-badge', game.phase === 'finalThemes' ? t('Removes') : t('Picks'));
      else if (game.phase === 'lobby' && p.role === 'player') badge(p.ready ? 'ready-badge' : 'unready-badge', p.ready ? t('Ready') : t('Not ready'));
      // The host can spot a slow link before it slows every buzzer; a player sees only their own.
      else if (p.pingMs != null && (you.canModerate || p.id === you.id)) {
        const quality = p.pingMs <= 25 ? 'ping-good' : p.pingMs <= 70 ? 'ping-fair' : 'ping-poor';
        badge(`ping-badge ${quality}`, t('{ms} ms', { ms: p.pingMs }));
        (slot.lastElementChild as HTMLElement).title = t('Round trip {rtt} ms · one way {oneWay} ms · jitter ±{jitter} ms',
          { rtt: p.pingMs, oneWay: p.oneWayMs ?? Math.round(p.pingMs / 2), jitter: p.jitterMs ?? 0 });
      }
      el.append(slot);
      // Final answers are judged on each podium, next to the answer and wager they belong to.
      // The server sends them to the host while judging and to everyone once the final is revealed.
      const final = game.final;
      if (final?.answers && final.eligibleIds.includes(p.id)) {
        el.classList.add('judging');
        el.append(finalVerdict(p.id, p.name, final));
      }
      const replic = replicFor(p.id);
      if (replic) el.append(replic);

      const actions = document.createElement('details');
      actions.className = 'player-menu';
      actions.dataset.playerId = p.id;
      actions.open = openMenus.has(p.id);
      const summary = document.createElement('summary');
      summary.textContent = '⋮';
      summary.setAttribute('aria-label', t('Manage {name}', { name: p.name }));
      // Menu items live in a popover panel so opening one never reshapes the podium row.
      const panel = Object.assign(document.createElement('div'), { className: 'player-menu-panel' });
      // Naming the person keeps the menu readable when it floats over the board.
      const title = p.connected && p.pingMs != null
        ? t('{name} · {ms} ms (±{jitter})', { name: p.name, ms: p.pingMs, jitter: p.jitterMs ?? 0 }) : p.name;
      panel.append(Object.assign(document.createElement('strong'), { className: 'menu-title', textContent: title }));
      actions.append(summary, panel);
      // A stand-in host does not change their own score.
      if (you.canModerate && p.role === 'player' && p.id !== you.id) {
        const row = document.createElement('div');
        row.className = 'row';
        const plus = Object.assign(document.createElement('button'), { type: 'button', textContent: '+100' });
        const minus = Object.assign(document.createElement('button'), { type: 'button', textContent: '−100' });
        plus.onclick = () => send('score:adjust', { targetId: p.id, delta: 100 });
        minus.onclick = () => send('score:adjust', { targetId: p.id, delta: -100 });
        plus.setAttribute('aria-label', t('Add 100 points to {name}', { name: p.name }));
        minus.setAttribute('aria-label', t('Subtract 100 points from {name}', { name: p.name }));
        row.append(plus, minus);
        // An inline field replaces the old prompt() so the host never loses sight of the board.
        const form = Object.assign(document.createElement('form'), { className: 'score-form' });
        const field = Object.assign(document.createElement('input'), {
          type: 'number', step: '1', placeholder: '±250', value: drafts.get(p.id) ?? '',
        });
        field.dataset.playerId = p.id;
        field.setAttribute('aria-label', t('Custom score change for {name}', { name: p.name }));
        const apply = Object.assign(document.createElement('button'), { type: 'submit', textContent: t('Apply') });
        form.append(field, apply);
        form.onsubmit = async (event) => {
          event.preventDefault();
          const delta = Number(field.value.trim());
          if (!field.value.trim() || !Number.isSafeInteger(delta) || delta === 0) {
            toast(t('Enter a whole-number score change, for example -250 or 350.'));
            return;
          }
          if ((await send('score:adjust', { targetId: p.id, delta })).ok) field.value = '';
        };
        panel.append(row, form);
        if (focusedDraft === p.id) queueMicrotask(() => field.focus());
      }
      // Rename: the host anyone, anyone themselves in the lobby (QOL-2). The server checks the same rule.
      if (!p.displayOnly && (you.canModerate || (p.id === you.id && game.phase === 'lobby'))) {
        const rename = renameForm(p.id, p.name, nameDrafts.get(p.id), (name) => void send('participant:rename', { targetId: p.id, name }));
        panel.append(rename);
        if (focusedName === p.id) queueMicrotask(() => rename.querySelector('input')?.focus());
      }
      // A newcomer who landed as a spectator gets a seat between questions (QOL-2, QOL-3).
      const freeSeat = participants.filter((member) => member.role === 'player').length < state.settings.maxPlayers;
      if (you.canModerate && p.role === 'spectator' && !p.displayOnly && freeSeat && betweenQuestions(game)) {
        const seat = Object.assign(document.createElement('button'), { type: 'button', textContent: t('Make player') });
        seat.setAttribute('aria-label', t('Make {name} a player', { name: p.name }));
        seat.onclick = () => send('role:set', { targetId: p.id, role: 'player' });
        panel.append(seat);
      }
      // A player back on a new device takes their old seat and score with one click (playtest F7).
      const newcomers = participants.filter((member) => member.connected && member.id !== p.id &&
        member.role !== 'host' && !member.displayOnly);
      if (you.canModerate && p.role === 'player' && !p.connected && newcomers.length && betweenQuestions(game)) {
        panel.append(Object.assign(document.createElement('span'), { className: 'menu-hint', textContent: t('Back on a new device?') }));
        panel.append(giveSeatForm(p, newcomers, async (newcomerId) => {
          const name = newcomers.find((member) => member.id === newcomerId)?.name ?? t('They');
          const names = { seat: p.name, name, score: formatScore(p.score) };
          if (await askConfirm({
            title: t("Give {seat}'s seat to {name}?", names),
            body: t("{name} continues as {seat} with {score} points. {name}'s own seat goes away.", names),
            confirmLabel: t('Give seat'),
          })) send('seat:give', { seatId: p.id, newcomerId });
        }));
      }
      // An offline player's seat is removed only between questions; a connected guest can go any time.
      if (you.canModerate && p.id !== you.id && (p.connected || p.role !== 'player' || betweenQuestions(game))) {
        const kick = Object.assign(document.createElement('button'), { type: 'button', textContent: t('Remove from room') });
        kick.className = 'bad';
        kick.dataset.icon = 'cross';
        kick.setAttribute('aria-label', t('Remove {name} from the room', { name: p.name }));
        kick.onclick = async () => {
          if (await askConfirm({
            title: t('Remove {name} from the room?', { name: p.name }), body: removeConfirmBody(p), confirmLabel: t('Remove'), danger: true,
          })) send('participant:kick', { targetId: p.id });
        };
        panel.append(kick);
      }
      const vacantHostSeat = !participants.some((member) => member.role === 'host');
      const canAppoint = state.game.phase === 'lobby'
        ? p.role === 'player' || p.role === 'spectator'
        : p.role === 'spectator';
      if (you.canModerate && vacantHostSeat && p.connected && !p.displayOnly && p.id !== you.id && canAppoint) {
        const appoint = Object.assign(document.createElement('button'), { type: 'button', textContent: t('Make host') });
        appoint.setAttribute('aria-label', t('Make {name} host', { name: p.name }));
        appoint.onclick = () => send('role:set', { targetId: p.id, role: 'host' });
        panel.append(appoint);
      }
      if (you.canModerate && p.role === 'host' && !p.connected) {
        const release = Object.assign(document.createElement('button'), { type: 'button', textContent: t('Release host seat') });
        release.setAttribute('aria-label', t('Release {name} from the host seat', { name: p.name }));
        release.onclick = () => send('role:set', { targetId: p.id, role: 'spectator' });
        panel.append(release);
      }
      if (panel.children.length > 1) el.append(actions);
      (hostInColumn && p.role === 'host' ? hostSeat : seats).append(el);
    }
    // Before the game, open seats show how many more people can still join as players.
    if (game.phase === 'lobby') {
      const free = state.settings.maxPlayers - participants.filter((p) => p.role === 'player').length;
      for (let i = 0; i < free; i++) {
        const seat = Object.assign(document.createElement('div'), { className: 'player empty-seat' });
        seat.setAttribute('aria-label', t('Free player seat'));
        seat.append(Object.assign(document.createElement('span'), { className: 'avatar', textContent: '+' }),
          Object.assign(document.createElement('b'), { textContent: t('Free seat') }),
          Object.assign(document.createElement('span'), { className: 'role-label', textContent: t('Scan the code to join') }));
        seats.append(seat);
      }
    }
  }

  function finalVerdict(playerId: string, name: string, final: NonNullable<RoomState['game']['final']>): HTMLElement {
    const box = Object.assign(document.createElement('div'), { className: 'podium-verdict' });
    const answer = final.answers?.[playerId];
    box.append(Object.assign(document.createElement('p'), {
      className: answer ? 'final-text' : 'final-text empty', textContent: answer || t('No written answer'), title: answer ?? '',
    }));
    const wager = final.wagers?.[playerId];
    if (wager != null) box.append(Object.assign(document.createElement('small'), { textContent: t('Wager {amount}', { amount: formatScore(wager) }) }));
    if (final.judged.includes(playerId)) {
      // Verdicts are public at reveal; the latest one counts when an appeal overturned the first.
      const verdict = state?.game.appeals?.judgments.filter((j) => j.playerId === playerId && !j.voided).at(-1);
      if (verdict) {
        // A span, not <b>: the podium's "(you)" suffix targets its <b> name.
        box.append(Object.assign(document.createElement('span'), {
          className: `final-delta ${verdict.correct ? 'ok' : 'bad'}`,
          textContent: `${verdict.correct ? '✓' : '✗'} ${verdict.delta > 0 ? '+' : ''}${formatScore(verdict.delta)}`,
        }));
      }
      return box;
    }
    const row = Object.assign(document.createElement('div'), { className: 'verdict-buttons' });
    const verdict = (correct: boolean) => {
      const b = Object.assign(document.createElement('button'), {
        type: 'button', className: correct ? 'ok' : 'bad', textContent: correct ? '✓' : '✗',
      });
      b.setAttribute('aria-label', `${correct ? t('Correct') : t('Wrong')}: ${name}`);
      // A stand-in host does not judge their own final answer.
      b.disabled = playerId === state?.you?.id;
      b.onclick = () => send('game:judgeFinal', { playerId, correct });
      return b;
    };
    row.append(verdict(true), verdict(false));
    box.append(row);
    return box;
  }

  // Wide screens and landscape phones list the scoreboard down the host column; elsewhere it sits
  // under the table. Keep the second query in step with client/src/styles/landscape.css.
  const sideScoreboard = matchMedia('(min-width: 861px) and (min-height: 620px), (orientation: landscape) and (max-height: 500px)');
  function placeScoreboard() {
    const target = sideScoreboard.matches ? $('.host-col') : $('#screen-game');
    if ($('#players').parentElement !== target) target.append($('#players'));
  }
  sideScoreboard.addEventListener('change', placeScoreboard);
  placeScoreboard();
  applyVolume();

  // Popover menus close when the user clicks elsewhere, like any menu.
  document.addEventListener('click', (event) => {
    for (const menu of document.querySelectorAll<HTMLDetailsElement>('.player-menu[open]')) {
      if (!menu.contains(event.target as Node)) menu.open = false;
    }
  });
  // A podium low in the scoreboard column opened its menu past the bottom of the screen (1024x768),
  // so an open menu slides up (or down) until it fits. 'toggle' does not bubble, hence the capture.
  // A re-render rebuilds the menu already open, which fires 'toggle' again and refits it.
  document.addEventListener('toggle', (event) => {
    const menu = event.target as HTMLElement;
    if (!(menu instanceof HTMLDetailsElement) || !menu.matches('.player-menu') || !menu.open) return;
    const panel = menu.querySelector<HTMLElement>('.player-menu-panel');
    if (panel) keepInViewport(panel);
  }, true);

  /* ---------------- lobby settings & packs ---------------- */

  const numberSettingKeys = [
    'maxPlayers', 'timeForBlockingButton', 'buzzSyncWindowMs', 'readingSpeed', 'timeForThinkingOnQuestion',
    'timeForPrintingAnswer', 'timeForMakingStake', 'timeForThinkingOnSpecial',
    'timeForFinalThinking', 'timeForQuestionIntro', 'timeForQuestionReady', 'timeForChoosingQuestion', 'timeForChoosingFinalTheme',
  ] as const;
  let packsLoaded = false;
  let knownPacks: PackListItem[] = [];
  // Compared by file: two packs can share a name (audit UX-2).
  let renderedPackFile: string | null | undefined;
  let loadingPackFile: string | null = null;
  async function refreshPacks() {
    const res = await send('packs:list');
    if (!res.ok) return;
    knownPacks = res.packs ?? [];
    renderPackList();
  }

  // Pack rows show the loaded pack as current, so the host can see what will play at a glance.
  function renderPackList() {
    const loaded = state?.pack?.file ?? null;
    renderedPackFile = loaded;
    const list = $('#pack-list');
    list.replaceChildren();
    if (!knownPacks.length) {
      list.append(Object.assign(document.createElement('li'), {
        className: 'hint', textContent: t('No packs yet. Add a .siq file below or put one in the packs folder.'),
      }));
      return;
    }
    for (const p of knownPacks) {
      const li = document.createElement('li');
      const current = !p.error && p.file === loaded;
      li.classList.toggle('current', current);
      const meta = Object.assign(document.createElement('div'), { className: 'pack-meta' });
      const rounds = p.rounds == null ? t('Rounds unknown') : tn(p.rounds, '{n} round', '{n} rounds');
      const error = p.error ? serverText(p.error) : '';
      meta.append(Object.assign(document.createElement('strong'), { textContent: p.name }),
        Object.assign(document.createElement('span'), { textContent: `${rounds} · ${t('{size} MB', { size: (p.size / 1e6).toFixed(1) })}` }));
      if (error) meta.append(Object.assign(document.createElement('span'), { className: 'error', textContent: error }));
      // Round and theme names let the host check a pack before loading it (QOL-7).
      if (p.outline?.length) {
        const preview = Object.assign(document.createElement('details'), { className: 'pack-outline' });
        preview.append(Object.assign(document.createElement('summary'), { textContent: t('Themes') }),
          ...p.outline.map((round) => Object.assign(document.createElement('p'), {
            textContent: `${round.name}: ${round.themes.join(', ')}` })));
        meta.append(preview);
      }
      const btn = Object.assign(document.createElement('button'), {
        type: 'button', className: 'small', textContent: current ? t('Loaded') : p.file === loadingPackFile ? t('Loading…') : t('Load'),
      });
      // One load at a time: a second click while waiting used to start a second load.
      btn.disabled = !!p.error || current || loadingPackFile !== null;
      btn.setAttribute('aria-label', error ? t('{name} unavailable: {error}', { name: p.name, error }) : t('Load {name}', { name: p.name }));
      btn.onclick = async () => {
        loadingPackFile = p.file;
        renderPackList();
        await send('packs:load', { file: p.file });
        loadingPackFile = null;
        renderPackList();
      };
      li.append(meta, btn);
      list.append(li);
    }
  }

  // The server knows its LAN address; the browser only knows how it reached the host.
  let inviteLoaded = false;
  async function loadInvite() {
    inviteLoaded = true;
    let urls = [location.origin];
    try {
      const info = await (await fetch('/api/info')).json() as { urls?: string[] };
      urls = inviteChoices(info.urls, location.hostname, location.origin);
    } catch { /* The current origin still works for devices that reached this page. */ }
    const picker = select('#invite-address');
    picker.replaceChildren(...urls.map((u) => new Option(u.replace(/^https?:\/\//, ''), u)));
    picker.hidden = urls.length < 2;
    picker.onchange = () => showInvite(picker.value);
    showInvite(urls[0]);
  }
  function showInvite(url: string) {
    $('#invite-url').textContent = url;
    ($('#tv-link') as HTMLAnchorElement).href = `${url}/?tv`;
    // Phones join by pointing the camera at the screen instead of typing the address.
    const qr = $('#invite-qr') as HTMLImageElement;
    qr.src = `/api/invite.svg?url=${encodeURIComponent(url)}`;
    qr.classList.remove('hidden');
  }
  button('#btn-copy-invite').onclick = async () => {
    const url = $('#invite-url').textContent ?? '';
    try {
      await navigator.clipboard.writeText(url);
      toast(t('Link copied.'), 'info');
    } catch {
      // Clipboard needs a secure context; selecting the text lets the host copy it by hand.
      getSelection()?.selectAllChildren($('#invite-url'));
      toast(t('Press Ctrl+C or Cmd+C to copy the selected link.'), 'info');
    }
  };
  $('#btn-refresh-packs').addEventListener('click', refreshPacks);

  $('#pack-upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const picker = input('#pack-upload-file');
    const file = picker.files?.[0];
    const status = $('#pack-upload-status');
    if (!file || !/\.siq$/i.test(file.name)) {
      status.textContent = t('Choose a .siq pack file.');
      return;
    }
    if (!file.size || file.size > 200 * 1024 * 1024) {
      status.textContent = t('The pack must be between 1 byte and 200 MB.');
      return;
    }
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      status.textContent = t('Reconnect to the room before uploading.');
      return;
    }

    const submit = button('#pack-upload-button');
    const progress = $('#pack-upload-progress') as HTMLProgressElement;
    submit.disabled = true;
    picker.disabled = true;
    progress.classList.remove('hidden');
    progress.value = 0;
    status.textContent = t('Uploading {file}…', { file: file.name });
    try {
      // XHR exposes byte progress for large local packs; fetch does not.
      const uploaded = await new Promise<{ file: string; name: string }>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('POST', '/api/packs/upload');
        request.responseType = 'json';
        request.setRequestHeader('Content-Type', 'application/octet-stream');
        request.setRequestHeader('X-Pack-Name', encodeURIComponent(file.name));
        request.setRequestHeader('Authorization', `Bearer ${token}`);
        request.upload.onprogress = ({ loaded, lengthComputable, total }) => {
          if (!lengthComputable) return;
          progress.value = Math.min(100, Math.round(100 * loaded / total));
          status.textContent = t('Uploading {file}: {percent}%', { file: file.name, percent: progress.value });
        };
        request.onerror = () => reject(new Error(t('Upload failed. Check your connection and try again.')));
        request.onload = () => {
          const body = request.response as { file?: string; name?: string; error?: string } | null;
          if (request.status < 200 || request.status >= 300 || !body?.file) {
            reject(new Error(body?.error ? serverText(body.error) : t('Upload failed ({status}).', { status: request.status })));
          } else {
            resolve({ file: body.file, name: body.name || body.file });
          }
        };
        request.send(file);
      });
      progress.value = 100;
      picker.value = '';
      await refreshPacks();
      if (state?.game.phase === 'lobby' && state.you?.canManage) {
        const result = await send('packs:load', { file: uploaded.file });
        status.textContent = result.ok ? t('Uploaded and loaded {name}.', { name: uploaded.name })
          : t('Uploaded {name}. Select it from the pack list to load it.', { name: uploaded.name });
      } else {
        status.textContent = t('Uploaded {name}. Load it before the next game.', { name: uploaded.name });
      }
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : t('Upload failed.');
    } finally {
      picker.disabled = false;
      submit.disabled = false;
    }
  });

  let settingsOpen = false;
  const setSettingsOpen = (open: boolean) => {
    settingsOpen = open;
    if (hasActivePlayer(state)) renderManage();
  };
  button('#btn-settings').onclick = () => setSettingsOpen(!settingsOpen);
  button('#btn-close-settings').onclick = () => setSettingsOpen(false);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && settingsOpen) setSettingsOpen(false);
  });

  function renderManage() {
    const state = activeState();
    // During a game the host opens the same settings as a drawer; pack and start stay in the lobby.
    const inGame = state.game.phase !== 'lobby';
    const showManage = state.you.canManage && (!inGame || settingsOpen);
    $('#manage').classList.toggle('hidden', !showManage);
    $('#manage').classList.toggle('in-game', inGame);
    button('#btn-close-settings').classList.toggle('hidden', !inGame);
    button('#btn-settings').setAttribute('aria-expanded', String(settingsOpen && inGame));
    if (!showManage) return;
    // The server refuses switching answer mode mid-game, so the toggle says so up front.
    input('#set-oral').disabled = inGame;

    if (!packsLoaded) {
      packsLoaded = true;
      refreshPacks();
    }
    if (renderedPackFile !== (state.pack?.file ?? null)) renderPackList();
    const current = $('#pack-current');
    current.classList.toggle('empty', !state.pack);
    current.replaceChildren();
    if (state.pack) {
      const rounds = state.pack.rounds.length;
      current.append(Object.assign(document.createElement('strong'), { textContent: state.pack.name }),
        Object.assign(document.createElement('span'), {
          textContent: `${tn(state.pack.stats.questions, '{n} question', '{n} questions')} · ${tn(rounds, '{n} round', '{n} rounds')}`,
        }));
    } else current.textContent = t('No pack loaded. Pick one from the list.');

    // A checklist says exactly what is missing instead of one vague disabled button.
    const hasHost = state.participants.some((p) => p.role === 'host' && p.connected);
    const playerCount = state.participants.filter((p) => p.role === 'player' && p.connected).length;
    const waitingCount = unreadyPlayers(state.participants).length;
    const checks: [boolean, string][] = [
      [!!state.pack, state.pack ? t('Pack loaded') : t('Load a pack')],
      [hasHost, hasHost ? t('Host connected') : t('Appoint a connected host')],
      [playerCount > 0, playerCount ? tn(playerCount, '{n} player joined', '{n} players joined') : t('Wait for a player')],
    ];
    // Readiness is advice, not a gate: the host may start anyway after a confirmation.
    const readyCheck: [boolean, string] = [waitingCount === 0,
      waitingCount ? t('{done} of {total} ready', { done: playerCount - waitingCount, total: playerCount }) : t('Everyone ready')];
    const checklist = $('#start-checklist');
    checklist.replaceChildren(...[...checks, ...(playerCount ? [readyCheck] : [])].map(([done, text]) =>
      Object.assign(document.createElement('li'), { className: done ? 'done' : '', textContent: text })));
    const ready = checks.every(([done]) => done);
    button('#btn-start').disabled = !ready;
    // An offline host still holds the seat; Make host appears only once that seat is released.
    const offlineHost = state.participants.some((p) => p.role === 'host' && !p.connected);
    $('#start-hint').textContent = hasHost ? ''
      : offlineHost ? t('The host is offline. Choose Release host seat in their Manage menu, then Make host.')
        : t('Open a participant’s Manage menu and choose Make host.');

    // Sync settings inputs
    const s = state.settings;
    if (document.activeElement !== select('#set-gameMode')) select('#set-gameMode').value = s.gameMode;
    if (document.activeElement !== input('#set-falseStart')) input('#set-falseStart').checked = s.falseStart;
    $('#set-falseStart-desc').textContent = s.falseStart
      ? t('Pressing before the signal blocks the button for {seconds} s.', { seconds: s.timeForBlockingButton })
      : t('Players can buzz while the question is still being read.');

    if (document.activeElement !== select('#set-buzzSyncMode')) {
      select('#set-buzzSyncMode').value = s.buzzSyncMode;
    }
    $('#set-buzzSyncMode-desc').textContent = s.buzzSyncMode === 'clientTimestamp'
      ? t('Presses within {ms} ms are compared by device time, longer for a slow connection. Fairer on mixed Wi‑Fi.', { ms: s.buzzSyncWindowMs })
      : t('Simplest. A slower connection can lose a close press.');

    for (const key of numberSettingKeys) {
      const field = input(`#set-${key}`);
      if (document.activeElement !== field) field.value = String(s[key]);
      if (key === 'timeForBlockingButton') field.disabled = !s.falseStart;
      if (key === 'buzzSyncWindowMs') field.disabled = s.buzzSyncMode !== 'clientTimestamp';
    }
    if (document.activeElement !== $('#set-ignoreWrong')) {
      input('#set-ignoreWrong').checked = s.ignoreWrong;
    }
    if (document.activeElement !== $('#set-partialText')) {
      input('#set-partialText').checked = s.partialText;
    }
    if (document.activeElement !== $('#set-oral')) {
      input('#set-oral').checked = s.oral;
    }
    if (document.activeElement !== $('#set-playAllQuestionsInFinalRound')) {
      input('#set-playAllQuestionsInFinalRound').checked = s.playAllQuestionsInFinalRound;
    }
    if (document.activeElement !== $('#set-useApellations')) {
      input('#set-useApellations').checked = s.useApellations;
    }
    if (document.activeElement !== $('#set-soundOnHostOnly')) {
      input('#set-soundOnHostOnly').checked = s.soundOnHostOnly;
    }
    if (document.activeElement !== $('#set-lockRoom')) input('#set-lockRoom').checked = s.lockRoom;
  }

  // Settings change listeners.
  // A change saves silently otherwise; a short "Saved" mark on the field confirms it reached the room.
  const savedMarks = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  async function saveSetting(field: HTMLElement, patch: CommandPayloads['settings:update']) {
    const res = await send('settings:update', patch);
    const label = field.closest('label');
    if (!res.ok || !label) return;
    clearTimeout(savedMarks.get(label));
    label.classList.add('saved');
    savedMarks.set(label, setTimeout(() => label.classList.remove('saved'), 1500));
  }
  select('#set-gameMode').addEventListener('change', () =>
    saveSetting(select('#set-gameMode'), { gameMode: select('#set-gameMode').value }));
  select('#set-buzzSyncMode').addEventListener('change', () =>
    saveSetting(select('#set-buzzSyncMode'), { buzzSyncMode: select('#set-buzzSyncMode').value as RoomState['settings']['buzzSyncMode'] }));
  const toggleSettingKeys = [
    'falseStart', 'ignoreWrong', 'partialText', 'oral', 'playAllQuestionsInFinalRound', 'useApellations', 'soundOnHostOnly',
    'lockRoom',
  ] as const;
  for (const key of toggleSettingKeys) {
    input(`#set-${key}`).addEventListener('change', () => {
      saveSetting(input(`#set-${key}`), { [key]: input(`#set-${key}`).checked });
    });
  }
  // Settings and the special question's value step by fixed amounts; bids and wagers are typed
  // (with All in), where +1 steps would only get in the way.
  addSteppers(document.querySelectorAll<HTMLInputElement>('input[type="number"][id^="set-"], #special-price'));
  for (const key of numberSettingKeys) {
    input(`#set-${key}`).addEventListener('change', () => {
      const val = Number.parseInt(input(`#set-${key}`).value, 10);
      if (Number.isFinite(val)) saveSetting(input(`#set-${key}`), { [key]: val });
    });
  }

  /* ---------------- board & question ---------------- */

  // The pick intro is a phase of its own; while it is paused the board must keep the lit cell too.
  const isIntro = (game: RoomState['game']) => game.phase === 'intro' ||
    (game.phase === 'paused' && game.pausedPhase === 'intro');
  const roundTitle = (name: string) => /^\d+$/.test(name.trim()) ? t('Round {number}', { number: name.trim() }) : name;

  /*
   * Round entrance, played when a round starts or the host switches to one (not on reload):
   * the title card swells in, then the cells light up in a diagonal wave. The board is rebuilt on
   * every state update, so the wave is timed from the entrance start rather than from each rebuild.
   */
  const ROUND_ENTER_MS = 2200;
  let lastRoundIndex: number | undefined;
  let roundEnterAt = 0;
  function noteRoundChange(game: RoomState['game']) {
    const previous = lastRoundIndex;
    lastRoundIndex = game.roundIndex;
    if (previous === undefined || previous === game.roundIndex || !game.round) return;
    roundEnterAt = Date.now();
    // A backgrounded tab holds its animations, so the title card would pop up late over the next question.
    if (document.hidden) return;
    const splash = $('#round-splash');
    splash.textContent = roundTitle(game.round.name);
    splash.classList.remove('show');
    void splash.offsetWidth; // Restart the animation when rounds switch quickly.
    splash.classList.add('show');
  }

  // A tab hidden mid-entrance would replay the held title card on return; drop it once its time has passed.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - roundEnterAt >= ROUND_ENTER_MS) $('#round-splash').classList.remove('show');
  });

  function renderBoard() {
    const state = activeState();
    const { game, you, participants } = state;
    const board = $('#board');
    board.innerHTML = '';
    noteRoundChange(game);
    const entering = Date.now() - roundEnterAt < ROUND_ENTER_MS;
    board.classList.toggle('round-enter', entering);
    board.style.setProperty('--elapsed', `${Date.now() - roundEnterAt}ms`);
    let waveIndex = 0;
    const wave = (el: HTMLElement, step: number) => { el.style.setProperty('--d', `${520 + step * 28}ms`); };
    const lobby = game.phase === 'lobby';
    $('#lobby-table').classList.toggle('hidden', !lobby);
    const readyButton = button('#btn-ready');
    const meReady = !!participants.find((p) => p.id === you.id)?.ready;
    readyButton.classList.toggle('hidden', !lobby || tvMode || you.role !== 'player');
    readyButton.setAttribute('aria-pressed', String(meReady));
    readyButton.textContent = meReady ? t('Ready ✓ (tap to undo)') : t("I'm ready");
    if (lobby && !inviteLoaded) void loadInvite();
    board.classList.toggle('final-themes', game.phase === 'finalThemes');
    if (game.phase === 'finalThemes') {
      board.style.gridTemplateColumns = 'repeat(auto-fit, minmax(200px, 1fr))';
      const canRemove = you.canModerate || you.id === game.chooserId;
      game.board.forEach((theme, index) => {
        if (game.removedFinalThemes.includes(index) || !theme.questions[0]?.available) return;
        const el = document.createElement(canRemove ? 'button' : 'div');
        el.className = 'theme';
        el.textContent = theme.name;
        wave(el, waveIndex++ * 3);
        if (canRemove) {
          el.setAttribute('type', 'button');
          el.setAttribute('aria-label', t('Remove theme {name}', { name: theme.name }));
          el.append(Object.assign(document.createElement('small'), { textContent: t('Remove') }));
          el.onclick = () => send('game:removeFinalTheme', { themeIndex: index });
        }
        board.append(el);
      });
      return;
    }
    // During the intro the board stays up with the chosen cell flashing, like the show.
    const intro = isIntro(game);
    if (game.phase !== 'board' && !intro) {
      // Between questions the table shows where the game stands instead of disappearing.
      if (game.current || !game.round) return;
      board.style.gridTemplateColumns = '1fr';
      const card = Object.assign(document.createElement('div'), { className: 'table-title' });
      const caption = game.phase === 'roundEnd' ? t('Round complete')
        : game.phase === 'finalWager' ? t('Final wagers') : game.phase === 'paused' ? t('Paused') : '';
      card.append(Object.assign(document.createElement('strong'), { textContent: game.round.name }));
      if (caption) card.append(Object.assign(document.createElement('span'), { textContent: caption }));
      board.append(card);
      return;
    }
    const cols = Math.max(...game.board.map((t) => t.questions.length), 1);
    // Columns and rows come from CSS so the price font can follow the cell size, not the window.
    board.style.gridTemplateColumns = '';
    board.style.setProperty('--cols', String(cols));
    board.style.setProperty('--rows', String(game.board.length));
    // Phones: up to six prices share a row (a 5-column cap left every sixth price alone on a second
    // row and doubled the board's height); longer themes split into two even rows.
    const phoneCols = cols <= 6 ? cols : Math.min(5, Math.ceil(cols / 2));
    board.style.setProperty('--phone-cols', String(phoneCols));
    board.style.setProperty('--phone-cell-rows', String(game.board.length * Math.ceil(cols / phoneCols)));
    const canPick = !intro && (you.canModerate || you.id === game.chooserId);
    // The pick blink is timed from the server's intro start, so a rebuilt board continues it instead of
    // restarting, and every screen blinks in step. A paused intro shows the steady lit cell.
    const t0 = game.timer?.name === 'intro' ? game.timer.endsAt - game.timer.durationMs : null;
    board.style.setProperty('--pick-elapsed', `${t0 == null ? 60000 : Math.max(0, nowServer() - t0)}ms`);
    board.classList.toggle('has-pick', intro);
    const pickLabel = intro && game.current ? questionTypeLabel(game.current.type) : '';
    const shrinkInto = game.phase === 'board' && lastPick?.round === game.roundIndex ? lastPick : null;
    game.board.forEach((theme, ti) => {
      const title = Object.assign(document.createElement('div'), { className: 'theme', textContent: theme.name, title: theme.name });
      if (intro && game.current?.themeIndex === ti) title.classList.add('chosen-theme');
      // Hyphenation needs the text's language; packs here are mostly Ukrainian, Russian or English.
      // Letters only Ukrainian uses (і, ї, є, ґ) tell it apart from Russian.
      title.lang = /[ІіЇїЄєҐґ]/.test(theme.name) ? 'uk' : /[А-Яа-яЁё]/.test(theme.name) ? 'ru' : 'en';
      wave(title, ti);
      board.append(title);
      for (let q = 0; q < cols; q++) {
        const cell = theme.questions[q];
        const el = document.createElement(cell?.available && canPick ? 'button' : 'div');
        const chosen = intro && game.current?.themeIndex === ti && game.current?.questionIndex === q;
        el.className = 'cell' + (chosen ? ' chosen' : cell?.available ? '' : ' used');
        if (shrinkInto?.theme === ti && shrinkInto.question === q) el.classList.add('pick-target');
        wave(el, ti + q + 1);
        // A special question names its twist on the lit cell, so the room hears it before the question.
        el.textContent = chosen && pickLabel ? pickLabel : String(cell?.price ?? '');
        if (cell && !cell.available && !chosen) el.setAttribute('aria-label', t('{theme}, {price}, played', { theme: theme.name, price: cell.price }));
        if (cell?.available && canPick) {
          el.setAttribute('type', 'button');
          el.setAttribute('aria-label', t('{theme}, {price} points', { theme: theme.name, price: cell.price }));
          el.onclick = () => send('game:select', { themeIndex: ti, questionIndex: q });
        }
        board.append(el);
      }
    });
  }

  function createMediaPlayer(type: 'audio' | 'video', url: string,
    previous?: { paused: boolean; currentTime: number }, autoStart = true) {
    const wrap = document.createElement('div');
    wrap.className = 'media-wrap';

    const el = document.createElement(type);
    // Pack media starts with the question; a blocked video shows a tap button, blocked audio waits for the next tap.
    el.preload = 'auto';
    routeThroughVolume(el, url);
    // Muted, not skipped: the clip keeps its length, so reading and media timing stay the same on every device.
    el.muted = !playsSoundHere();
    el.autoplay = autoStart && state?.game.phase !== 'paused' &&
      state?.game.phase !== 'answering' && !previous?.paused;
    if (el instanceof HTMLVideoElement) {
      // Required for iPhone / iPad Safari inline playback
      el.playsInline = true;
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
    }
    el.src = url;
    // A rotated media ticket should not restart a clip the viewer paused or reset its position.
    if (previous?.paused) manuallyPausedMedia.add(el);
    if (previous && previous.currentTime > 0) {
      el.addEventListener('loadedmetadata', () => {
        try { el.currentTime = previous.currentTime; } catch { /* Some streams cannot seek. */ }
      }, { once: true });
    }
    el.addEventListener('pause', () => {
      if (gamePausedMedia.delete(el)) return;
      manuallyPausedMedia.add(el);
      el.autoplay = false;
    });
    el.addEventListener('play', () => manuallyPausedMedia.delete(el));
    wrap.append(el);

    const status = document.createElement('div');
    status.className = 'media-status hidden';
    wrap.append(status);

    // Explicitly invoke .play() and handle iOS Safari autoplay restrictions
    const canAutoPlay = () => autoStart && el.isConnected &&
      state?.game.phase !== 'paused' && state?.game.phase !== 'answering' &&
      !manuallyPausedMedia.has(el);
    const tryPlay = () => {
      // Delayed metadata and promise callbacks must respect game and manual pauses.
      if (!canAutoPlay()) return;
      const p = el.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          status.classList.add('hidden');
        }).catch(() => {
          if (!canAutoPlay()) return;
          // iOS Safari blocked unmuted autoplay -> fall back to muted autoplay + unmute button
          if (type === 'video' && !el.muted) {
            el.muted = true;
            el.play()
              .then(() => {
                status.className = 'media-status';
                status.innerHTML = '';
                const btn = Object.assign(document.createElement('button'), {
                  type: 'button',
                  className: 'media-tap-btn',
                  textContent: `🔇 ${t('Tap to unmute')}`,
                });
                btn.onclick = () => {
                  el.muted = false;
                  el.play().catch(() => {});
                  status.classList.add('hidden');
                };
                status.append(btn);
              })
              .catch(() => { if (canAutoPlay()) showTapToPlay(); });
          } else if (type === 'audio') {
            retryOnNextGesture();
          } else {
            showTapToPlay();
          }
        });
      }
    };

    const showTapToPlay = () => {
      status.className = 'media-status';
      status.innerHTML = '';
      const btn = Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'media-tap-btn',
        textContent: `▶️ ${type === 'video' ? t('Play video') : t('Play audio')}`,
      });
      btn.onclick = () => {
        el.muted = false;
        el.play()
          .then(() => status.classList.add('hidden'))
          .catch(() => {});
      };
      status.append(btn);
    };

    // Audio shows no play button (the level meter is only a picture), so a clip the browser
    // blocked starts on the player's next tap or key press anywhere on the page.
    const retryOnNextGesture = () => {
      const retry = () => {
        document.removeEventListener('pointerdown', retry, true);
        document.removeEventListener('keydown', retry, true);
        if (el.paused && !el.ended) tryPlay();
      };
      document.addEventListener('pointerdown', retry, true);
      document.addEventListener('keydown', retry, true);
    };

    // Attempt playback as soon as metadata or data arrives
    if (autoStart) {
      el.addEventListener('loadedmetadata', tryPlay, { once: true });
      setTimeout(tryPlay, 50);
    }

    return wrap;
  }

  function contentElement(it: ContentItem,
    previous?: { paused: boolean; currentTime: number }, autoStart = true): HTMLElement {
    // Pictures sit in a ratio-keeping frame so pins and the answer ring land on the right pixel.
    if (it.type === 'image' && it.url) return imageFrame(it.url);
    if ((it.type === 'audio' || it.type === 'video') && it.url) {
      return createMediaPlayer(it.type, it.url, previous, autoStart);
    }
    if (it.type === 'html' && it.url) {
      // Pack HTML stays in a sandbox; its ticketed path lets relative assets load.
      const frame = document.createElement('iframe');
      frame.className = 'question-html';
      frame.title = t('Question HTML content');
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.referrerPolicy = 'no-referrer';
      frame.src = it.url;
      frame.addEventListener('load', syncQuestionMedia);
      return frame;
    }
    return Object.assign(document.createElement('p'), {
      textContent: it.missing ? `[${t('missing {type}', { type: it.type })}: ${it.value}]` : it.value,
    });
  }

  let renderedQuestionKey: string | null = null;
  let questionPresenter: ContentPresenter<ContentItem> | null = null;
  let presenterId: string | null = null;
  let presenterFinishedId: string | null = null;
  let presenterAckingId: string | null = null;
  // Set when the question's last clip has played to the end on this device.
  let mediaEndedId: string | null = null;
  let previousContentMedia = new Map<number, { paused: boolean; currentTime: number }>();
  // A tapped but unsent picture answer survives re-renders until the player submits it.
  let pendingPick: { presentationId: string; x: number; y: number } | null = null;

  /*
   * The question card has fixed rows and never scrolls: a small meta line, the pinned prompt,
   * the media row that takes all spare height, then options, actions and the host strip.
   * Text items always go to the prompt, so it never disappears while pictures change.
   */
  interface StageSlots { box: HTMLElement; prompt: HTMLElement; media: HTMLElement; background: HTMLElement }
  let stageSlots: StageSlots | null = null;
  // Point questions draw pins on the picture; the presenter may place that picture later.
  let decorateStage: (() => void) | null = null;
  // The card keeps its size, but a window resize changes it, so the prompt is refitted then.
  new ResizeObserver(() => { if (stageSlots) fitText(stageSlots.prompt); }).observe($('#question'));
  const ANSWER_INDEX = 1000; // Keeps answer media apart from question media in the restore map.

  const isTextItem = (item: ContentItem) => (item.type === 'text' || item.type === 'say') && !item.missing;
  const slotFor = (item: ContentItem): 'prompt' | 'media' | 'background' =>
    isTextItem(item) ? 'prompt'
      : item.type === 'audio' || item.placement === 'background' ? 'background' : 'media';

  function buildStage(box: HTMLElement): StageSlots {
    const make = (className: string) => Object.assign(document.createElement('div'), { className });
    const slots = { box, prompt: make('q-prompt'), media: make('q-media'), background: make('q-background') };
    box.append(slots.prompt, slots.media, slots.background);
    return slots;
  }

  function placeContent(slots: StageSlots, item: ContentItem, index: number, autoStart: boolean): HTMLElement {
    const target = slotFor(item);
    const slot = slots[target];
    if (target === 'media') {
      // Each picture or clip replaces the previous one, as the pack's script intends.
      slot.querySelectorAll<HTMLMediaElement>('audio, video').forEach((clip) => clip.pause());
      slot.replaceChildren();
      setBackdrop(slot, item.type === 'image' ? item.url : null);
    }
    const wrapper = Object.assign(document.createElement('div'), { className: 'slot-item' });
    wrapper.dataset.contentIndex = String(index);
    const previous = previousContentMedia.get(index);
    previousContentMedia.delete(index);
    // A non-blocking background track may still be playing when its ticket rotates.
    const resumeBackground = target === 'background' && previous?.paused === false;
    const element = contentElement(item, previous, autoStart || resumeBackground);
    wrapper.append(element);
    slot.append(wrapper);
    syncStageShape(slots);
    if (target === 'media') decorateStage?.();
    return element;
  }

  function syncStageShape(slots: StageSlots) {
    const sound = () => [...slots.background.querySelectorAll<HTMLMediaElement>('audio, video')];
    // Audio has nothing to look at, so an empty media row shows that sound is playing.
    if (!slots.media.querySelector('.slot-item') && sound().length && !slots.media.querySelector('.audio-cue')) {
      slots.media.append(audioCue(sound));
    }
    slots.box.classList.toggle('has-media', slots.media.childElementCount > 0);
    slots.box.classList.toggle('has-prompt', slots.prompt.childElementCount > 0);
    requestAnimationFrame(() => fitText(slots.prompt));
  }

  function acknowledgePresentedContent() {
    if (!state?.you?.canModerate || state.game.phase !== 'reading' || !socket.connected) return;
    const current = state.game.current;
    if (!current || presenterFinishedId !== current.presentationId ||
        presenterAckingId === current.presentationId) return;
    // Blocking clips end the script themselves; other clips count once the last one has played out.
    const isClip = (item: ContentItem) => item.type === 'audio' || item.type === 'video';
    const blocking = current.content.some((item) => isClip(item) && item.waitForFinish);
    if (!blocking && !(current.content.some(isClip) && mediaEndedId === current.presentationId)) return;
    presenterAckingId = current.presentationId;
    socket.emit('game:contentFinished', { presentationId: current.presentationId }, () => {
      presenterAckingId = null;
    });
  }

  function renderOrderedContent(item: ContentItem, index: number, active: boolean,
    _replay: boolean, done: () => void) {
    if (!stageSlots) return;
    const slots = stageSlots;
    const element = placeContent(slots, item, index, active);
    if (active && isTextItem(item)) {
      // The presenter controls timing; updating one text node avoids restarting this item.
      return (visibleText: string) => { element.textContent = visibleText; fitText(slots.prompt); };
    }
    const clip = element.querySelector<HTMLMediaElement>('audio, video');
    const content = activeState().game.current?.content ?? [];
    const lastClip = content.reduce((last, entry, i) => entry.type === 'audio' || entry.type === 'video' ? i : last, -1);
    if (active && clip && index === lastClip) {
      const id = presenterId;
      const ended = () => { mediaEndedId = id; acknowledgePresentedContent(); };
      clip.addEventListener('ended', ended, { once: true });
      clip.addEventListener('error', ended, { once: true });
    }
    if (active && (item.type === 'audio' || item.type === 'video') && item.waitForFinish) {
      const media = element.querySelector<HTMLMediaElement>('audio, video');
      if (media) {
        media.addEventListener('ended', done, { once: true });
        media.addEventListener('error', done, { once: true });
      } else queueMicrotask(done); // A missing pack asset must not trap the game in reading.
    }
  }

  /** After reading, the card shows the final state of the script: every text and the last picture. */
  function renderStaticContent(slots: StageSlots, items: ContentItem[]) {
    items.forEach((item, index) => {
      if (slotFor(item) === 'media' && items.slice(index + 1).some((later) => slotFor(later) === 'media')) return;
      placeContent(slots, item, index, false);
    });
  }

  type CurrentQuestion = NonNullable<RoomState['game']['current']>;

  function answerTitle(c: CurrentQuestion): string {
    const right = c.right ?? [];
    if (c.answerType === 'select') return right.map((label) => optionText(c.answerOptions, label)).join(' / ');
    if (c.answerType === 'point') return '';
    return right[0] ?? '';
  }

  /**
   * Other accepted spellings, minus those the main answer already contains. Packs often list
   * "Title (Original, 1984)", "Title", "Original": joined, the headline said the same thing three times.
   */
  function answerAlternates(c: CurrentQuestion): string[] {
    if (c.answerType === 'select' || c.answerType === 'point') return [];
    const [main = '', ...rest] = c.right ?? [];
    const seen = main.toLocaleLowerCase();
    return rest.filter((alt) => alt.trim() && !seen.includes(alt.trim().toLocaleLowerCase()));
  }

  /** At reveal the answer takes the question's place instead of piling up under it. */
  function renderAnswerStage(slots: StageSlots, c: CurrentQuestion) {
    slots.box.classList.add('showing-answer');
    const answerItems = c.answerContent ?? [];
    const title = answerTitle(c);
    if (title) slots.prompt.append(Object.assign(document.createElement('p'), { className: 'answer-title', textContent: title }));
    const alternates = answerAlternates(c);
    if (alternates.length) {
      slots.prompt.append(Object.assign(document.createElement('p'), {
        className: 'answer-alt', textContent: t('Also accepted: {answers}', { answers: alternates.join(', ') }),
      }));
    }
    const answerTexts = answerItems.filter(isTextItem);
    answerTexts.forEach((item) => slots.prompt.append(Object.assign(document.createElement('p'), { textContent: item.value })));
    // A picture answer is marked on the question's own picture.
    if (c.answerType === 'point' || !title && !answerTexts.length) {
      c.content.filter(isTextItem).forEach((item) => slots.prompt.append(
        Object.assign(document.createElement('p'), { textContent: item.value })));
    }
    const answerMedia = answerItems.filter((item) => !isTextItem(item));
    if (c.answerType !== 'point' && answerMedia.length) {
      answerMedia.forEach((item, index) => {
        if (slotFor(item) === 'media' && answerMedia.slice(index + 1).some((later) => slotFor(later) === 'media')) return;
        placeContent(slots, item, ANSWER_INDEX + index, true);
      });
    } else {
      renderStaticContent({ ...slots, prompt: document.createElement('div') }, c.content);
    }
    const note = [c.comments, c.sources?.length ? t('Sources: {list}', { list: c.sources.join(', ') }) : ''].filter(Boolean).join(' ');
    if (note) slots.prompt.after(Object.assign(document.createElement('p'), { className: 'q-note', textContent: note, title: note }));
    syncStageShape(slots);
    reportAnswerEnd(slots, c);
  }

  // The question whose options have started to arrive; a card rebuilt after that shows them at once.
  let optionsShownId: string | null = null;
  const OPTION_STEP_MS = 300;

  // A reveal held back until the question's clips end; media events do not bubble, so the card listens in capture.
  let pendingOptionReveal: (() => void) | null = null;
  const onClipEnd = () => {
    const reveal = pendingOptionReveal;
    pendingOptionReveal = null;
    reveal?.();
  };
  $('#question').addEventListener('ended', onClipEnd, true);
  $('#question').addEventListener('error', onClipEnd, true);

  /**
   * Once the text has played and every clip has ended, the options arrive one by one; `done` runs
   * when the last is in. A question without options calls `done` at once, as before.
   */
  function revealOptions(presentationId: string, done: () => void) {
    const tiles = document.querySelector<HTMLElement>('#question .q-options.waiting');
    if (!tiles) { optionsShownId = presentationId; done(); return; }
    const clipPlaying = [...document.querySelectorAll<HTMLMediaElement>('#question audio, #question video')]
      .some((clip) => !clip.ended && !clip.error);
    if (clipPlaying) {
      pendingOptionReveal = () => revealOptions(presentationId, done);
      return;
    }
    optionsShownId = presentationId;
    tiles.style.setProperty('--step', `${OPTION_STEP_MS}ms`);
    tiles.classList.replace('waiting', 'arriving');
    setTimeout(done, tiles.childElementCount * OPTION_STEP_MS);
  }

  /** Mirrors the server's hasAnswerClip: other answers close on the server's own clock. */
  function answerHasClip(c: CurrentQuestion): boolean {
    return c.answerType !== 'point' &&
      (c.answerContent ?? []).some((item) => item.type === 'audio' || item.type === 'video');
  }

  /**
   * The server closes a question once its answer clips have played out, and only the host's device
   * can tell. A broken or missing clip counts as ended, so it never holds the question open.
   */
  function reportAnswerEnd(slots: StageSlots, c: CurrentQuestion) {
    if (!state?.you?.canModerate || state.game.phase !== 'reveal' || !answerHasClip(c)) return;
    const clips =[...slots.box.querySelectorAll<HTMLElement>('[data-content-index]')]
      .filter((item) => Number(item.dataset.contentIndex) >= ANSWER_INDEX)
      .flatMap((item) => [...item.querySelectorAll<HTMLMediaElement>('audio, video')]);
    const report = () => {
      if (clips.some((clip) => !clip.ended && !clip.error)) return;
      socket.emit('game:contentFinished', { presentationId: c.presentationId, part: 'answer' }, () => {});
    };
    clips.forEach((clip) => {
      clip.addEventListener('ended', report, { once: true });
      clip.addEventListener('error', report, { once: true });
    });
    report();
  }

  /** Pins for every picture attempt, the target ring at reveal, and the tap target for the answerer. */
  function decoratePointQuestion(slots: StageSlots, c: CurrentQuestion, pickable: boolean) {
    const frame = slots.media.querySelector<HTMLElement>('.fit');
    if (!frame) return;
    const nameOf = (id: string) => activeState().participants.find((p) => p.id === id)?.name ?? '?';
    const pins: Pin[] = c.picks.flatMap((pick) => {
      const point = parsePoint(pick.value);
      return point ? [{ ...point, label: nameOf(pick.playerId).slice(0, 1).toUpperCase(), tone: pick.correct ? 'go' : 'stop' } as Pin] : [];
    });
    const target = parsePoint(c.right?.[0]);
    // The host sees a faint ring early, to know where to look while players search.
    if (target && c.answerDeviation) drawRing(frame, target, c.answerDeviation, !c.answerShown);
    if (pickable) {
      if (pendingPick?.presentationId === c.presentationId) pins.push({ x: pendingPick.x, y: pendingPick.y, label: '', tone: 'pending' });
      makePickable(frame, (point) => {
        pendingPick = { presentationId: c.presentationId, ...point };
        renderedQuestionKey = null;
        renderQuestion();
      });
    }
    drawPins(frame, pins);
  }

  function renderQuestion() {
    const state = activeState();
    const { game, you } = state;
    const c = game.current;
    const box = $('#question');
    box.classList.toggle('hidden', !c || isIntro(game));
    if (c && isIntro(game)) return; // The card appears when reading starts, after the chosen-cell flash.

    // Update glowing border frame around question card to match stage
    box.classList.remove('frame-reading', 'frame-open', 'frame-answering');
    if (game.phase === 'reading' || game.phase === 'ready') box.classList.add('frame-reading');
    else if (game.phase === 'buzzerOpen') box.classList.add(signalPending(game) ? 'frame-reading' : 'frame-open');
    else if (game.phase === 'answering') box.classList.add('frame-answering');

    if (!c) {
      questionPresenter?.dispose();
      questionPresenter = null;
      presenterId = null;
      presenterFinishedId = null;
      renderedQuestionKey = null;
      stageSlots = null;
      decorateStage = null;
      // A hidden card keeps playing its clips, so Next must stop and drop them on every device.
      box.querySelectorAll<HTMLMediaElement>('audio, video').forEach((media) => {
        media.pause();
        media.removeAttribute('src');
        media.load();
      });
      box.replaceChildren();
      delete box.dataset.questionId;
      return;
    }
    // Avoid restarting media on every state update.
    const hiddenPhases = ['intro', 'specialSetup', 'stakeAuction', 'finalWager'];
    const contentVisible = !hiddenPhases.includes(game.phase) &&
      !(game.phase === 'paused' && hiddenPhases.includes(game.pausedPhase ?? ''));
    const presenting = contentVisible && !c.answerShown &&
      (game.phase === 'reading' || (game.phase === 'paused' && game.pausedPhase === 'reading'));
    const getReady = game.phase === 'ready' || (game.phase === 'paused' && game.pausedPhase === 'ready');
    const typed = game.buzzer.typedAnswer;
    // Only the answerer, while their answer clock runs, may tap the picture or an option.
    const canTap = game.phase === 'answering' && game.buzzer.winnerId === you.id && !!typed &&
      !typed.submitted && !typed.closed && c.answerType !== 'text';
    // Stake bids and gift setup can change the heading without changing the question index.
    // getReady is keyed too: with false starts off the countdown ends straight in buzzerOpen.
    const key = [c.presentationId, contentVisible, presenting, getReady, c.price, c.assignedId, c.answerShown,
      canTap, c.picks.length].join(':');
    if (key === renderedQuestionKey) {
      acknowledgePresentedContent();
      return;
    }
    renderedQuestionKey = key;

    const questionId = c.presentationId;
    previousContentMedia = new Map(box.dataset.questionId === questionId
      ? [...box.querySelectorAll<HTMLElement>('[data-content-index]')].flatMap((item) => {
        const media = item.querySelector<HTMLMediaElement>('audio, video');
        // A clip that never played (the get-ready card shows it still) has no state to keep;
        // carrying its "paused" over would read as a manual pause and block the clip's autostart.
        return media && media.played.length ? [[Number(item.dataset.contentIndex),
          { paused: media.paused, currentTime: media.currentTime }] as const] : [];
      }) : []);
    if (pendingPick && pendingPick.presentationId !== questionId) pendingPick = null;
    box.querySelectorAll<HTMLMediaElement>('audio, video').forEach((media) => media.pause());
    box.replaceChildren();
    box.className = box.className.replace(/\b(has-media|has-prompt|showing-answer)\b/g, '').trim();
    box.dataset.questionId = questionId;
    box.dataset.answerType = c.answerType;

    const recipient = state.participants.find((p) => p.id === c.assignedId)?.name ?? t('Player');
    const heading = Object.assign(document.createElement('h3'), { className: 'q-meta', textContent: c.type === 'secretNoQuestion'
      ? game.phase === 'specialSetup' ? t('Gift: the host is choosing who gets it')
        : t('Gift: {name} receives {amount}', { name: recipient, amount: formatScore(c.price) })
      : game.round?.type === 'final' ? `${t('Final')} · ${c.themeName}`
        : `${c.themeName} · ${formatScore(c.price)}` });
    const typeLabel = c.type === 'secretNoQuestion' || game.round?.type === 'final' ? '' : questionTypeLabel(c.type);
    if (typeLabel) heading.append(Object.assign(document.createElement('span'), { className: 'q-type', textContent: typeLabel }));
    box.append(heading);
    // The get-ready countdown sits under the heading so the question itself stays readable.
    // updateOrientiers ticks its number; the ring around it drains on the frame clock's --left.
    // The card is rebuilt when reading starts.
    if (getReady) {
      const ready = Object.assign(document.createElement('div'), { className: 'q-ready', role: 'status' });
      ready.append(
        Object.assign(document.createElement('span'), { className: 'q-ready-label', textContent: t('Get ready') }),
        Object.assign(document.createElement('b'), { className: 'q-ready-count' }),
      );
      box.append(ready);
    }
    const slots = buildStage(box);
    stageSlots = slots;
    decorateStage = contentVisible && c.answerType === 'point' ? () => decoratePointQuestion(slots, c, canTap) : null;

    if (presenting) {
      if (presenterId !== c.presentationId || !questionPresenter) {
        questionPresenter?.dispose();
        presenterId = c.presentationId;
        presenterFinishedId = null;
        pendingOptionReveal = null;
        questionPresenter = new ContentPresenter(c.content, renderOrderedContent, () => {
          // The options are part of the question: the host reports it read only once they are all in.
          revealOptions(c.presentationId, () => {
            presenterFinishedId = c.presentationId;
            acknowledgePresentedContent();
          });
        }, state.settings.timeForMediaDelay * 1000,
        state.settings.partialText && !matchMedia('(prefers-reduced-motion: reduce)').matches
          ? state.settings.readingSpeed : 0);
        questionPresenter.setPaused(game.phase === 'paused');
        questionPresenter.start();
      } else questionPresenter?.refresh();
    } else {
      questionPresenter?.dispose();
      questionPresenter = null;
      // A gift has no answer: the table says who got the points instead of staying empty (playtest F9).
      if (c.type === 'secretNoQuestion' && game.phase === 'reveal') {
        box.classList.add('showing-answer');
        slots.prompt.append(Object.assign(document.createElement('p'), {
          className: 'answer-title', textContent: `${recipient} +${formatScore(c.price)}`,
        }));
      } else if (c.answerShown && c.right) renderAnswerStage(slots, c);
      else if (contentVisible) renderStaticContent(slots, c.content);
    }

    decorateStage?.();
    if (contentVisible && c.answerType === 'select' && c.answerOptions.length) {
      const wrongPicks = new Set(c.picks.filter((pick) => !pick.correct).map((pick) => pick.value));
      const right = new Set((c.answerShown ? c.right ?? [] : []).map((label) => label.toUpperCase()));
      const tiles = optionTiles(c.answerOptions.map((option) => ({
        ...option,
        state: right.has(option.label.toUpperCase()) ? 'right' : wrongPicks.has(option.label) ? 'wrong' : 'idle',
      })), canTap ? (label) => send('game:answer', { answer: label }) : null);
      // While the question still plays its options wait, keeping their place; revealOptions brings them in.
      // The get-ready countdown comes before the clip, so the options wait through it too.
      if ((presenting || getReady) && optionsShownId !== questionId) tiles.classList.add('waiting');
      // The options stand in a column beside the picture or clip (a phone stacks them under it, in CSS).
      const split = Object.assign(document.createElement('div'), { className: 'q-split' });
      slots.media.replaceWith(split);
      split.append(slots.media, tiles);
    }
    if (canTap && c.answerType === 'point') {
      const actions = Object.assign(document.createElement('div'), { className: 'q-actions' });
      const pick = pendingPick?.presentationId === questionId ? pendingPick : null;
      const submit = Object.assign(document.createElement('button'), {
        type: 'button', className: 'primary', disabled: !pick,
        textContent: pick ? t('Submit this spot') : t('Tap the picture first'),
      });
      submit.onclick = async () => {
        if (pick && (await send('game:answer', { answer: `${pick.x},${pick.y}` })).ok) pendingPick = null;
      };
      actions.append(submit);
      box.append(actions);
    }
    // The host's private strip is its own row, so it never covers the picture.
    if (you.role === 'host' && c.right && !c.answerShown) {
      const strip = Object.assign(document.createElement('div'), { className: 'q-host' });
      const keyText = c.answerType === 'point' ? t('Marked on the picture') : answerTitle(c);
      strip.append(Object.assign(document.createElement('span'), { textContent: t('Only you see this') }),
        Object.assign(document.createElement('strong'), { textContent: keyText }));
      if (c.showmanComments) strip.append(Object.assign(document.createElement('em'), { textContent: c.showmanComments }));
      box.append(strip);
    }
    acknowledgePresentedContent();
  }

  let typedAnswerKey = '';
  function renderTypedAnswer() {
    const { game, you, participants, settings } = activeState();
    const answering = game.phase === 'answering' ||
      (game.phase === 'paused' && game.pausedPhase === 'answering');
    const typed = game.buzzer.typedAnswer;
    const winner = you.id === game.buzzer.winnerId;
    // Options and picture clicks are answered on the stage itself, not in a text box.
    const visible = !tvMode && !settings.oral && answering && !!typed && (winner || you.canModerate) &&
      (game.current?.answerType ?? 'text') === 'text';
    $('#typed-answer').classList.toggle('hidden', !visible);
    if (!visible || !typed) return;

    const key = `${game.current?.presentationId}:${game.buzzer.winnerId}`;
    if (key !== typedAnswerKey) {
      textarea('#typed-answer-input').value = '';
      typedAnswerKey = key;
    }
    const canSubmit = winner && game.phase === 'answering' && !typed.submitted && !typed.closed;
    $('#typed-answer-form').classList.toggle('hidden', !canSubmit);
    if (canSubmit) revealTurnPanel($('#typed-answer'), `typed:${key}`);
    textarea('#typed-answer-input').disabled = !canSubmit;
    const hostText = you.canModerate && typed.submitted && typed.text !== null;
    $('#typed-answer-host').classList.toggle('hidden', !hostText);
    $('#typed-answer-host').textContent = hostText ? t('Submitted answer: {answer}', { answer: typed.text ?? '' }) : '';

    const winnerName = participants.find((p) => p.id === game.buzzer.winnerId)?.name ?? t('Player');
    $('#typed-answer-status').textContent = typed.submitted
      ? you.canModerate ? t('{name} submitted an answer. Choose Correct or Wrong.', { name: winnerName })
        : t('Answer submitted. Waiting for the host verdict.')
      : typed.closed ? t('Answer time ended. Waiting for the host verdict.')
        : game.phase === 'paused' ? t('Answer time is paused.')
          : winner ? t('Type your answer before time runs out.')
            : t('Waiting for {name} to submit an answer.', { name: winnerName });
  }

  $('#typed-answer-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const field = textarea('#typed-answer-input');
    const answer = field.value.trim();
    if (answer && (await send('game:answer', { answer })).ok) field.value = '';
  });

  /* ---------------- stage banner & buzzer orientiers ---------------- */

  // Tablets and phones have no Space bar to suggest.
  const touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  type StageTone = 'reading' | 'money' | 'open' | 'answering' | 'reveal' | 'idle';
  function setStage(tone: StageTone, title: string, subtitle: string) {
    const banner = $('#stage-banner');
    banner.classList.remove('state-reading', 'state-money', 'state-open', 'state-answering', 'state-reveal', 'state-idle');
    banner.classList.add(`state-${tone}`);
    $('#stage-title').textContent = title;
    $('#stage-subtitle').textContent = subtitle;
  }

  function updateOrientiers() {
    if (!state?.you) return;
    const { game, you, participants, settings } = state;
    const now = nowServer();
    const banner = $('#stage-banner');
    const buzzerBtn = $('#buzzer');
    const nameOf = (id: string | null | undefined) => participants.find((p) => p.id === id)?.name ?? t('A player');

    // 1. Status panel: the host's "voice". It is visible from the lobby on so the layout never jumps.
    const inPlay = game.phase !== 'gameOver';
    banner.classList.toggle('hidden', !inPlay);
    if (inPlay) {
      // Named `timer`, not `t`, so the translation function stays in reach below.
      const timer = game.timer;
      const remMs = timer ? Math.max(0, timer.endsAt - now) : 0;
      const pct = timer && timer.durationMs > 0 ? Math.max(0, Math.min(100, (remMs / timer.durationMs) * 100)) : 0;
      $('#stage-countdown').textContent = timer ? String(Math.ceil(remMs / 1000)) : '';
      // The card's get-ready strip runs on the same clock; while paused it keeps its last value.
      const readyCount = document.querySelector<HTMLElement>('#question .q-ready-count');
      if (readyCount && timer?.name === 'ready') {
        readyCount.textContent = String(Math.max(1, Math.ceil(remMs / 1000)));
      }
      // With no clock the bar shows a fixed state (set below); a running clock is drawn by frameClock.
      if (!timer) $('#stage-progress-fill').style.width = `${pct}%`;
      // The table frame is the clock: its lit edge drains as the countdown runs.
      const stage = $('#game-stage');
      // The frame clock only shows the buzz window; other timers live in the banner.
      stage.classList.toggle('timed', !!timer && remMs > 0 && game.phase === 'buzzerOpen' && !signalPending(game));
      const chooser = nameOf(game.chooserId);
      const canPick = you.canModerate || game.chooserId === you.id;
      const finalist = !!game.final?.eligibleIds.includes(you.id);

      if (game.phase === 'lobby') {
        const host = participants.find((p) => p.role === 'host');
        const players = participants.filter((p) => p.role === 'player' && p.connected).length;
        setStage('idle', t('Waiting to start'), you.canManage
          ? t('Load a pack and check the settings below, then press Start game.')
          : `${tn(players, '{n} player in.', '{n} players in.')} ` + (host
            ? t('{name} starts the game when everyone is here.', { name: host.name })
            : t('A host starts the game when everyone is here.')));
      } else if (game.phase === 'intro' && game.current) {
        // The pick is announced the same way on every screen; the twist of a special question is named here.
        const c = game.current;
        const theme = game.board[c.themeIndex]?.name ?? c.themeName;
        const withPrice = t('{theme} for {price}', { theme, price: formatScore(c.price) });
        const intro: Record<string, [string, string]> = {
          secret: [theme, t('Secret question. The host picks who answers.')],
          secretPublicPrice: [withPrice, t('Secret question. The host picks who answers.')],
          secretNoQuestion: [theme, t('Gift question.')],
          stake: [withPrice, t('Auction. Players bid for the question.')],
          noRisk: [withPrice, t('No risk. A wrong answer costs nothing.')],
          forAll: [withPrice, t('Everyone answers in private.')],
        };
        const [title, subtitle] = intro[c.type] ?? [withPrice, t('Get ready.')];
        setStage('reading', title, subtitle);
        $('#stage-countdown').textContent = '';
      } else if (game.phase === 'ready') {
        // The question is already up; the banner's own clock counts down to reading.
        setStage('reading', t('Get ready'), you.role === 'host' ? t('Read the question when the countdown ends.')
          : game.current?.type === 'forAll' ? t('Read the question. Private answers open after reading.')
            : t('Read the question. The button is not live yet.'));
      } else if (game.phase === 'paused') {
        setStage('reading', t('Game paused'), you.canModerate ? t('Press Resume to continue.') : t('Waiting for the host to resume.'));
      } else if (game.phase === 'board') {
        // The pick clock only informs; at 0 nothing happens by itself, so say who moves the game on.
        // The board always starts this clock (at least 1 s) and the server drops it when it runs out,
        // so a board without a clock means the time is up.
        const pickTimeUp = !timer || remMs <= 0;
        setStage('idle', game.chooserId === you.id ? t('Your pick') : t('{name} picks next', { name: chooser }),
          !pickTimeUp ? (canPick ? t('Choose a theme and a price on the board.') : t('Waiting for a question to be chosen.'))
            : game.chooserId === you.id ? t('Time is up. Pick now, or the host picks for you.')
              : you.canModerate ? t('Time is up. Pick a question for {name}.', { name: chooser })
                : t('Time is up. Waiting for a question to be chosen.'));
      } else if (game.phase === 'finalThemes') {
        setStage('idle', game.chooserId === you.id ? t('Final round: your turn') : t('Final round'),
          canPick ? t('Remove themes until one is left.') : t('{name} removes a theme.', { name: chooser }));
      } else if (game.phase === 'specialSetup') {
        setStage('reading', game.current?.type === 'secretNoQuestion' ? t('A gift question') : t('Special question'),
          you.canModerate ? t('Choose who answers and the value below.') : t('The host is setting up this question.'));
      } else if (game.phase === 'roundEnd') {
        setStage('idle', t('Round complete'), you.canModerate ? t('Press Next to continue.') : t('The next round starts soon.'));
      } else if (game.phase === 'finalWager' && you.role === 'player' && !finalist) {
        setStage('idle', t('You sit out the final'), t('Only players with more than 0 points play it. Watch along.'));
      } else if (game.phase === 'finalWager') {
        setStage('money', you.role === 'player' ? t('Place your final wager') : t('Final wagers'),
          you.role === 'player' ? t('Your wager is private until the answers are judged.') : t('Players are placing private wagers.'));
      } else if (game.phase === 'stakeAuction') {
        // The bidder must see at a glance that it is their move (playtest F5); others see the rule.
        if (you.role === 'player' && game.auction?.turnId === you.id) setStage('money', t('Your turn to bid'), t('Bid, or pass to let others answer.'));
        else setStage('money', t('Question auction'), t('Players bid in turn for the right to answer.'));
      } else if (game.phase === 'forAllAnswering') {
        setStage('reading', t('Everyone answers'), t('Submit a private answer before time runs out.'));
      } else if (game.phase === 'forAllJudge') {
        setStage('answering', t('Checking answers'), t('The host is judging every answer.'));
      } else if (game.phase === 'appealVote') {
        setStage('answering', t('Appeal vote'), t('Eligible players are reviewing the verdict.'));
      } else if (game.phase === 'reading') {
        // The host reads the question; players get the rule for pressing.
        if (you.role === 'host') setStage('reading', t('Read the question'), game.current?.type === 'forAll'
          ? t('Private answers open when reading ends.') : t('Open the buzzer when you finish.'));
        else setStage('reading', t('Listen to the question'), game.current?.type === 'forAll'
          ? t('Private answers open after reading.')
          : !settings.falseStart ? t('You can buzz while the question plays.')
            : t('Wait for the green signal. An early press blocks you for {seconds} s.', { seconds: settings.timeForBlockingButton }));
      } else if (signalPending(game)) {
        setStage('reading', t('Get ready'), t('The buttons open in a moment.'));
      } else if (game.phase === 'buzzerOpen') {
        setStage('open', t('Buzz now'), you.role === 'player' ? (touchOnly ? t('Tap the button.') : t('Tap the button or press Space.')) : t('Players can press their buttons.'));
      } else if (game.phase === 'answering') {
        const winnerId = game.buzzer.winnerId;
        // A stand-in host who is answering waits for a verdict like any player.
        const judges = you.canModerate && winnerId !== you.id;
        const info = game.buzzer.winnerInfo;
        const reaction = info?.reactionMs != null ? ` ${t('Reaction {time}.', { time: formatReaction(info.reactionMs) })}` : '';
        const title = winnerId === you.id ? t('Your answer') : t('{name} answers', { name: nameOf(winnerId) });
        const tapType = game.current?.answerType ?? 'text';
        if (tapType !== 'text') {
          const how = tapType === 'point' ? t('Tap the picture where it is, then submit.') : t('Tap one of the options.');
          setStage('answering', title, winnerId === you.id ? how
            : tapType === 'point' ? t('Picture answer. It is checked automatically.') : t('Option answer. It is checked automatically.'));
        } else if (!settings.oral) {
          const typed = game.buzzer.typedAnswer;
          setStage('answering', title, typed?.submitted
            ? judges ? t('Answer submitted. Choose Correct or Wrong.') : t('Answer submitted. Waiting for the verdict.')
            : typed?.closed ? t('Time is up. Waiting for the verdict.')
              : winnerId === you.id ? t('Type your answer before time runs out.') : t('Waiting for a written answer.'));
        } else if (!timer || remMs <= 0) {
          // The host still judges after the answer clock ends; make that handoff explicit.
          $('#stage-countdown').textContent = '0';
          setStage('answering', title, judges ? t('Time is up. Choose Correct or Wrong.') : t('Time is up. Waiting for the verdict.'));
        } else {
          setStage('answering', title, (judges ? t('Listen, then choose Correct or Wrong.')
            : winnerId === you.id ? t('Say your answer out loud.') : t('Listen to the answer.')) + reaction);
        }
      } else if (game.phase === 'finalQuestion') {
        setStage('reading', t('Final question'), finalist ? t('Write your answer, then press Submit.')
          : you.role === 'player' ? t('You sit out the final. Watch along.') : t('Finalists are writing their answers.'));
      } else if (game.phase === 'finalJudge') {
        setStage('answering', t('Final judging'), t('The host is checking every answer.'));
      } else if (game.phase === 'reveal' && game.current?.type === 'secretNoQuestion') {
        // A gift has no answer to show; the old "Answer shown" puzzled people (playtest F9).
        setStage('reveal', t('Gift given'), timer ? t('Back to the board in a moment.') : you.canModerate ? t('Press Next to continue.') : t('Waiting for the host.'));
        if (!timer) $('#stage-progress-fill').style.width = '100%';
      } else if (game.phase === 'reveal') {
        if (game.current?.answerShown) {
          // The answer itself is on the table; saying it here too would print it twice.
          // Outside the final an answer clip has no clock: the question closes when the clip ends.
          const clipLeft = !timer && game.round?.type !== 'final' && !!game.current && answerHasClip(game.current);
          setStage('reveal', t('Answer shown'), timer ? t('Back to the board in a moment.')
            : clipLeft ? t('Back to the board when the answer ends.')
              : you.canModerate ? t('Press Next to continue.') : t('Waiting for the host.'));
          if (!timer) $('#stage-progress-fill').style.width = '100%';
        } else {
          setStage('idle', t('No one got it'), you.canModerate
            ? t('Show the answer, or press Next to return to the board.') : t('Waiting for the host.'));
          $('#stage-countdown').textContent = '';
          $('#stage-progress-fill').style.width = '0%';
        }
      } else {
        setStage('idle', game.round?.name ?? t('Game in progress'), '');
      }
    }

    // 2. Player Buzzer Button Orientier
    // Keep the fixed buzzer off finished phases so it cannot cover mobile appeal controls.
    const showBuzzer = you.role === 'player' && ['intro', 'ready', 'reading', 'buzzerOpen', 'answering'].includes(game.phase) &&
      (settings.oral || game.phase !== 'answering') &&
      game.current?.type !== 'forAll' && game.round?.type !== 'final';
    // A player's idle buzzer keeps its slot (layout.css, .slot-reserved) so the table does not resize
    // each time the buttons come and go. For-all and final questions bring their own answer cards.
    const keepSlot = you.role === 'player' && game.phase !== 'lobby' && game.phase !== 'gameOver' &&
      game.current?.type !== 'forAll' && game.round?.type !== 'final';
    buzzerBtn.classList.toggle('hidden', !showBuzzer && !keepSlot);
    buzzerBtn.classList.toggle('slot-reserved', !showBuzzer && keepSlot);
    buzzerBtn.classList.toggle('moderator-buzzer', !!you?.canModerate);
    if (!showBuzzer) return;

    buzzerBtn.classList.remove('buzz-reading', 'buzz-open', 'buzz-blocked', 'buzz-you-answering', 'buzz-idle',
      'offline', 'sent', 'not-sent');
    // Labels, offline state and press feedback live in buzzerFeedback.ts (audit UX-3).
    buzzPress.follow(`${game.current?.presentationId ?? ''}:${game.phase}`);
    const view = buzzerView(phaseLabel({ game, youId: you.id, settings, now, touchOnly, nameOf }), socket.connected, buzzPress.state);
    buzzerBtn.classList.add(view.tone, ...view.flags);
    (buzzerBtn as HTMLButtonElement).disabled = view.disabled;
    $('#buzzer-main').textContent = view.main;
    $('#buzzer-sub').textContent = view.sub;
    // "Wait" stays on screen from the pick until the buttons open, so the thumb has a home and nothing jumps.
    // Other idle states (already answered, someone else answering) only cover the podiums, so they hide.
    const idle = buzzerBtn.classList.contains('buzz-idle');
    buzzerBtn.classList.toggle('hidden', idle && !keepSlot);
    buzzerBtn.classList.toggle('slot-reserved', idle && keepSlot);
  }

  /* ---------------- fast tick for smooth countdown bars ---------------- */

  /*
   * The frame's draining edge and the banner bar move every display frame. The 100 ms tick below
   * only updates the words and numbers; at 10 updates a second the edge visibly stepped.
   */
  /*
   * Every screen turns green in the first frame past the scheduled open moment. Only cheap updates
   * run here: a full render on a slow phone took long enough to lose close presses.
   */
  let signalShownAt: number | null = null;
  function showOpenSignal() {
    const game = state?.game;
    const at = game?.phase === 'buzzerOpen' ? game.buzzer.openedAt : null;
    if (!at || at === signalShownAt || nowServer() < at) return;
    signalShownAt = at;
    $('#question').classList.replace('frame-reading', 'frame-open');
    updateOrientiers();
    // A late join into long-open buttons gets no fanfare.
    if (nowServer() - at > 1000) return;
    playTone(660, 220, 'triangle', 880);
    // A short buzz in the hand on Android; iPhones ignore it.
    if (state?.you?.role === 'player') navigator.vibrate?.(30);
  }

  function frameClock() {
    showOpenSignal();
    const t = state?.game?.timer;
    if (t && t.durationMs > 0) {
      const left = Math.max(0, Math.min(1, (t.endsAt - nowServer()) / t.durationMs));
      $('#game-stage').style.setProperty('--left', left.toFixed(4));
      $('#stage-progress-fill').style.width = `${(left * 100).toFixed(2)}%`;
    }
    requestAnimationFrame(frameClock);
  }
  requestAnimationFrame(frameClock);

  setInterval(() => {
    if (!state?.game) return;
    updateOrientiers();
  }, 100);

  /*
   * While a question is read, its words light up in step with the reading clock (the same clock
   * the table frame drains), so players see how far the host has got. A short fading edge runs
   * ahead of the lit text every frame, so the sweep glides instead of stepping a letter at a time.
   * Each letter is wrapped once in a span carrying its index (--i); per frame only the prompt's
   * --read value moves and CSS works out every letter's brightness. Nothing is rebuilt per frame,
   * so the edge moves continuously at full frame rate instead of in rebuilt eighth-letter steps.
   */
  const READ_EDGE = 12;
  // Letters by code point, so an emoji is never split into two broken halves.
  const promptLetters = new WeakMap<HTMLElement, string[]>();
  const lettersOf = (p: HTMLElement) => {
    let letters = promptLetters.get(p);
    if (!letters) promptLetters.set(p, letters = Array.from(p.textContent ?? ''));
    return letters;
  };
  // Clock resyncs can nudge the server time back a few ms; the sweep never steps backwards for them.
  let readFloor = 0;
  let readFirstLine: HTMLElement | undefined;
  function paintReadingProgress() {
    const s = state;
    if (!s?.game.current || !stageSlots || s.settings.partialText) return;
    if (s.game.phase === 'paused') return; // Keep the highlight where the pause froze it.
    const t = s.game.timer;
    const reading = s.game.phase === 'reading' && t?.name === 'reading' && t.durationMs > 0;
    // During the get-ready countdown the words wait unread (still legible), so the sweep starts at the first letter.
    const waiting = s.game.phase === 'ready';
    const prompt = stageSlots.prompt;
    const lines = [...prompt.querySelectorAll<HTMLElement>('.slot-item > p')];
    if (!reading || lines[0] !== readFirstLine) readFloor = 0;
    readFirstLine = lines[0];
    const total = lines.reduce((sum, p) => sum + lettersOf(p).length, 0);
    const done = reading && t ? Math.min(1, Math.max(0, 1 - (t.endsAt - nowServer()) / t.durationMs)) : waiting ? 0 : 1;
    // Stretch the sweep so the fading edge also finishes exactly when the clock does.
    const progress = readFloor = Math.max(readFloor, done * (total + READ_EDGE));
    const finished = !(reading || waiting) || progress >= total + READ_EDGE;
    let offset = 0;
    for (const p of lines) {
      const letters = lettersOf(p);
      if (finished && p.dataset.split) {
        // Back to plain text once read, so nothing else has to step around the letter spans.
        delete p.dataset.split;
        p.textContent = letters.join('');
      } else if (!finished && !p.dataset.split) {
        p.dataset.split = '1';
        p.replaceChildren(...letters.map((char, j) => {
          const span = Object.assign(document.createElement('span'), { textContent: char });
          span.style.setProperty('--i', String(offset + j));
          return span;
        }));
      }
      offset += letters.length;
    }
    if (!finished) {
      prompt.style.setProperty('--read', progress.toFixed(2));
      prompt.style.setProperty('--read-edge', String(READ_EDGE));
    }
  }
  const readingFrame = () => {
    paintReadingProgress();
    requestAnimationFrame(readingFrame);
  };
  requestAnimationFrame(readingFrame);


  /* ---------------- controls ---------------- */

  function triggerBuzz(event: Event) {
    // An offline press would be flushed unjoined on reconnect and silently rejected (audit CONN-2).
    if (!socket.connected) return;
    // A busy slow phone runs the handler late; the event's own time is when the finger landed.
    // Measured as an age on the monotonic clock, so wall-clock jumps cannot skew it.
    const age = Math.min(1000, Math.max(0, performance.now() - event.timeStamp));
    navigator.vibrate?.(15);
    socket.emit('game:buzz', { clientAt: Math.round(nowServer() - age) }, buzzPress.press());
  }
  $('#buzzer').addEventListener('pointerdown', triggerBuzz);
  // Keyboard and assistive clicks have no pointerdown; pointer clicks already buzz above.
  $('#buzzer').addEventListener('click', (event) => {
    if (event.detail === 0) triggerBuzz(event);
  });
  document.addEventListener('keydown', (e) => {
    const focused = document.activeElement;
    // Focused buttons use their native keyboard click, avoiding a second buzz.
    const otherControl = focused instanceof HTMLElement &&
      (focused.isContentEditable || !!focused.closest('input, textarea, select, button, a, [role="button"]'));
    if (e.code === 'Space' && state?.you?.role === 'player' && state.game.current?.type !== 'forAll' && !otherControl) {
      e.preventDefault();
      if (!e.repeat) triggerBuzz(e);
    }
  });

  /*
   * Host shortcuts: Space runs the highlighted step, Y and N give a verdict. Nothing runs during the
   * pick intro. Keys use e.code so a Russian layout works. A step that just changed ignores keys for
   * 700 ms, so a double press cannot open the buttons the moment the question appears.
   */
  // Mouse clicks drop focus before any handler runs, so Space never re-presses the last clicked control.
  document.addEventListener('click', releasePointerFocus, true);
  $('#btn-fullscreen').addEventListener('click', () => { void toggleFullscreen().catch(() => toast(t('Full screen is not available here.'))); });

  const HOST_KEYS_KEY = 'sigame.hostKeys';
  let hostKeys = true;
  try { hostKeys = localStorage.getItem(HOST_KEYS_KEY) !== 'off'; } catch { /* Keep the default. */ }
  input('#pref-hostKeys').checked = hostKeys;
  input('#pref-hostKeys').addEventListener('change', () => {
    hostKeys = input('#pref-hostKeys').checked;
    try { localStorage.setItem(HOST_KEYS_KEY, hostKeys ? 'on' : 'off'); } catch { /* Not saved. */ }
  });
  document.addEventListener('keydown', (e) => {
    if (!hostKeys || tvMode || settingsOpen || state?.you?.role !== 'host') return;
    // An open question dialog owns the keyboard (Enter, Esc, Tab between its buttons).
    if (document.querySelector('dialog[open]')) return;
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || Date.now() - stepChangedAt < 700) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement &&
      (focused.isContentEditable || focused.closest('input, textarea, select, button, a, [role="button"], #manage'))) return;
    const bar = $('#host-controls');
    const usable = (el: HTMLButtonElement | null) => el && !el.disabled && !el.classList.contains('hidden') ? el : null;
    const target = e.code === 'Space'
      ? usable(bar.querySelector<HTMLButtonElement>(':scope > button.primary'))
      : e.code === 'KeyY' ? usable(bar.querySelector<HTMLButtonElement>('[data-act="judge-ok"]'))
        : e.code === 'KeyN' ? usable(bar.querySelector<HTMLButtonElement>('[data-act="judge-bad"]')) : null;
    if (!target || bar.classList.contains('hidden')) return;
    e.preventDefault();
    target.click();
  });

  /** Where the game stands, coarsely: changes when the phase, round or question changes. */
  function gameMoment(): string {
    const game = state?.game;
    return `${game?.phase}|${game?.roundIndex}|${game?.current?.presentationId ?? ''}`;
  }

  /** The second thought a host control needs right now, or null when it acts at once. */
  function confirmQuestionFor(act: string, phase: string): ConfirmOptions | null {
    if (act === 'game:stop') {
      return { title: t('Stop this game?'), body: t('Scores and progress are reset for everyone.'), confirmLabel: t('Stop game'), danger: true };
    }
    if (act === 'game:next' && phase === 'specialSetup') {
      return { title: t('Skip this special question?'), body: t('It is marked as played and nobody gets its points.'), confirmLabel: t('Skip question') };
    }
    // Skipping while a question is up drops it without the answer, so it needs a second thought.
    if (act === 'game:next' && ['reading', 'buzzerOpen'].includes(phase)) {
      return { title: t('Skip this question?'), body: t('It returns to the board as played, without the answer.'), confirmLabel: t('Skip question') };
    }
    // The round arrows sit in the top bar, a stray click away. Once a round has ended, moving on is the normal step.
    if ((act === 'game:nextRound' || act === 'game:prevRound') && phase !== 'roundEnd') return roundJumpQuestion(act);
    return null;
  }

  function roundJumpQuestion(act: 'game:nextRound' | 'game:prevRound'): ConfirmOptions {
    const game = state?.game;
    if (act === 'game:prevRound') {
      return { title: t('Go back a round?'), body: t('The previous round restarts with its board as it was left.'), confirmLabel: t('Previous round') };
    }
    // From the last round, "next" finishes the game.
    if (game && state?.pack && game.roundIndex + 1 >= state.pack.rounds.length) {
      return { title: t('Finish the game?'), body: t('The game ends now and the final scores are shown.'), confirmLabel: t('Finish game'), danger: true };
    }
    const left = game?.board.reduce((n, theme) => n + theme.questions.filter((q) => q.available).length, 0) ?? 0;
    return {
      title: t('Skip to the next round?'),
      body: left ? tn(left, '{n} question in this round stays unplayed.', '{n} questions in this round stay unplayed.')
        : t('This round ends now.'),
      confirmLabel: t('Next round'),
    };
  }

  for (const b of document.querySelectorAll<HTMLElement>('[data-act]')) {
    b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (!act) return;
      const phase = state?.game?.phase ?? '';
      const question = confirmQuestionFor(act, phase);
      if (question) {
        const asked = gameMoment();
        if (!(await askConfirm(question))) return;
        // Timers keep running behind the dialog. A "skip" or "next round" meant for the moment the host
        // saw must not hit whatever came after it (a new question, or the next round).
        if (act !== 'game:stop' && gameMoment() !== asked) {
          toast(t('The game moved on while you decided. Nothing was changed.'));
          return;
        }
      }
      if (act === 'judge-ok') send('game:judge', { correct: true });
      else if (act === 'judge-half') send('game:judge', { correct: true, factor: 0.5 });
      else if (act === 'judge-double') send('game:judge', { correct: true, factor: 2 });
      else if (act === 'judge-bad') send('game:judge', { correct: false });
      else if (isNoPayloadCommand(act)) send(act);
    });
  }

  $('#btn-start').addEventListener('click', async () => {
    const waiting = state ? unreadyPlayers(state.participants) : [];
    if (waiting.length && !(await askConfirm({
      title: t('Start without everyone ready?'),
      body: t('Not ready yet: {names}.', { names: waiting.map((p) => p.name).join(', ') }),
      confirmLabel: t('Start anyway'),
    }))) return;
    send('game:start');
  });
  $('#btn-ready').addEventListener('click', () => {
    const me = state?.participants.find((p) => p.id === state?.you?.id);
    if (me) send('player:ready', { ready: !me.ready });
  });

  $('#steam-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#steam-log').textContent = '';
    send('steam:download', { link: input('#steam-link').value });
  });
  socket.on('steam:progress', (p) => {
    const log = $('#steam-log');
    log.textContent += `[${p.stage}] ${serverText(p.message)}${p.percent != null ? ` (${p.percent}%)` : ''}\n`;
    log.scrollTop = log.scrollHeight;
  });
  socket.on('packs:changed', () => refreshPacks());

  // Language buttons on the join screen and in the sound menu; each device keeps its own choice.
  for (const choice of document.querySelectorAll<HTMLButtonElement>('[data-lang]')) {
    choice.setAttribute('aria-pressed', String(choice.dataset.lang === lang));
    choice.onclick = () => setLang(choice.dataset.lang as Lang);
  }
})();
