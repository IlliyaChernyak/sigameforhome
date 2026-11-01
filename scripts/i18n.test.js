/**
 * Ukrainian interface: every English string the client can show has a translation.
 *
 * English text is the key (see client/src/i18n.ts), so a string added without a Ukrainian entry
 * silently stays English. This test collects the literals passed to t() and tn() and the static
 * page text, and checks each against the dictionary, including its {slots}.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { uk } from '../client/src/i18n.uk.ts';
import { t, tn } from '../client/src/i18n.ts';

const SRC = new URL('../client/src/', import.meta.url);
const HTML = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
// A quoted string literal: '…', "…" or a template without ${}.
const LITERAL = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\`[^\`$]*\``;
const unquote = (lit) => lit.slice(1, -1).replace(/\\(.)/g, '$1');
const slots = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

function codeKeys() {
  const singles = [];
  const plurals = [];
  for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts') && !f.startsWith('i18n'))) {
    const source = readFileSync(new URL(file, SRC), 'utf8');
    for (const m of source.matchAll(new RegExp(String.raw`\bt\((${LITERAL})`, 'g'))) singles.push([file, unquote(m[1])]);
    for (const m of source.matchAll(new RegExp(String.raw`\btn\([^,]+,\s*(${LITERAL}),\s*(${LITERAL})`, 'g'))) {
      plurals.push([file, unquote(m[1]), unquote(m[2])]);
    }
  }
  return { singles, plurals };
}

/** Static page text: text between tags and the readable attributes translatePage() handles. */
function pageKeys() {
  const body = HTML.slice(HTML.indexOf('<body'), HTML.indexOf('<script')).replace(/<!--[\s\S]*?-->/g, '');
  const keys = new Set();
  for (const m of body.matchAll(/>([^<>]+)</g)) {
    const text = m[1].trim();
    if (/[A-Za-z]{2}/.test(text)) keys.add(text);
  }
  for (const m of body.matchAll(/\s(?:title|placeholder|aria-label|alt)="([^"]+)"/g)) keys.add(m[1]);
  // Proper names and the language names stay as they are.
  for (const keep of ['SIGame', 'SIGame Local', 'English', 'local']) keys.delete(keep);
  return [...keys];
}

test('every t() string in the client has a Ukrainian translation with the same slots', () => {
  const { singles } = codeKeys();
  assert.ok(singles.length > 200, 'the extractor found the client strings');
  const missing = singles.filter(([, key]) => typeof uk[key] !== 'string').map(([file, key]) => `${file}: ${key}`);
  assert.deepEqual(missing, []);
  const mismatched = singles.filter(([, key]) => slots(uk[key]).join() !== slots(key).join()).map(([, key]) => key);
  assert.deepEqual(mismatched, []);
});

test('every tn() string has three Ukrainian plural forms with the same slots', () => {
  const { plurals } = codeKeys();
  assert.ok(plurals.length > 3);
  for (const [file, one, other] of plurals) {
    const forms = uk[other];
    assert.ok(Array.isArray(forms) && forms.length === 3, `${file}: ${other}`);
    for (const form of forms) assert.deepEqual(slots(form), slots(other), `${file}: ${form}`);
    assert.deepEqual(slots(one), slots(other), `${file}: ${one}`);
  }
});

test('every static page string has a Ukrainian translation', () => {
  const missing = pageKeys().filter((key) => typeof uk[key] !== 'string');
  assert.deepEqual(missing, []);
});

test('English text drawn by CSS content has a :lang(uk) override', () => {
  const styles = new URL('../client/src/styles/', import.meta.url);
  for (const file of readdirSync(styles).filter((f) => f.endsWith('.css'))) {
    const rules = [...readFileSync(new URL(file, styles), 'utf8').matchAll(/([^{}]+)\{[^}]*content:\s*"([^"]*\p{L}{2}[^"]*)"/gu)];
    const english = rules.filter(([, selector]) => !selector.includes(':lang(uk)')).length;
    const ukrainian = rules.length - english;
    assert.equal(ukrainian, english, file);
  }
});

test('outside a browser the English source text is used', () => {
  assert.equal(t('Hosted by {name}', { name: 'Ann' }), 'Hosted by Ann');
  assert.equal(tn(1, '{n} round', '{n} rounds'), '1 round');
  assert.equal(tn(5, '{n} round', '{n} rounds'), '5 rounds');
});
