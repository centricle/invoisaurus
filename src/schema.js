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
