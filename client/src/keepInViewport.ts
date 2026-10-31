/**
 * Slides an open popover back on screen. Popovers anchor to their button, so one whose button sits
 * near a screen edge ran past it: the podium menu low in the scoreboard column (1024x768) and the
 * sound menu on a phone, whose speaker button sits mid-bar (its mute button was off screen).
 */
const MARGIN = 8;

export function keepInViewport(panel: HTMLElement) {
  panel.style.translate = '';
  const box = panel.getBoundingClientRect();
  const dx = shiftInto(box.left, box.right, innerWidth);
  const dy = shiftInto(box.top, box.bottom, innerHeight);
  if (dx || dy) panel.style.translate = `${Math.round(dx)}px ${Math.round(dy)}px`;
}

// A panel larger than the screen keeps its start (top or left) in view: the title and first controls matter most.
function shiftInto(start: number, end: number, size: number): number {
  if (start < MARGIN) return MARGIN - start;
  const over = end - (size - MARGIN);
  return over > 0 ? -Math.min(over, start - MARGIN) : 0;
}
