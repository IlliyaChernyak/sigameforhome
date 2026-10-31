/**
 * Number fields get our own − and + buttons instead of the browser's spin arrows, which look
 * different in every browser and are too small to tap. Typing and the arrow keys still work.
 */
export function addSteppers(fields: Iterable<HTMLInputElement>): void {
  for (const field of fields) {
    if (field.parentElement?.classList.contains('stepper')) continue;
    const wrap = Object.assign(document.createElement('span'), { className: 'stepper' });
    // The field comes first: a <label> labels its first labelable child, and a button there would
    // turn a click on the label text into a step. CSS puts the − button on the left.
    field.replaceWith(wrap);
    wrap.append(field, stepButton(field, -1), stepButton(field, 1));
  }
}

function stepButton(field: HTMLInputElement, direction: 1 | -1): HTMLButtonElement {
  const button = Object.assign(document.createElement('button'), {
    type: 'button', className: direction > 0 ? 'step-up' : 'step-down', textContent: direction > 0 ? '+' : '−',
    // The field itself takes the arrow keys, so the buttons stay out of the tab order and screen readers.
    tabIndex: -1,
  });
  button.setAttribute('aria-hidden', 'true');
  button.onclick = () => {
    if (field.disabled || field.readOnly) return;
    // stepUp/stepDown keep to the field's min, max and step.
    if (direction > 0) field.stepUp();
    else field.stepDown();
    // Script changes fire no events; listeners (settings save on change) must still hear this one.
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  };
  return button;
}
