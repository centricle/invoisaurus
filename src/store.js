/**
 * JSON-record persistence: the rules, not the bytes.
 *
 * Layout under DATA_DIR:
 *   vendors.json          array of vendor records
 *   clients.json          array of client records
 *   invoices/ACM-0001.json  one file per invoice
 *
 * Reads and writes go through `storage.js`, which owns the atomic temp-file
 * rename and, in the hosted demo, swaps the filesystem out for a per-visitor
 * store. Nothing in this file knows or cares which is in use: the paths are
 * the same strings either way, so every guarantee below holds in both.
 */
import path from 'node:path';
import { DATA_DIR } from './config.js';
import {
  readJson, writeJson, exists, listDir, remove, ensureDir,
} from './storage.js';
import {
  formatInvoiceNumber, makeVendor, makeClient, makeInvoice, uniqueId, INVOICE_ID,
} from './schema.js';

const VENDORS = path.join(DATA_DIR, 'vendors.json');
const CLIENTS = path.join(DATA_DIR, 'clients.json');
const INVOICE_DIR = path.join(DATA_DIR, 'invoices');

export function ensureDataDir() {
  ensureDir(INVOICE_DIR);
  for (const file of [VENDORS, CLIENTS]) {
    if (!exists(file)) writeJson(file, []);
  }
}

// --- Vendors ---------------------------------------------------------------

export const listVendors = () => readJson(VENDORS, []);
export const getVendor = (id) => listVendors().find((v) => v.id === id) || null;

/** Create a vendor and assign its id. See updateVendor for why this is split. */
export function createVendor(input) {
  const vendor = makeVendor({ ...input, id: uniqueId(input.name, takenVendorIds()) });
  const vendors = listVendors();
  vendors.push(vendor);
  writeJson(VENDORS, vendors);
  return vendor;
}

/**
 * Update a vendor in place. The id comes from the caller, never the form.
 *
 * `nextNumber` is the one field an edit can corrupt: moving it backward
 * reissues a number already on a client's books. Callers should validate with
 * `validateVendor(input, { existing })` for a readable error; the floor is
 * enforced here regardless, so a missed check cannot produce a duplicate.
 */
export function updateVendor(id, input) {
  const vendors = listVendors();
  const i = vendors.findIndex((v) => v.id === id);
  if (i === -1) throw new Error(`No vendor with id "${id}"`);
  const vendor = makeVendor({ ...input, id });
  vendor.nextNumber = Math.max(vendor.nextNumber, vendors[i].nextNumber);
  vendor.createdAt = vendors[i].createdAt;
  vendors[i] = { ...vendors[i], ...vendor };
  writeJson(VENDORS, vendors);
  return vendors[i];
}

/**
 * Allocate the next invoice number for a vendor and persist the increment
 * before returning. Read-modify-write is synchronous and Node is single
 * threaded, so no two invoices in this process can claim the same number.
 *
 * Numbers are never reused, including after a delete. A gap in the series is a
 * voided invoice; a reused number is an accounting problem.
 */
export function allocateInvoiceNumber(vendorId) {
  const vendors = listVendors();
  const vendor = vendors.find((v) => v.id === vendorId);
  if (!vendor) throw new Error(`Unknown vendor: ${vendorId}`);
  const number = vendor.nextNumber;
  vendor.nextNumber = number + 1;
  writeJson(VENDORS, vendors);
  return { number, id: formatInvoiceNumber(vendor, number) };
}

// --- Clients ---------------------------------------------------------------

export const listClients = () => readJson(CLIENTS, []);
export const getClient = (id) => listClients().find((c) => c.id === id) || null;

/**
 * Create a client and assign its id.
 *
 * The id is derived once, here, and never again. Everything downstream — every
 * invoice's `clientId`, every bookmarked /clients/<id>/edit URL — depends on it
 * outliving any number of renames.
 */
export function createClient(input) {
  const client = makeClient({ ...input, id: uniqueId(input.displayName || input.name, takenClientIds()) });
  const clients = listClients();
  clients.push(client);
  writeJson(CLIENTS, clients);
  return client;
}

/**
 * Update a client in place. The id is taken from the caller's `id` argument and
 * never from the submitted fields.
 *
 * Create and update are separate functions rather than one save() because a
 * single save() cannot tell an update from a create, and a caller who forgot to
 * carry the id forward got a silently duplicated record with a fresh slug —
 * leaving every existing invoice pointing at the original, now-orphaned copy.
 * Update cannot invent an id, so that failure is no longer expressible.
 */
export function updateClient(id, input) {
  const clients = listClients();
  const i = clients.findIndex((c) => c.id === id);
  if (i === -1) throw new Error(`No client with id "${id}"`);
  clients[i] = { ...clients[i], ...makeClient({ ...input, id }), createdAt: clients[i].createdAt };
  writeJson(CLIENTS, clients);
  return clients[i];
}

/** Ids in use, for collision-free id assignment. */
export const takenClientIds = () => listClients().map((c) => c.id);
export const takenVendorIds = () => listVendors().map((v) => v.id);

/** Invoices referencing a client, so the edit form can say how many are affected
 *  and that the snapshot leaves them alone. */
export const invoiceCountForClient = (clientId) =>
  listInvoices().filter((inv) => inv.clientId === clientId).length;

// --- Invoices --------------------------------------------------------------

/**
 * Resolve an invoice id to its file, refusing anything that would land outside
 * the invoice directory.
 *
 * An invoice id is a filename, and it arrives from two places a caller does not
 * control: a URL parameter, which Express percent-decodes (so `%2e%2e%2f`
 * becomes `../`), and a vendor's number prefix, which a human types. Both are
 * validated before they get here. This is the backstop that stays correct when
 * one of those checks is refactored away.
 */
function invoicePath(id) {
  const file = path.resolve(INVOICE_DIR, `${id}.json`);
  if (!INVOICE_ID.test(String(id)) || path.dirname(file) !== path.resolve(INVOICE_DIR)) {
    throw new Error(`Unsafe invoice id: ${JSON.stringify(String(id))}`);
  }
  return file;
}

/**
 * The fields every reader of an invoice dereferences without guarding first.
 *
 * Parsing is not the same question as shape. `{}`, `[]`, `"oops"` and `null`
 * are all valid JSON, and each one reached the list as though it were a record:
 * `invoiceTotals` called `.map` on a missing `lineItems` and turned the whole
 * page into a 500, which is the outcome scanInvoices exists to prevent. The
 * data directory is documented as hand-editable, so a half-finished edit or a
 * stray file is an ordinary event rather than an exotic one.
 *
 * Only the three fields that crash on absence are checked. `status` falls back
 * through statusBadgeClass, `dueDate` compares false when missing, and the
 * snapshot blocks are already read defensively -- guarding those here would be
 * validation, which is a different job and belongs in schema.js.
 */
const isInvoiceShaped = (value) => Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
  && typeof value.id === 'string'
  && typeof value.issueDate === 'string'
  && Array.isArray(value.lineItems)
  && value.lineItems.every((li) => Boolean(li) && typeof li === 'object');

/**
 * Read every invoice, separating out the ones that are not usable records.
 *
 * A registry file that will not parse is a whole-app problem, and readJson
 * throws for it. One invoice among hundreds is not the same event. Refusing to
 * render the list because a single file is damaged hides every other invoice
 * too, and does nothing to help find the damaged one.
 *
 * Dropping it silently would be worse than the throw, though: an invoice that
 * quietly stops appearing is an invoice nobody chases for payment. So a bad
 * file is set aside and handed back to the caller, which puts it on the page
 * where someone will actually see it.
 */
export function scanInvoices() {
  if (!exists(INVOICE_DIR)) return { invoices: [], unreadable: [] };

  const invoices = [];
  const unreadable = [];
  for (const file of listDir(INVOICE_DIR).filter((f) => f.endsWith('.json'))) {
    try {
      const invoice = readJson(path.join(INVOICE_DIR, file), null);
      if (isInvoiceShaped(invoice)) invoices.push(invoice);
      // A file that vanished between the readdir and the read reads as null and
      // is simply gone; anything else that parsed is a file in the invoice
      // directory that is not an invoice, and someone has to be told about it.
      else if (invoice !== null || exists(path.join(INVOICE_DIR, file))) {
        unreadable.push({ file, message: 'Not an invoice record.' });
      }
    } catch (err) {
      unreadable.push({ file, message: err.message });
    }
  }

  invoices.sort((a, b) => (b.issueDate).localeCompare(a.issueDate) || (b.number - a.number));
  unreadable.sort((a, b) => a.file.localeCompare(b.file));
  return { invoices, unreadable };
}

/** The readable invoices, newest first. Callers that cannot show a damaged file
 *  to anyone want this; the invoice list itself wants `scanInvoices`. */
export const listInvoices = () => scanInvoices().invoices;

/**
 * One invoice, or null when there is no usable record at that id.
 *
 * A file that parses but is not shaped like an invoice is not a record this
 * app wrote, so it gets the same answer a missing file gets rather than
 * crashing the editor and the PDF route. The invoice list is where a damaged
 * file is named and explained; this is only the path that stops a 500.
 */
export function getInvoice(id) {
  const invoice = readJson(invoicePath(id), null);
  return isInvoiceShaped(invoice) ? invoice : null;
}

/**
 * Write an invoice. `create` refuses to write over a file that already exists.
 *
 * Without that guard a second vendor issuing the same id -- which is what two
 * vendors sharing a number prefix produces -- renames silently over the first
 * vendor's invoice. No error, no flash, the record is simply gone. Validation
 * makes duplicate prefixes unreachable through the UI; this makes the data loss
 * unreachable at all.
 */
export function saveInvoice(input, { create = false } = {}) {
  const invoice = makeInvoice(input);
  if (!invoice.id) throw new Error('Invoice has no id; allocate a number first.');
  const file = invoicePath(invoice.id);
  if (create && exists(file)) {
    throw new Error(`Invoice ${invoice.id} already exists; refusing to overwrite it.`);
  }
  writeJson(file, invoice);
  return invoice;
}

export function deleteInvoice(id) {
  remove(invoicePath(id));
}
