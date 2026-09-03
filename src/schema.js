/**
 * The single definition of the data model.
 *
 * Records are stored as JSON but shaped relationally, so that migrating to
 * Postgres later is a schema translation rather than a redesign: stable string
 * ids, no nested collections except an invoice's own line items, no derived
 * values that a query could not recompute.
 */
import { lineAmountCents, sumCents } from './money.js';

export const SCHEMA_VERSION = 1;

export const CLIENT_TYPES = ['business', 'individual'];

export const TERMS = [
  { id: 'on-receipt', label: 'Due on Receipt', days: 0 },
  { id: 'net15', label: 'Net 15', days: 15 },
  { id: 'net30', label: 'Net 30', days: 30 },
  { id: 'net45', label: 'Net 45', days: 45 },
  { id: 'net60', label: 'Net 60', days: 60 },
];

export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'void'];

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
    schemaVersion: SCHEMA_VERSION,
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
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Totals are derived, never stored. A stored total is a total that can lie. */
export function invoiceTotals(invoice) {
  const amounts = invoice.lineItems.map((li) => lineAmountCents(li.quantityMilli, li.rateCents));
  return { amounts, totalCents: sumCents(amounts) };
}

export function validateInvoice(invoice) {
  const errors = [];
  if (!invoice.vendorId) errors.push('A vendor is required.');
  if (!invoice.clientId) errors.push('A client is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.issueDate)) errors.push('Invoice date must be YYYY-MM-DD.');
  if (!invoice.lineItems.length) errors.push('An invoice needs at least one line item.');
  invoice.lineItems.forEach((li, i) => {
    if (!li.description.trim()) errors.push(`Line ${i + 1} needs a description.`);
    if (li.quantityMilli == null) errors.push(`Line ${i + 1} needs a quantity.`);
    if (li.rateCents == null) errors.push(`Line ${i + 1} needs a rate.`);
  });
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
export function validateClient(input) {
  const errors = [];
  if (!String(input.name || '').trim()) errors.push('Legal name is required — it renders on the invoice.');
  if (!CLIENT_TYPES.includes(input.type)) errors.push('Type must be Business or Individual.');
  return errors;
}

export function validateVendor(input, { existing = null, takenPrefixes = [] } = {}) {
  const errors = [];
  if (!String(input.name || '').trim()) errors.push('Company name is required.');

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
    errors.push(`Another vendor already issues ${prefix} numbers, and two vendors sharing a prefix would issue the same invoice id.`);
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
