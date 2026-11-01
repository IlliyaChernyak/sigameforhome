/**
 * What the player's buzzer says, and whether the last press reached the server (audits UX-3, CONN-2).
 *
 * The buzzer used to look live while the phone was offline, and a press gave no confirmation
 * beyond the CSS :active flash. socket.io-client flushes a press buffered while offline before
 * the app resumes its session, so the server rejects it and the press was silently lost.
 * These functions are pure so the labels and the feedback rules can be unit-tested.
 */
import { t } from './i18n';
import type { RoomState } from './types';

export type BuzzTone = 'buzz-reading' | 'buzz-open' | 'buzz-blocked' | 'buzz-you-answering' | 'buzz-idle';
export type SendState = 'idle' | 'sent' | 'failed';

export interface BuzzerLabel {
  tone: BuzzTone;
  main: string;
  sub: string;
}

export interface BuzzerView extends BuzzerLabel {
  disabled: boolean;
  /** Extra classes on the button: `offline`, `sent` or `not-sent`. */
  flags: string[];
}

export interface PhaseInput {
  game: RoomState['game'];
  youId: string;
  settings: Pick<RoomState['settings'], 'falseStart' | 'timeForBlockingButton'>;
  now: number;
  touchOnly: boolean;
  nameOf: (id: string | null | undefined) => string;
}

/** How long a press may wait for the server's reply before the player is told it was not sent. */
export const ACK_TIMEOUT_MS = 2000;

/** The label for the current phase, ignoring the connection. Moved unchanged from app.ts. */
export function phaseLabel({ game, youId, settings, now, touchOnly, nameOf }: PhaseInput): BuzzerLabel {
  const label = (tone: BuzzTone, main: string, sub: string): BuzzerLabel => ({ tone, main, sub });
  const blockedUntil = game.buzzer?.blockedUntil ?? 0;
  const alreadyTried = (game.buzzer?.attempted ?? []).includes(youId);
  if (blockedUntil > now) {
    return label('buzz-blocked', t('Blocked {seconds} s', { seconds: ((blockedUntil - now) / 1000).toFixed(1) }), t('You pressed before the signal.'));
  }
  if (alreadyTried && (game.phase === 'buzzerOpen' || game.phase === 'answering')) {
    return label('buzz-idle', t('You already answered'), t('Waiting for the others.'));
  }
  if (game.phase === 'intro') {
    // Nothing can be pressed until the question appears, whatever the false-start rule says.
    return label('buzz-reading', t('Wait'), settings.falseStart
      ? t('An early press blocks you for {seconds} s.', { seconds: settings.timeForBlockingButton }) : t('Opens after the question.'));
  }
  if (game.phase === 'ready') {
    // Presses during the countdown are ignored, never punished.
    return label('buzz-reading', t('Get ready'), t('The button opens after the countdown.'));
  }
  // The open signal is scheduled a moment ahead so all screens turn green together; until then it reads as reading.
  const signalPending = game.phase === 'buzzerOpen' && now < (game.buzzer?.openedAt ?? 0);
  if (game.phase === 'reading' || signalPending) {
    return settings.falseStart
      ? label('buzz-reading', t('Wait for green'), t('An early press blocks you for {seconds} s.', { seconds: settings.timeForBlockingButton }))
      : label('buzz-open', t('Buzz'), t('Press now to answer.'));
  }
  if (game.phase === 'buzzerOpen') return label('buzz-open', t('Buzz'), touchOnly ? t('Tap here.') : t('Tap here or press Space.'));
  if (game.phase === 'answering') {
    if (game.buzzer.winnerId === youId) {
      return label('buzz-you-answering', t('Your answer'),
        (game.current?.answerType ?? 'text') === 'text' ? t('Say it out loud to the host.') : t('Tap your answer on the stage.'));
    }
    return label('buzz-idle', t('{name} answers', { name: nameOf(game.buzzer.winnerId) }), t('Get ready in case they are wrong.'));
  }
  return label('buzz-idle', t('Waiting for a question'), t('The button opens after a question is chosen.'));
}

/** Layers the connection and the last press on top of the phase label. */
export function buzzerView(phase: BuzzerLabel, connected: boolean, send: SendState): BuzzerView {
  // An idle buzzer is hidden anyway; the connection bar already says the phone is offline.
  if (!connected && phase.tone !== 'buzz-idle') {
    return { tone: 'buzz-blocked', main: t('Offline'), sub: t('Not connected. Presses do not count until you are back.'),
      disabled: true, flags: ['offline'] };
  }
  if (send === 'failed') {
    return { ...phase, main: t('Not sent'), sub: t('Your press did not reach the game. Press again.'), disabled: false,
      flags: ['not-sent'] };
  }
  return { ...phase, disabled: false, flags: send === 'sent' ? ['sent'] : [] };
}

/**
 * Tracks one press until the server answers. `press()` returns the ack callback to pass to emit.
 * Timers are injected so tests can drive them.
 */
export function createPressTracker(onChange: () => void, timers: {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
} = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as number) }) {
  let state: SendState = 'idle';
  let pending: unknown = null;
  const set = (next: SendState) => {
    if (pending !== null) timers.clearTimeout(pending);
    pending = null;
    if (state !== next) { state = next; onChange(); }
  };
  let followed: string | null = null;
  return {
    get state() { return state; },
    press(): (ack?: { ok?: boolean }) => void {
      set('sent');
      const handle = timers.setTimeout(() => { if (pending === handle) set('failed'); }, ACK_TIMEOUT_MS);
      pending = handle;
      return (ack) => {
        if (pending !== handle) return; // a reply after the timeout or a newer press changes nothing
        set(ack?.ok ? 'sent' : 'failed');
      };
    },
    /**
     * A new question or phase starts with a clean button. Called while rendering, so it stays
     * silent instead of asking for another render.
     */
    follow(key: string) {
      if (key === followed) return;
      followed = key;
      if (pending !== null) timers.clearTimeout(pending);
      pending = null;
      state = 'idle';
    },
  };
}
