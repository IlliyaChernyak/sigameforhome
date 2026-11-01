import { t } from './i18n';

/*
 * Browsers play sound only after the viewer touches the page. Chrome remembers one touch for the
 * whole page. Safari (WebKit) forgets it after a few seconds, except on a media element whose play()
 * ran during a touch: that element may play with sound later, whatever its source. So every touch,
 * click or key press blesses a few spare elements, and clips that start by themselves take one.
 * Players tap all game long (join, buzzer, host buttons), which keeps the spares topped up.
 *
 * When there is no spare (a reload nobody has touched yet), a clip plays muted, keeping its place
 * in the room's timing, and its sound comes on with the viewer's next touch anywhere. Nothing here is
 * a control; a quiet note only says why there is no sound.
 */

// A question uses one or two self-starting clips; this covers several in a row without a touch.
const SPARES = 6;
const spares = { audio: [] as HTMLAudioElement[], video: [] as HTMLVideoElement[] };
// Blessed but not yet pooled, so the several events of one tap do not bless twice as many.
const blessing = { audio: 0, video: 0 };

function bless(): void {
  for (const type of ['audio', 'video'] as const) {
    const pool: HTMLMediaElement[] = spares[type];
    for (let i = pool.length + blessing[type]; i < SPARES; i++) {
      const el = document.createElement(type);
      blessing[type]++;
      // Pooled only after its own pause event, so that event never reaches the clip's listeners.
      el.addEventListener('pause', () => { blessing[type]--; pool.push(el); }, { once: true });
      el.play().catch(() => { /* No source yet: the call alone is the blessing. */ });
      el.pause();
    }
  }
}

/** A media element that may play with sound later on: a blessed spare when there is one. */
export function soundElement<K extends 'audio' | 'video'>(type: K): HTMLElementTagNameMap[K] {
  return (spares[type].pop() as HTMLElementTagNameMap[K] | undefined) ?? document.createElement(type);
}

// Clips the browser kept silent: null means it plays muted, a function restarts one that could not start at all.
const waiting = new Map<HTMLMediaElement, (() => void) | null>();
let note: HTMLElement | null = null;

function updateNote(): void {
  for (const el of waiting.keys()) if (!el.isConnected) waiting.delete(el);
  if (waiting.size && !note) {
    note = Object.assign(document.createElement('div'), {
      className: 'sound-note', textContent: `🔇 ${t('Touch the screen to hear the sound')}`,
    });
    note.setAttribute('role', 'status');
    document.body.append(note);
  }
  note?.classList.toggle('hidden', !waiting.size);
}

/** Plays `el` with sound when allowed, otherwise muted; `retry` runs on the next touch if even that fails. */
export function playWithSound(el: HTMLMediaElement, retry: () => void): void {
  el.play().catch((error: unknown) => {
    // Other failures (a broken clip) report through the clip's own error event.
    if ((error as Error | null)?.name !== 'NotAllowedError') return;
    if (el.muted) { waiting.set(el, retry); updateNote(); return; }
    el.muted = true;
    waiting.set(el, null);
    updateNote();
    // A phone in power saving may refuse even a muted clip; then it starts with the next touch.
    el.play().catch(() => { el.muted = false; waiting.set(el, retry); });
  });
  // A clip that leaves the card takes its note with it.
  for (const type of ['pause', 'ended', 'emptied']) el.addEventListener(type, updateNote);
}

/** Runs inside the viewer's gesture, the only moment a browser lets a page turn sound on. */
function onGesture(): void {
  bless();
  if (!waiting.size) return;
  const entries = [...waiting];
  waiting.clear();
  for (const [el, retry] of entries) {
    if (!el.isConnected) continue;
    if (retry) retry();
    else el.muted = false;
  }
  updateNote();
}
// Browsers differ in which of these counts as a gesture (Chrome ignores a touch's pointerdown, iOS
// sends no click for a tap on plain text), so all of them do; a second call finds nothing to do.
for (const type of ['pointerup', 'touchend', 'click', 'keydown']) document.addEventListener(type, onGesture, true);
