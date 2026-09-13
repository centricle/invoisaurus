/**
 * The single definition of the data model.
 *
 * Records are stored as JSON but shaped relationally, so that migrating to
 * Postgres later is a schema translation rather than a redesign: stable string
 * ids, no nested collections except an invoice's own line items, no derived
 * values that a query could not recompute.
 */
import { lineAmountCents, sumCents, formatUSD, MAX_CENTS } from './money.js';
import { unrepresentable } from './lib/pdf/layout.js';

export const SCHEMA_VERSION = 2;

/**
 * The version at which the meaning of `description` and `notes` changed.
 *
 * Version 1 records held plain text. Version 2 records hold the formatting
 * subset in src/lib/markup.js, where `*` opens emphasis and a line beginning
 * `- ` is a bullet. That is a change to what a stored string *means*, which is
 * what a schema version is for, and it is why an invoice carries its own:
 * re-rendering a document issued in 2026 must produce the document that was
 * issued, not today's reading of it.
 *
 * Only src/lib/pdf/generate.js consults this. Everything else treats both
 * versions identically, because the record shape is the same.
 */
export const MARKUP_SCHEMA_VERSION = 2;

export const CLIENT_TYPES = ['business', 'individual'];

export const TERMS = [
  { id: 'on-receipt', label: 'Due on Receipt', days: 0 },
  { id: 'net15', label: 'Net 15', days: 15 },
  { id: 'net30', label: 'Net 30', days: 30 },
  { id: 'net45', label: 'Net 45', days: 45 },
  { id: 'net60', label: 'Net 60', days: 60 },
];

export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'void'];

/**
 * The visual styles an invoice may be drawn in.
 *
 * The drawers themselves live in src/lib/pdf/styles/. This list is here, with
 * the statuses and the terms, because it is part of what a record may say --
 * and because a schema.js that imported the drawers would close a cycle
 * (classic.js needs addressLines and termById from this file) and drag pdf-lib
 * into every route and every test that touches a record. A test asserts the
 * two lists agree.
 *
 * Classic is first, and first is the fallback: an invoice written before this
 * existed carries no style at all, and it was sent in Classic.
 */
export const INVOICE_STYLES = [
  { id: 'classic', label: 'Classic' },
  { id: 'modern', label: 'Modern' },
];

export const DEFAULT_STYLE = INVOICE_STYLES[0].id;

export const styleById = (id) => INVOICE_STYLES.find((s) => s.id === id) || INVOICE_STYLES[0];

/** A style id a record may hold: a known one, or the fallback. */
export const styleId = (id) => (INVOICE_STYLES.some((s) => s.id === id) ? id : DEFAULT_STYLE);

export const termById = (id) => TERMS.find((t) => t.id === id) || TERMS[0];

/** Dates are stored as plain `YYYY-MM-DD` strings, never Date objects. A due
 *  date is a calendar fact and must not shift because of a timezone. */
export function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export const dueDateFor = (issueDate, termsId) => addDays(issueDate, termById(termsId).days);

export const today = () => new Date().toLocaleDateString('en-CA');

/** URL- and filename-safe id from a display name. */
export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// --- Address ---------------------------------------------------------------

export const emptyAddress = () => ({ street: '', street2: '', city: '', state: '', zip: '' });

/** Render an address to the lines an invoice actually prints. */
export function addressLines(addr = {}) {
  const cityLine = [addr.city, [addr.state, addr.zip].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
  return [addr.street, addr.street2, cityLine].filter((line) => line && line.trim());
}

// --- Vendor ----------------------------------------------------------------

export function makeVendor(input = {}) {
  return {
    id: input.id || slugify(input.name || ''),
    name: input.name || '',
    email: input.email || '',
    address: { ...emptyAddress(), ...(input.address || {}) },
    numberPrefix: input.numberPrefix ?? '',
    numberPad: Number(input.numberPad ?? 4),
    nextNumber: Number(input.nextNumber ?? 1),
    // The style new invoices from this vendor start in. It is copied onto the
    // invoice at creation and never read again, so changing it here does not
    // restyle anything already issued.
    defaultStyle: styleId(input.defaultStyle),
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

/**
 * Invoice ids are filenames. The prefix is the only part a human types, so it
 * is the only part that needs constraining; the rest is zero-padded digits.
 */
export const NUMBER_PREFIX = /^[A-Za-z0-9._-]{1,16}$/;

/**
 * A whole invoice id: prefix plus padded digits, and therefore the same
 * character set. Anything else is not a record this app wrote.
 */
export const INVOICE_ID = /^[A-Za-z0-9._-]+$/;

/** Numbers are per-vendor: the invoice number is the issuing entity's book. */
export const formatInvoiceNumber = (vendor, n) =>
  `${vendor.numberPrefix}${String(n).padStart(vendor.numberPad, '0')}`;

// --- Client ----------------------------------------------------------------

export function makeClient(input = {}) {
  return {
    id: input.id || slugify(input.displayName || input.name || ''),
    name: input.name || '',                  // legal name, renders on the invoice
    displayName: input.displayName || '',    // optional friendly name, dropdowns only
    type: CLIENT_TYPES.includes(input.type) ? input.type : 'business',
    contactName: input.contactName || '',    // optional, renders on the Attn: line
    address: { ...emptyAddress(), ...(input.address || {}) },
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

export const clientLabel = (client) => client.displayName || client.name;

// --- Invoice ---------------------------------------------------------------

export const makeLineItem = (input = {}) => ({
  description: input.description || '',
  quantityMilli: input.quantityMilli ?? null,
  rateCents: input.rateCents ?? null,
});

/**
 * Snapshots, not references.
 *
 * An invoice is a record of what was sent, not a live view of the registry. If
 * a client moves, regenerating a two-year-old invoice must still print the old
 * address. `clientId` and `vendorId` stay on the record for querying, but every
 * value that appears on the page is frozen here at issue time.
 */
export const snapshotVendor = (vendor) => ({
  name: vendor.name,
  email: vendor.email,
  address: { ...vendor.address },
});

export const snapshotClient = (client) => ({
  name: client.name,
  contactName: client.contactName,
  type: client.type,
  address: { ...client.address },
});

export function makeInvoice(input = {}) {
  const issueDate = input.issueDate || today();
  const terms = input.terms || 'net30';
  return {
    // Preserved, not stamped. A record keeps the version it was written under
    // for its whole life, so editing an invoice from before the formatting
    // subset does not silently reinterpret the text already on it.
    schemaVersion: input.schemaVersion ?? SCHEMA_VERSION,
    id: input.id || '',            // the formatted number, e.g. ACM-0001
    number: input.number ?? null,  // the raw integer, for sorting
    vendorId: input.vendorId || '',
    clientId: input.clientId || '',
    remitFrom: input.remitFrom || null,
    billTo: input.billTo || null,
    issueDate,
    terms,
    dueDate: input.dueDate || dueDateFor(issueDate, terms),
    lineItems: (input.lineItems || []).map(makeLineItem),
    notes: input.notes || '',
    status: INVOICE_STATUSES.includes(input.status) ? input.status : 'draft',
    style: styleId(input.style),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Is this a real, exact, plausible money value?
 *
 * `Number.isSafeInteger` is the load-bearing half. An amount past 2^53 is not
 * an exact integer any more, so comparing it against a ceiling is already
 * comparing an approximation -- test that it is a safe integer first, then that
 * it is sane.
 */
const withinBounds = (cents) => Number.isSafeInteger(cents) && Math.abs(cents) <= MAX_CENTS;

/** Totals are derived, never stored. A stored total is a total that can lie. */
export function invoiceTotals(invoice) {
  const amounts = invoice.lineItems.map((li) => lineAmountCents(li.quantityMilli, li.rateCents));
  return { amounts, totalCents: sumCents(amounts) };
}

/**
 * @param refs  The vendor and client the ids resolve to, or null when they do
 *              not resolve. A non-empty id is not the same as a real record:
 *              an invoice pointing at a deleted or misspelled client would save
 *              happily and render a PDF with an empty Bill To block.
 */
export function validateInvoice(invoice, refs = {}) {
  const { vendor, client } = refs;
  const errors = [];
  if (!invoice.vendorId) errors.push('A vendor is required.');
  else if ('vendor' in refs && !vendor) errors.push(`No vendor with id "${invoice.vendorId}".`);
  if (!invoice.clientId) errors.push('A client is required.');
  else if ('client' in refs && !client) errors.push(`No client with id "${invoice.clientId}".`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.issueDate)) errors.push('Invoice date must be YYYY-MM-DD.');
  if (!invoice.lineItems.length) errors.push('An invoice needs at least one line item.');
  invoice.lineItems.forEach((li, i) => {
    if (!li.description.trim()) errors.push(`Line ${i + 1} needs a description.`);
    if (li.quantityMilli == null) errors.push(`Line ${i + 1} needs a quantity.`);
    if (li.rateCents == null) errors.push(`Line ${i + 1} needs a rate.`);
    if (!withinBounds(lineAmountCents(li.quantityMilli, li.rateCents))) {
      errors.push(`Line ${i + 1} comes to more than ${formatUSD(MAX_CENTS)}. Check the quantity and rate.`);
    }
  });
  // Checked separately: every line can be under the ceiling while the total is
  // over it, and the total is the figure someone is asked to pay.
  if (!withinBounds(invoiceTotals(invoice).totalCents)) {
    errors.push(`The invoice total is more than ${formatUSD(MAX_CENTS)}.`);
  }
  return errors;
}

/**
 * Derive an id that is not already taken.
 *
 * Ids are foreign keys on invoice records, so a collision would silently give
 * two clients the same billing history. Ids are assigned once at creation and
 * never change afterward, because changing one orphans every invoice that
 * points at it.
 */
export function uniqueId(base, takenIds) {
  const root = slugify(base) || 'record';
  if (!takenIds.includes(root)) return root;
  for (let n = 2; ; n += 1) {
    const candidate = `${root}-${n}`;
    if (!takenIds.includes(candidate)) return candidate;
  }
}

/**
 * Id collisions are not checked here. An id is never submitted: it is derived
 * once at creation by `uniqueId` against the ids already taken, and an update
 * takes it as an argument rather than from the form. There is no path by which
 * a caller can propose one, so there is nothing here to reject.
 */
/**
 * A name the invoice PDF has no way to draw.
 *
 * The code point rides along because the character is often the problem: a
 * zero-width space renders as nothing at all, and "cannot use  " helps nobody.
 *
 * Only the fields that identify someone are checked. A name is what says which
 * legal entity this is, and one printed a character short is a
 * misidentification rather than a cosmetic loss -- whereas a description
 * pasted out of a word processor has a paragraph of context around whatever
 * sanitize folds, and rejecting the paste would be worse than folding it.
 *
 * This does not make sanitize unnecessary. billTo and remitFrom are snapshots
 * taken before this rule existed, and every record already on disk can still
 * hold one of these, so sanitize remains what keeps the PDF route from
 * becoming a 500.
 */
function winansiError(label, value) {
  const bad = unrepresentable(value);
  if (!bad.length) return null;
  const named = bad
    .map((c) => `${c} (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`)
    .join(', ');
  return `${label} cannot use ${named} — the invoice PDF would print the `
    + `${label.toLowerCase()} without ${bad.length > 1 ? 'those characters' : 'that character'}.`;
}

export function validateClient(input) {
  const errors = [];
  if (!String(input.name || '').trim()) errors.push('Legal name is required — it renders on the invoice.');
  for (const [label, value] of [
    ['Legal name', input.name],
    ['Display name', input.displayName],
    ['Primary contact', input.contactName],
  ]) {
    const error = winansiError(label, value);
    if (error) errors.push(error);
  }
  if (!CLIENT_TYPES.includes(input.type)) errors.push('Type must be Business or Individual.');
  return errors;
}

/**
 * The one vendor rule with two enforcement points. `validateVendor` says it
 * to a person filling in the form; the store says it again on the write, so a
 * caller that skipped validation cannot produce two vendors issuing the same
 * invoice id. Same words from both, so a test written against either holds.
 */
export const prefixTakenError = (prefix) =>
  `Another vendor already issues ${prefix} numbers, and two vendors sharing a prefix would issue the same invoice id.`;

export function validateVendor(input, { existing = null, takenPrefixes = [] } = {}) {
  const errors = [];
  if (!String(input.name || '').trim()) errors.push('Company name is required.');
  const nameError = winansiError('Company name', input.name);
  if (nameError) errors.push(nameError);

  // The prefix is the leading half of every invoice id, and an invoice id is a
  // filename and a URL segment. Two constraints follow. It must be filename
  // safe, or a prefix of `../` writes records outside the data directory and a
  // prefix containing `/` produces a record whose URL cannot match
  // /invoices/:id -- unreachable and undeletable from the UI. And it must be
  // present and unique, because two vendors sharing a prefix issue the same
  // invoice id and the second one written replaces the first on disk.
  const prefix = String(input.numberPrefix ?? '').trim();
  if (!prefix) {
    errors.push('Invoice prefix is required \u2014 it is what keeps two vendors\u2019 numbers apart.');
  } else if (!NUMBER_PREFIX.test(prefix)) {
    errors.push('Invoice prefix may use letters, digits, dot, underscore and hyphen only, up to 16 characters.');
  } else if (takenPrefixes.includes(prefix)) {
    errors.push(prefixTakenError(prefix));
  }

  const pad = Number(input.numberPad);
  if (!Number.isInteger(pad) || pad < 1 || pad > 10) errors.push('Number padding must be between 1 and 10.');
  const next = Number(input.nextNumber);
  if (!Number.isInteger(next) || next < 1) errors.push('Next invoice number must be a positive whole number.');
  // Moving the counter backward would reissue a number that is already on a
  // client's books. Gaps are fine; duplicates are an accounting problem.
  if (existing && next < existing.nextNumber) {
    errors.push(`Next invoice number cannot move backward from ${existing.nextNumber} — that would reuse a number already issued.`);
  }
  return errors;
}

/**
 * Apply the snapshot freeze policy.
 *
 * A draft still tracks the registry, so correcting a client's address before
 * sending does what you expect. Once an invoice leaves draft it has been seen
 * by someone else, and its snapshot stops moving: the document must keep saying
 * what it said when it was sent.
 *
 * `force` is for the moment of creation, when there is no prior snapshot to
 * preserve regardless of the status the record was created with.
 *
 * `storedStatus` is the status the record had *before* this save. The freeze
 * has to be decided on that, not on the status being submitted: the save that
 * sends an invoice arrives with status already `sent`, so reading the incoming
 * value freezes one save too early and preserves the snapshot from the last
 * draft rather than the details the invoice is being sent with. Callers that
 * have not read the stored record fall back to the incoming status.
 */
export function withSnapshots(invoice, { vendor, client, force = false, storedStatus = null } = {}) {
  const status = storedStatus ?? invoice.status;
  const frozen = status !== 'draft' && invoice.billTo && invoice.remitFrom;
  if (frozen && !force) return invoice;
  return {
    ...invoice,
    remitFrom: vendor ? snapshotVendor(vendor) : invoice.remitFrom,
    billTo: client ? snapshotClient(client) : invoice.billTo,
  };
}

/**
 * Whether an invoice is past due.
 *
 * Only a sent invoice can be overdue. A draft has not been sent to anyone, and
 * a paid or void one is settled — flagging either would be noise on the one
 * screen where the flag needs to mean something.
 */
export const isOverdue = (invoice, asOf = today()) =>
  invoice.status === 'sent' && invoice.dueDate < asOf;

/** Days past due, for the list. Negative before the due date. */
export function daysOverdue(invoice, asOf = today()) {
  const day = 24 * 60 * 60 * 1000;
  return Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${invoice.dueDate}T00:00:00Z`)) / day);
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * "2026-09-03" -> "September 3, 2026".
 *
 * Built from the string parts rather than a Date, because constructing a Date
 * from an ISO date string parses it as UTC and formatting it in a western
 * timezone lands on the previous day. An invoice date is a calendar fact.
 */
export function formatLongDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
  if (!match) return String(isoDate || '');
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
}
