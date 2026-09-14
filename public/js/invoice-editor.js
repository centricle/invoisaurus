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
    if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return null;
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

  /**
   * Size a field to its content.
   *
   * A description used to be a single-line input, so a long one scrolled
   * sideways out of sight while you were typing the thing the client reads.
   * CSS `field-sizing: content` does this in one line but Firefox does not
   * implement it, and the reset to `auto` first is what lets the field shrink
   * again after a deletion rather than only ever growing.
   *
   * Writes `style.height` and nothing else. Touching `.value` here would make
   * the unsaved-changes guard below see a freshly loaded page as edited.
   */
  const autogrow = (el) => {
    el.style.height = 'auto';
    // scrollHeight measures the padding box, but the field is border-box, so
    // the borders have to be added back. Without them every description sat
    // two pixels shorter than the quantity input beside it.
    const borders = el.offsetHeight - el.clientHeight;
    el.style.height = `${el.scrollHeight + borders}px`;
  };

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
    autogrow(row.querySelector('[data-autogrow]'));
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
    if (e.target.matches('[data-autogrow]')) autogrow(e.target);
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

  for (const el of form.querySelectorAll('[data-autogrow]')) autogrow(el);
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
 *
 * This file loads as a regular script and public/js/unsaved.js is deferred, so
 * this listener is registered before that one's. Canceling here stops the
 * unsaved-changes guard from ever seeing the submit and concluding the page is
 * on its way out.
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

/**
 * Restyle without leaving the preview.
 *
 * The style buttons are submit buttons on the editor form (see
 * src/views/partials/style-toggle.ejs). On their own, a click saves, the server
 * redirects back to the editor, and the reload lands at the top of the page, a
 * screen away from the preview the click was meant to change.
 *
 * Here the same POST is sent in the background and two things on the page are
 * replaced. The toggle is taken from the page the redirect returns, so its
 * markup stays the server's and none of its classes are copied into this file.
 * The preview is pointed at the PDF again with a query value that changes every
 * time, so the browser cannot answer from its cache.
 *
 * Only when restyling is the whole of what the save does. With unsaved edits in
 * the form, the click falls back to the ordinary submit: that save can change
 * the status, the client, the heading and the total, and refreshing only the
 * preview would leave the page showing half the old record and half the new
 * one. Any failure falls back the same way. A 422 has errors to show, and the
 * ordinary submit is what renders them.
 *
 * public/js/unsaved.js needs nothing from this. It compares the form to how it
 * loaded, and this path runs only while those still match and leaves the form
 * as it found it, so the save bar stays hidden through a restyle.
 */
(() => {
  const form = document.querySelector('[data-invoice-form]');
  const preview = document.querySelector('[data-pdf-preview]');
  if (!form || !preview) return;

  const snapshot = () => new URLSearchParams(new FormData(form)).toString();
  const loaded = snapshot();
  let busy = false;

  // Delegated from the document, because each successful restyle replaces the
  // buttons with the server's fresh copies.
  document.addEventListener('click', async (e) => {
    const button = e.target.closest(`button[name="style"][form="${form.id}"]`);
    if (!button) return;
    e.preventDefault();
    if (busy || button.getAttribute('aria-pressed') === 'true') return;
    if (snapshot() !== loaded) {
      form.requestSubmit(button);
      return;
    }

    const group = button.closest('[role="group"]');
    busy = true;
    group.setAttribute('aria-busy', 'true');
    try {
      const body = new URLSearchParams(new FormData(form));
      body.set('style', button.value);
      // The update route answers a good save with a redirect to the editor and
      // a bad one with a 422, so a followed redirect is the success signal.
      const res = await fetch(form.action, { method: 'POST', body });
      if (!res.ok || !res.redirected) throw new Error(`Save answered ${res.status}`);

      const page = new DOMParser().parseFromString(await res.text(), 'text/html');
      const fresh = page.querySelector('[role="group"][aria-label="PDF style"]');
      if (!fresh) throw new Error('No style toggle on the saved page');

      const src = new URL(preview.src);
      src.searchParams.set('v', Date.now());
      group.replaceWith(fresh);
      preview.src = src.href;
      // The clicked button is gone with the old group. Without this a keyboard
      // user is dropped back at the top of the document.
      fresh.querySelector('[aria-pressed="true"]')?.focus();
    } catch {
      form.requestSubmit(button);
    } finally {
      busy = false;
      group.removeAttribute('aria-busy');
    }
  });
})();
