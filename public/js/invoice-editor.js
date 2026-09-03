/**
 * Invoice editor: line-item arithmetic, row management, due-date inference.
 *
 * The parsing and the arithmetic deliberately mirror src/money.js: integer
 * cents, integer thousandths, round half away from zero. A running total that
 * disagrees with the server by a penny is worse than no running total at all,
 * and the server recomputes everything on save, so this has to be the same
 * arithmetic rather than a second opinion.
 *
 * Display formatting is the one part that does not mirror it. The server walks
 * the integer apart by hand (money.js formatScaled) because it also has to fill
 * form controls, where a thousands separator silently blanks the field. Nothing
 * here feeds a form control, so this uses Intl.NumberFormat over cents/100 and
 * lets the platform do it. Same output; different route to it.
 */
(() => {
  const CENTS = 100;
  const MILLI = 1000;

  const roundHalfUp = (n) => (n < 0 ? -Math.round(-n) : Math.round(n));

  function parseScaled(input, scale) {
    if (input == null) return null;
    const raw = String(input).trim().replace(/[$,\s]/g, '');
    if (raw === '' || !/^-?\d*\.?\d*$/.test(raw) || raw === '.' || raw === '-') return null;
    const negative = raw.startsWith('-');
    const [whole = '0', frac = ''] = raw.replace(/^-/, '').split('.');
    const digits = String(scale).length - 1;
    const kept = frac.slice(0, digits).padEnd(digits, '0');
    const next = frac[digits];
    let value = Number(whole) * scale + Number(kept || '0');
    if (next && Number(next) >= 5) value += 1;
    return negative ? -value : value;
  }

  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const formatCents = (cents) => usd.format(cents / CENTS);

  const form = document.querySelector('[data-invoice-form]');
  if (!form) return;

  const tbody = form.querySelector('[data-line-items]');
  const template = document.querySelector('#line-item-template');
  const totalEl = form.querySelector('[data-total]');
  const issueDateEl = form.querySelector('[name="issueDate"]');
  const termsEl = form.querySelector('[name="terms"]');
  const dueDateEl = form.querySelector('[name="dueDate"]');
  const termDays = JSON.parse(form.dataset.termDays || '{}');

  const rows = () => Array.from(tbody.querySelectorAll('[data-line-item]'));

  function recalculate() {
    let total = 0;
    for (const row of rows()) {
      const quantity = parseScaled(row.querySelector('[name="quantity[]"]').value, MILLI);
      const rate = parseScaled(row.querySelector('[name="rate[]"]').value, CENTS);
      const amount = quantity == null || rate == null ? 0 : roundHalfUp((quantity * rate) / MILLI);
      row.querySelector('[data-amount]').textContent = amount ? formatCents(amount) : '—';
      total += amount;
    }
    totalEl.textContent = formatCents(total);
    // One row is the floor: an invoice with nothing on it is not a form state
    // worth supporting, and a table with no rows has nowhere to type.
    const removable = rows().length > 1;
    for (const row of rows()) row.querySelector('[data-remove]').disabled = !removable;
  }

  function addRow() {
    const previous = rows().at(-1);
    const row = template.content.firstElementChild.cloneNode(true);
    // New rows inherit the previous rate. On a time-and-materials invoice the
    // rate is the same on nearly every line, and retyping it is where a wrong
    // number gets introduced.
    if (previous) {
      row.querySelector('[name="rate[]"]').value = previous.querySelector('[name="rate[]"]').value;
    }
    tbody.appendChild(row);
    recalculate();
    row.querySelector('[name="description[]"]').focus();
  }

  // The due date follows terms until it is edited by hand, after which it is
  // left alone — an overridden date is a deliberate act, not a stale value.
  let dueDateTouched = Boolean(dueDateEl.dataset.overridden === 'true');

  function syncDueDate() {
    if (dueDateTouched || !issueDateEl.value) return;
    const days = termDays[termsEl.value] ?? 0;
    const [y, m, d] = issueDateEl.value.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    dueDateEl.value = dt.toISOString().slice(0, 10);
  }

  form.addEventListener('input', (e) => {
    if (e.target.matches('[name="quantity[]"], [name="rate[]"]')) recalculate();
    if (e.target === dueDateEl) dueDateTouched = true;
    if (e.target === issueDateEl || e.target === termsEl) syncDueDate();
  });
  form.addEventListener('change', (e) => {
    if (e.target === termsEl) syncDueDate();
  });

  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-row]')) {
      e.preventDefault();
      addRow();
    }
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      e.preventDefault();
      if (rows().length > 1) remove.closest('[data-line-item]').remove();
      recalculate();
    }
  });

  recalculate();
})();

/**
 * Confirm a delete.
 *
 * The id comes off a data attribute rather than out of an inline `onsubmit`.
 * An inline handler is a JavaScript string literal that the browser un-escapes
 * before the JS parser sees it, so HTML escaping does not protect it and a
 * quote in the id would end the string early. Invoice ids cannot contain one
 * today -- NUMBER_PREFIX and INVOICE_ID in src/schema.js both exclude quotes --
 * which is exactly why this should not depend on that staying true.
 */
(() => {
  const form = document.querySelector('[data-delete-invoice]');
  if (!form) return;

  form.addEventListener('submit', (e) => {
    const id = form.getAttribute('data-delete-invoice');
    if (confirm(`Delete ${id}? The number will not be reused.`)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  });
})();
