/** Banner and hint texts from the device playtest (F8 reaction time, F10 auction hint). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auctionTurnHint, formatReaction } from '../client/src/statusText.ts';

test('reaction time reads as ms under a second and as seconds above', () => {
  assert.equal(formatReaction(640), '640 ms');
  assert.equal(formatReaction(999.6), '1.0 s');
  assert.equal(formatReaction(1000), '1.0 s');
  assert.equal(formatReaction(18234), '18.2 s');
});

test('the auction hint names only the moves the buttons allow', () => {
  assert.equal(auctionTurnHint(501, true, true), 'Your turn. Bid at least 501, go all in or pass.');
  assert.equal(auctionTurnHint(500, true, false), 'Your turn. Bid at least 500 or pass.');
  assert.equal(auctionTurnHint(900, false, true), 'Your turn. Go all in or pass.');
  assert.equal(auctionTurnHint(900, false, false), 'Your turn. Pass.');
});
