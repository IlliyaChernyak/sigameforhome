/**
 * Text and links the host shares out of the game (audits QOL-6, UX-6). Pure, so they are testable.
 */
import { t } from './i18n';

/** Final standings as plain text for a chat message: "1. Alex — 1,200". Shared places repeat. */
export function resultsText(ranking: { name: string; score: number }[], packName?: string): string {
  const lines = ranking.map((p) => {
    const place = ranking.findIndex((other) => other.score === p.score) + 1;
    return `${place}. ${p.name} — ${p.score.toLocaleString()}`;
  });
  return [packName ? t('SIGame results: {pack}', { pack: packName }) : t('SIGame results'), ...lines].join('\n');
}

/**
 * The join links to offer. On the host machine (localhost) the browser's own address is useless
 * to phones, so the server's LAN addresses are used; with several adapters the host picks one,
 * because the first may be a VPN or virtual adapter phones cannot reach.
 */
export function inviteChoices(serverUrls: string[] | undefined, hostname: string, origin: string): string[] {
  const local = hostname === 'localhost' || hostname === '127.0.0.1';
  return local && serverUrls?.length ? serverUrls : [origin];
}
