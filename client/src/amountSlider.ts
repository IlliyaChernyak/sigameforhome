/**
 * Bids and wagers get a slider under their number field: typing a big amount on a phone is slow,
 * and a slider shows at a glance how much of your score you put on the line. The field stays the
 * source of truth (forms read and send its value); the slider only mirrors and edits it.
 */
const sliders = new WeakMap<HTMLInputElement, HTMLInputElement>();

export function addAmountSlider(field: HTMLInputElement): void {
  if (sliders.has(field)) return;
  const slider = Object.assign(document.createElement('input'), { type: 'range', className: 'amount-slider', tabIndex: -1 });
  // The field itself takes the arrow keys, so the slider stays out of the tab order and screen readers.
  slider.setAttribute('aria-hidden', 'true');
  // Right under the field, so the submit button ends the form instead of sitting between field and slider.
  const label = field.closest('label');
  if (label) label.after(slider);
  else field.form?.append(slider);
  sliders.set(field, slider);
  slider.addEventListener('input', () => {
    // Notches run from min in round steps; the last notch means "everything", so max stays reachable
    // even when it is not on the step grid.
    const value = Number(slider.value);
    const atTop = value + Number(slider.step) > Number(slider.max);
    field.value = String(atTop ? Number(slider.max) : value);
    paint(slider, field);
  });
  field.addEventListener('input', () => syncAmountSlider(field));
}

/** Call after the app changes the field's range, value or disabled state. */
export function syncAmountSlider(field: HTMLInputElement): void {
  const slider = sliders.get(field);
  if (!slider) return;
  const min = Number(field.min) || 0;
  const max = Math.max(min, Number(field.max) || 0);
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(roundStep(max - min));
  slider.disabled = field.disabled || max <= min;
  slider.value = field.value || String(min);
  paint(slider, field);
}

// Round notches for big ranges (scores are usually hundreds), single points for small ones.
function roundStep(span: number): number {
  return span >= 1000 ? 100 : span >= 100 ? 10 : 1;
}

function paint(slider: HTMLInputElement, field: HTMLInputElement): void {
  const min = Number(slider.min);
  const span = Number(slider.max) - min;
  const value = Math.min(Number(slider.max), Math.max(min, Number(field.value) || min));
  slider.style.setProperty('--fill', `${span > 0 ? ((value - min) / span) * 100 : 0}%`);
}
