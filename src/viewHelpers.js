/**
 * Markup helpers shared by every form.
 *
 * These live in JS rather than an EJS partial because an included template is
 * compiled in its own scope: a function declared inside a partial is not
 * visible to the template that included it. Registered as app locals, they are
 * available everywhere, includes included.
 */

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const INPUT_CLASS = 'w-full rounded-md border border-slate-800 bg-slate-900 px-3 py-2 '
  + 'text-sm text-slate-100 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none';

const attr = (name, value) => (value == null ? '' : ` ${name}="${escapeHtml(value)}"`);

/**
 * `stepper` opts in to the custom number control in public/js/stepper.js and
 * carries the amount each press adds. Every field built through this helper is
 * a whole-number count, so it is always 1; the fractional steppers on the
 * invoice editor's quantity inputs are written as markup there.
 */
export function field(name, label, value, opts = {}) {
  const { type = 'text', hint, placeholder, className = '', min, max, stepper } = opts;
  return `<label class="block ${escapeHtml(className)}">
  <span class="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">${escapeHtml(label)}</span>
  <input type="${escapeHtml(type)}" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${
    attr('placeholder', placeholder)
  }${attr('min', min)}${attr('max', max)}${
    stepper == null ? '' : ` data-stepper data-step-amount="${escapeHtml(stepper)}"`
  } class="${INPUT_CLASS}">
  ${hint ? `<p class="mt-1 text-xs text-slate-500">${escapeHtml(hint)}</p>` : ''}
</label>`;
}

export { escapeHtml };
