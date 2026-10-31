/**
 * Touch browsers keep :hover after a tap, which repainted the buzzer after a press (device playtest F1).
 * Every :hover rule must therefore sit inside @media (hover: hover) and (pointer: fine).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const STYLES = new URL('../client/src/styles/', import.meta.url);
const FINE_POINTER = /@media[^{]*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)/;

/** Selectors with :hover that are not inside a fine-pointer media block. */
function bareHoverRules(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const open = []; // preludes of the blocks we are inside
  const bare = [];
  let prelude = '';
  for (const ch of source) {
    if (ch === '{') {
      const head = prelude.trim();
      if (head.includes(':hover') && !open.some((p) => FINE_POINTER.test(p))) bare.push(head);
      open.push(head);
      prelude = '';
    } else if (ch === '}') {
      open.pop();
      prelude = '';
    } else if (ch === ';') {
      prelude = ''; // a declaration or an at-rule statement such as @import
    } else {
      prelude += ch;
    }
  }
  return bare;
}

test('every :hover rule sits inside a fine-pointer media block', () => {
  const files = readdirSync(STYLES).filter((f) => f.endsWith('.css'));
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.deepEqual(bareHoverRules(readFileSync(new URL(file, STYLES), 'utf8')), [], file);
  }
});

test('the hover check catches a bare rule and accepts a wrapped one', () => {
  assert.deepEqual(bareHoverRules('a:hover { color: red; }'), ['a:hover']);
  assert.deepEqual(bareHoverRules('@media (hover: hover) and (pointer: fine) { a:hover { color: red; } }'), []);
  assert.deepEqual(bareHoverRules('@media (max-width: 600px) { a:hover { color: red; } }'), ['a:hover']);
});
