/**
 * One-shot confirmation messages.
 *
 * A confirmation belongs to a single moment, not to a URL. Carrying it in the
 * query string would put prose in the address bar
 * (`?saved=Invoice%20ACM-0001%20created.`) and leave it there to be bookmarked,
 * shared, and re-shown on every refresh. A cookie carries a short code across
 * the redirect and is cleared as soon as it is read, so the address bar only
 * ever shows the resource: `/invoices/ACM-0001`.
 *
 * The message text stays on the server. The wire carries a code from the fixed
 * set below, plus at most one argument -- which is a record's own name or id,
 * so it does come from user input and does reach the page. It is never markup:
 * an unrecognized code is rejected rather than rendered, and the argument is
 * interpolated into a known sentence and HTML-escaped on render.
 *
 * The lookups use `Object.hasOwn` rather than truthiness. `MESSAGES[code]`
 * alone reaches Object.prototype, so a cookie of `constructor:anything` finds
 * `Object`, calls it, and renders the attacker's argument back in a success
 * banner; `toString` renders "[object Object]". Escaped either way, so not
 * markup injection -- but "a code from the fixed set" has to mean the set.
 */
const COOKIE = 'flash';

const MESSAGES = {
  'invoice-created': (id) => `Invoice ${id} created.`,
  'invoice-saved': () => 'Invoice saved.',
  'invoice-deleted': (id) => `Invoice ${id} deleted. Its number will not be reused.`,
  'client-created': (name) => `${name} added.`,
  'client-saved': () => 'Client saved.',
  'vendor-created': (name) => `${name} added.`,
  'vendor-saved': () => 'Vendor saved.',
};

export function setFlash(res, code, arg = '') {
  if (!Object.hasOwn(MESSAGES, code)) throw new Error(`Unknown flash code: ${code}`);
  res.cookie(COOKIE, arg ? `${code}:${arg}` : code, {
    path: '/', httpOnly: true, sameSite: 'lax', maxAge: 30_000,
  });
}

/** Read and immediately clear. A confirmation should not survive a refresh. */
export function takeFlash(req, res) {
  const raw = req.headers.cookie || '';
  const entry = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`));
  if (!entry) return '';

  res.clearCookie(COOKIE, { path: '/' });

  const value = decodeURIComponent(entry.slice(COOKIE.length + 1));
  const separator = value.indexOf(':');
  const code = separator === -1 ? value : value.slice(0, separator);
  const arg = separator === -1 ? '' : value.slice(separator + 1);

  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code](arg) : '';
}
