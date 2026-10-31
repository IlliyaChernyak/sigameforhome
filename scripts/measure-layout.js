/**
 * Layout check for one screen size and one game phase (device playtest, AC3/AC8).
 *
 * How to run: open the game in a browser at the size you test (DevTools device mode or the Claude
 * browser pane), get to the phase, paste this file into the console (or a page-eval tool), and read
 * the returned object. It changes nothing on the page.
 *
 * ok is true when: nothing scrolls sideways, the page does not scroll, the question text and the
 * control you act on are fully on screen, and the top-bar items do not overlap.
 */
(() => {
  const vw = innerWidth, vh = innerHeight, doc = document.documentElement;
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; };
  const inView = (r) => r.top >= -1 && r.left >= -1 && r.bottom <= vh + 1 && r.right <= vw + 1;

  const question = document.querySelector('#question:not(.hidden) .q-prompt');
  const actions = [...document.querySelectorAll('#screen-game .dock > .card:not(.hidden), #host-controls:not(.hidden):not(.slot-reserved), #buzzer:not(.hidden):not(.slot-reserved)')]
    .filter(shown);
  const topbar = [...document.querySelectorAll('.topbar > *')].filter(shown).map((el) => ({ el, r: box(el) }));
  const overlaps = [];
  for (let i = 0; i < topbar.length; i++) {
    for (let j = i + 1; j < topbar.length; j++) {
      const a = topbar[i].r, b = topbar[j].r;
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
        overlaps.push(`${topbar[i].el.className || topbar[i].el.id} x ${topbar[j].el.className || topbar[j].el.id}`);
      }
    }
  }
  const result = {
    viewport: `${vw}x${vh}`,
    phase: document.querySelector('#screen-game')?.dataset.phase,
    sidewaysScroll: doc.scrollWidth > vw + 1,
    pageScrolls: doc.scrollHeight > vh + 1 || scrollY > 0,
    question: question && shown(question) ? { ...box(question), inView: inView(box(question)) } : null,
    actions: actions.map((el) => ({ id: el.id || el.className, ...box(el), inView: inView(box(el)) })),
    topbarOverlaps: overlaps,
  };
  result.ok = !result.sidewaysScroll && !result.pageScrolls && (!result.question || result.question.inView) &&
    result.actions.every((a) => a.inView) && overlaps.length === 0;
  return result;
})();
