/* Presentation helpers shared by the game screen: labels, avatars, toasts, and podium replics. */
import { t } from './i18n';

/** Non-blocking notice; errors stay longer because the user usually needs to act on them. */
export function toast(message: string, tone: 'error' | 'info' = 'error') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const item = Object.assign(document.createElement('div'), { className: `toast ${tone}`, textContent: message });
  item.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  host.append(item);
  setTimeout(() => item.remove(), tone === 'error' ? 6000 : 3000);
}

/** First letters of up to two words; spreads by code point so Cyrillic and emoji stay whole. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => [...part][0]).join('').toUpperCase() || '?';
}

/** Stable hue per participant id, so a person keeps their colour across reconnects and renders. */
export function avatarHue(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function avatar(id: string, name: string): HTMLElement {
  const el = Object.assign(document.createElement('span'), { className: 'avatar', textContent: initials(name) });
  el.style.setProperty('--hue', String(avatarHue(id)));
  el.setAttribute('aria-hidden', 'true');
  return el;
}

export const roleLabels: Record<string, string> = {
  host: t('Host'), player: t('Player'), spectator: t('Watching'), pending: t('Choosing a seat'),
};

/** Pack question types in words a player understands. Simple questions need no label. */
const questionTypeLabels: Record<string, string> = {
  stake: t('Auction'), noRisk: t('No risk'), secret: t('Secret'), secretPublicPrice: t('Secret'),
  secretNoQuestion: t('Gift'), forAll: t('Everyone answers'),
};
export const questionTypeLabel = (type: string): string => questionTypeLabels[type] ?? '';

/* ---------------- replics ---------------- */

export type ReplicTone = 'go' | 'stop' | 'lamp' | 'plain';
interface Replic { text: string; tone: ReplicTone; until: number }
const replics = new Map<string, Replic>();
const REPLIC_MS = 3200;

/** Remember a short line said by a participant; `onExpire` lets the caller rerender without it. */
export function sayReplic(playerId: string, text: string, tone: ReplicTone, onExpire: () => void) {
  replics.set(playerId, { text, tone, until: Date.now() + REPLIC_MS });
  setTimeout(onExpire, REPLIC_MS + 20);
}

export function replicFor(playerId: string): HTMLElement | null {
  const replic = replics.get(playerId);
  if (!replic || replic.until < Date.now()) {
    replics.delete(playerId);
    return null;
  }
  return Object.assign(document.createElement('span'), { className: `replic ${replic.tone}`, textContent: replic.text });
}

/** Score with a real minus sign and thin grouping, e.g. "−1 200". */
export function formatScore(score: number): string {
  // Narrow no-break space: a thin space let "1 000" wrap into "1" and "000" inside running text.
  const grouped = String(Math.abs(score)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  return score < 0 ? `−${grouped}` : grouped;
}
