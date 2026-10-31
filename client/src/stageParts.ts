/**
 * Building blocks for the question stage: a picture frame that keeps its aspect ratio,
 * picture pins and the target ring, option tiles, text that shrinks to fit, and the audio cue.
 * They only build DOM; game state and sockets stay in app.ts.
 */
import { t } from './i18n';
import type { ContentItem } from './types';

export interface Pin {
  x: number;
  y: number;
  label: string;
  tone: 'go' | 'stop' | 'pending';
}

/** Pack answers read "x,y" or "x,y,aspect" with x and y as fractions of the picture. */
export function parsePoint(value: string | null | undefined): { x: number; y: number } | null {
  const [x, y] = String(value ?? '').split(',').map((part) => Number(part.trim()));
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

/**
 * A picture inside a box sized to its own aspect ratio (CSS reads --ar), so pins and the
 * ring can be placed in percent and land on the same pixel at any screen size.
 */
export function imageFrame(url: string): HTMLElement {
  const frame = document.createElement('div');
  frame.className = 'fit';
  const img = Object.assign(document.createElement('img'), { src: url, alt: '', draggable: false });
  const measure = () => {
    if (img.naturalWidth && img.naturalHeight) frame.style.setProperty('--ar', String(img.naturalWidth / img.naturalHeight));
  };
  img.addEventListener('load', measure);
  if (img.complete) measure();
  frame.append(img);
  return frame;
}

/** Blurred copy of the picture behind it, so letterbox bars read as part of the image. */
export function setBackdrop(slot: HTMLElement, url: string | null): void {
  if (url) slot.style.setProperty('--backdrop', `url("${url.replace(/["\\]/g, '\\$&')}")`);
  else slot.style.removeProperty('--backdrop');
}

export function drawPins(frame: HTMLElement, pins: Pin[]): void {
  frame.querySelectorAll('.pin').forEach((pin) => pin.remove());
  for (const pin of pins) {
    const el = Object.assign(document.createElement('span'), { className: `pin ${pin.tone}`, textContent: pin.label });
    el.style.left = `${pin.x * 100}%`;
    el.style.top = `${pin.y * 100}%`;
    frame.append(el);
  }
}

/** Target ring; its radius is a fraction of the picture height, matching the server check. */
export function drawRing(frame: HTMLElement, target: { x: number; y: number }, deviation: number, preview = false): void {
  const ring = document.createElement('span');
  ring.className = `target-ring${preview ? ' preview' : ''}`;
  ring.style.left = `${target.x * 100}%`;
  ring.style.top = `${target.y * 100}%`;
  // Width is a percent of the frame width, so convert height units with the frame's --ar.
  ring.style.width = `calc(${deviation * 200}% / var(--ar))`;
  frame.append(ring);
}

/** Makes a picture tappable; reports the tap as fractions of the picture. */
export function makePickable(frame: HTMLElement, onPick: (point: { x: number; y: number }) => void): void {
  frame.classList.add('pickable');
  frame.setAttribute('role', 'button');
  frame.setAttribute('aria-label', t('Tap the picture where the answer is'));
  frame.addEventListener('click', (event) => {
    const box = frame.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const clamp = (n: number) => Math.min(1, Math.max(0, Math.round(n * 1000) / 1000));
    onPick({ x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) });
  });
}

export interface OptionState {
  label: string;
  content: ContentItem[];
  state: 'idle' | 'right' | 'wrong';
}

/** Lettered answer tiles; they are buttons only while the viewer may choose. */
export function optionTiles(options: OptionState[], onChoose: ((label: string) => void) | null): HTMLElement {
  const row = document.createElement('div');
  row.className = 'q-options';
  row.style.setProperty('--count', String(options.length));
  options.forEach((option, index) => {
    const tile = document.createElement(onChoose ? 'button' : 'div');
    tile.className = `option ${option.state}`;
    // Its place in the queue when the options arrive one by one.
    tile.style.setProperty('--i', String(index));
    if (tile instanceof HTMLButtonElement) {
      tile.type = 'button';
      tile.onclick = () => onChoose?.(option.label);
    }
    tile.append(Object.assign(document.createElement('b'), { textContent: option.label }));
    const body = document.createElement('span');
    for (const item of option.content) {
      if (item.type === 'image' && item.url) body.append(Object.assign(document.createElement('img'), { src: item.url, alt: '' }));
      else if (item.type === 'text' || item.type === 'say') body.append(item.value);
    }
    tile.append(body);
    row.append(tile);
  });
  return row;
}

export function optionText(options: { label: string; content: ContentItem[] }[], label: string): string {
  const option = options.find((item) => item.label.toUpperCase() === label.trim().toUpperCase());
  const words = option?.content.filter((item) => item.type === 'text' || item.type === 'say').map((item) => item.value).join(' ');
  return words ? `${label} — ${words}` : label;
}

/**
 * Shrinks the text inside a box until nothing overflows. The card never scrolls,
 * so long prompts trade size for staying fully visible.
 */
export function fitText(box: HTMLElement, minPx = 16): void {
  box.style.removeProperty('font-size');
  // A box that is not laid out yet has no size to fit into; measuring it would shrink to the floor.
  if (!box.isConnected || !box.clientWidth || !box.clientHeight) return;
  let size = parseFloat(getComputedStyle(box).fontSize);
  // Compare line boxes, not scrollHeight: glyph ink above the line would count as overflow forever.
  const overflows = () => {
    const outer = box.getBoundingClientRect();
    const first = box.firstElementChild?.getBoundingClientRect();
    const last = box.lastElementChild?.getBoundingClientRect();
    return !!first && !!last && (first.top < outer.top - 1 || last.bottom > outer.bottom + 1 ||
      box.scrollWidth > box.clientWidth + 1);
  };
  while (size > minPx && overflows()) {
    size = Math.max(minPx, size - 2);
    box.style.fontSize = `${size}px`;
  }
}

/**
 * Audio has no picture, so a level meter shows it is playing. It is only a picture, never a control:
 * a blocked clip starts on the player's next tap anywhere (see createMediaPlayer), not from here.
 */
export function audioCue(media: () => HTMLMediaElement[]): HTMLDivElement {
  const cue = Object.assign(document.createElement('div'), { className: 'audio-cue' });
  cue.setAttribute('aria-hidden', 'true');
  const bars = Object.assign(document.createElement('span'), { className: 'bars' });
  for (let i = 0; i < 5; i++) bars.append(document.createElement('i'));
  cue.append(bars);
  const sync = () => {
    cue.classList.toggle('playing', media().some((item) => !item.paused && !item.ended));
  };
  for (const item of media()) {
    for (const type of ['play', 'pause', 'ended', 'playing']) item.addEventListener(type, sync);
  }
  sync();
  return cue;
}
