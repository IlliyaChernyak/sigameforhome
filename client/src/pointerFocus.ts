/**
 * Mouse clicks must not leave focus on a control (device playtest F2).
 *
 * A clicked button keeps focus, and the Space shortcut skips focused controls so keyboard users can
 * press them natively. The result: a host clicks "next round", later presses Space for the highlighted
 * step, and the browser presses "next round" again. Releasing focus before the control's own handler
 * runs (capture phase) also makes a dialog it opens return focus to the page, not to the control.
 * Keyboard activation (detail === 0) keeps focus, so Tab + Space still works.
 */

const RELEASED = 'button, input[type="checkbox"], input[type="range"]';

interface ClickLike {
  detail: number;
  target: EventTarget | null;
}

/** The control a pointer click should release, or null when focus must stay. */
export function controlToRelease(event: ClickLike): HTMLElement | null {
  if (event.detail <= 0) return null;
  const target = event.target as Element | null;
  if (!target || typeof target.closest !== 'function') return null;
  // A dialog keeps its own focus trap and returns focus itself.
  if (target.closest('dialog')) return null;
  const control = target.closest<HTMLElement>(RELEASED);
  if (control) return control;
  // A click on a label's text: the browser forwards it to the checkbox as a click with detail 0, which
  // would keep focus, so release the labelled control here.
  const labelled = target.closest<HTMLLabelElement>('label')?.control as HTMLElement | null | undefined;
  return labelled?.matches(RELEASED) ? labelled : null;
}

export function releasePointerFocus(event: ClickLike): void {
  controlToRelease(event)?.blur();
}
