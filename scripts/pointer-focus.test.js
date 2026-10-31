/**
 * Mouse clicks must not leave focus on a control (device playtest F2): Space would press it again
 * instead of running the highlighted step or the buzzer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controlToRelease } from '../client/src/pointerFocus.ts';

/** A tiny stand-in for DOM elements: closest() walks up a parent chain by tag or selector. */
function el(tag, parent = null, type = '', control = null) {
  const node = {
    tag, parent, type, control,
    matches(selector) {
      return selector.split(',').map((s) => s.trim()).some((s) =>
        s === tag || (s.startsWith('input') && tag === 'input' && s.includes(`"${type}"`)));
    },
    closest(selector) {
      for (let n = node; n; n = n.parent) if (n.matches(selector)) return n;
      return null;
    },
  };
  return node;
}

test('a mouse click releases the control, also through a span inside it', () => {
  const button = el('button');
  assert.equal(controlToRelease({ detail: 1, target: button }), button);
  assert.equal(controlToRelease({ detail: 1, target: el('span', button) }), button);
  const checkbox = el('input', null, 'checkbox');
  assert.equal(controlToRelease({ detail: 1, target: checkbox }), checkbox);
});

test('keyboard activation, text fields and dialogs keep focus', () => {
  assert.equal(controlToRelease({ detail: 0, target: el('button') }), null);
  assert.equal(controlToRelease({ detail: 1, target: el('input', null, 'text') }), null);
  assert.equal(controlToRelease({ detail: 1, target: el('button', el('dialog')) }), null);
  assert.equal(controlToRelease({ detail: 1, target: null }), null);
});

test('a click on a label releases the control it labels', () => {
  const checkbox = el('input', null, 'checkbox');
  const label = el('label', null, '', checkbox);
  assert.equal(controlToRelease({ detail: 1, target: el('span', label) }), checkbox);
  const text = el('input', null, 'text');
  assert.equal(controlToRelease({ detail: 1, target: el('label', null, '', text) }), null);
});
