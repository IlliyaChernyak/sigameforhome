/* Small pure texts for banners and hints, kept apart from the DOM so tests can check them. */
import { t } from './i18n';

/** Reaction time as people read it: "640 ms" under a second, "18.2 s" above (device playtest F8). */
export function formatReaction(ms: number): string {
  const rounded = Math.round(ms);
  return rounded < 1000 ? t('{ms} ms', { ms: rounded }) : t('{s} s', { s: (rounded / 1000).toFixed(1) });
}

/** The bidder's hint names only the moves their buttons allow (device playtest F10). */
export function auctionTurnHint(minimumNextBid: number, canBid: boolean, canAllIn: boolean): string {
  const moves = [canBid ? t('bid at least {amount}', { amount: minimumNextBid }) : '', canAllIn ? t('go all in') : '', t('pass')].filter(Boolean);
  const list = moves.length > 1 ? t('{first} or {last}', { first: moves.slice(0, -1).join(', '), last: moves.at(-1)! }) : moves[0];
  return t('Your turn. {moves}.', { moves: `${list[0].toUpperCase()}${list.slice(1)}` });
}
