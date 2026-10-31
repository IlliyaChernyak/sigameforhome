/*
 * Interface language: English or Ukrainian, chosen per device.
 *
 * The English text itself is the key (gettext style), so code stays readable and a missing
 * translation falls back to English instead of showing a key. `{name}` slots are filled after
 * lookup. Switching reloads the page: the session resumes from its token, and every string,
 * including ones built once at start-up, comes back in the new language without tracking them.
 */
import { uk, ukPatterns } from './i18n.uk';

export type Lang = 'en' | 'uk';
export const LANGS: Lang[] = ['en', 'uk'];
const LANG_KEY = 'sigame.lang';

function detectLang(): Lang {
  // Tests run without a browser; they check the English source text.
  if (typeof document === 'undefined') return 'en';
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'en' || saved === 'uk') return saved;
  } catch { /* Private mode: fall back to the browser language. */ }
  return navigator.languages?.some((code) => code.toLowerCase().startsWith('uk')) ? 'uk' : 'en';
}

export const lang: Lang = detectLang();

export function setLang(next: Lang) {
  if (next === lang) return;
  try { localStorage.setItem(LANG_KEY, next); } catch { /* Applies for this load only. */ }
  location.reload();
}

type Params = Record<string, string | number>;
const fill = (text: string, params?: Params) =>
  params ? text.replace(/\{(\w+)\}/g, (slot, key: string) => (key in params ? String(params[key]) : slot)) : text;

/** Translates an English UI string; `{slot}` placeholders are filled from `params`. */
export function t(text: string, params?: Params): string {
  const entry = lang === 'uk' ? uk[text] : undefined;
  return fill(typeof entry === 'string' ? entry : text, params);
}

/*
 * Counted text. Ukrainian has three forms (1 гравець, 2 гравці, 5 гравців), so its entry,
 * keyed by the English plural, lists them as [one, few, many]. `{n}` is always filled.
 */
const ukPlural = typeof Intl !== 'undefined' ? new Intl.PluralRules('uk') : null;
export function tn(n: number, one: string, other: string, params?: Params): string {
  const all = { n, ...params };
  const entry = lang === 'uk' ? uk[other] : undefined;
  if (!Array.isArray(entry)) return fill(n === 1 ? one : other, all);
  const form = ukPlural?.select(n);
  return fill(entry[form === 'one' ? 0 : form === 'few' ? 1 : 2], all);
}

/** Server replies are English; known ones are translated here, including those with names or numbers in them. */
export function serverText(message: string): string {
  if (lang !== 'uk') return message;
  const exact = uk[message];
  if (typeof exact === 'string') return exact;
  for (const [pattern, replacement] of ukPatterns) {
    if (pattern.test(message)) return message.replace(pattern, replacement);
  }
  return message;
}

const TRANSLATED_ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];

/** Translates the static page once at start-up: text nodes and their readable attributes. */
export function translatePage(root: HTMLElement = document.body) {
  document.documentElement.lang = lang;
  if (lang === 'en') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    const key = text.trim();
    const entry = key ? uk[key] : undefined;
    if (typeof entry === 'string') node.nodeValue = text.replace(key, () => entry);
  }
  for (const el of root.querySelectorAll<HTMLElement>(TRANSLATED_ATTRIBUTES.map((name) => `[${name}]`).join(','))) {
    for (const name of TRANSLATED_ATTRIBUTES) {
      const value = el.getAttribute(name);
      const entry = value ? uk[value] : undefined;
      if (typeof entry === 'string') el.setAttribute(name, entry);
    }
  }
}
