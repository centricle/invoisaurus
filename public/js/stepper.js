/**
 * Replace the native number spinner with buttons that match the rest of the UI.
 *
 * Chrome's `::-webkit-inner-spin-button` renders as a pale gray slab that no
 * amount of filtering makes look intentional on a dark field. The native one is
 * hidden in CSS; this draws a pair of chevrons inside the field instead.
 *
 * Stepping is done arithmetically rather than through `stepUp()`/`stepDown()`,
 * which frees the input from having to declare a matching `step`. A real `step`
 * would make the browser reject anything off the grid -- billing 0.1 hours
 * against `step="0.25"` fails validation on submit -- and `step="any"`, which
 * avoids that, is exactly what `stepUp()` throws on. Quantity inputs therefore
 * carry `step="any"`; the rest leave `step` unset and take the default of 1.
 */
(() => {
  // Lucide's chevron-up and chevron-down paths, drawn the same way as the
  // icon partials (24x24 viewBox, currentColor stroke, round caps and joins).
  // They are strings because this markup is built in JS, not rendered by the
  // server.
  const CHEVRON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';
  const CHEVRON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  const round = (value, decimals) => Number(value.toFixed(decimals));

  function attach(input) {
    const amount = Number(input.dataset.stepAmount || 1);
    const decimals = (String(amount).split('.')[1] || '').length;

    const wrap = document.createElement('div');
    wrap.className = 'stepper';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const buttons = document.createElement('div');
    buttons.className = 'stepper-buttons';
    buttons.innerHTML = `
      <button type="button" data-step="1" tabindex="-1" aria-label="Increase ${input.name}">${CHEVRON_UP}</button>
      <button type="button" data-step="-1" tabindex="-1" aria-label="Decrease ${input.name}">${CHEVRON_DOWN}</button>`;
    wrap.appendChild(buttons);

    buttons.addEventListener('click', (e) => {
      const button = e.target.closest('[data-step]');
      if (!button) return;
      const direction = Number(button.dataset.step);
      const current = input.value === '' ? 0 : Number(input.value);
      if (Number.isNaN(current)) return;

      let next = round(current + direction * amount, decimals);
      if (input.min !== '' && next < Number(input.min)) next = Number(input.min);
      if (input.max !== '' && next > Number(input.max)) next = Number(input.max);

      input.value = String(next);
      // Line-item totals listen for `input`, so the change has to announce itself.
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  const wire = (root) => root.querySelectorAll('input[data-stepper]:not([data-stepper-ready])')
    .forEach((input) => { input.dataset.stepperReady = 'true'; attach(input); });

  wire(document);

  // Line items are cloned in after load, so new rows need wiring too.
  new MutationObserver(() => wire(document)).observe(document.body, { childList: true, subtree: true });
})();
