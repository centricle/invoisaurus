/**
 * JSON-file persistence.
 *
 * Layout under DATA_DIR:
 *   vendors.json          array of vendor records
 *   clients.json          array of client records
 *   invoices/ACM-0001.json  one file per invoice
 *
 * Writes go through a temp file and a rename, which is atomic on a single
 * filesystem. A crash mid-write therefore leaves the previous version intact
 * rather than a truncated invoice.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { formatInvoiceNumber, makeVendor, makeClient, makeInvoice, INVOICE_ID } from './schema.js';

const VENDORS = path.join(DATA_DIR, 'vendors.json');
const CLIENTS = path.join(DATA_DIR, 'clients.json');
const INVOICE_DIR = path.join(DATA_DIR, 'invoices');

export function ensureDataDir() {
  fs.mkdirSync(INVOICE_DIR, { recursive: true });
  for (const file of [VENDORS, CLIENTS]) {
    if (!fs.existsSync(file)) writeJson(file, []);
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // A malformed file is a data-loss event, not a missing-value event. Fail
    // loudly rather than silently returning [] and letting a save overwrite it.
    throw new Error(`Corrupt data file ${file}: ${err.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// --- Vendors ---------------------------------------------------------------

export const listVendors = () => readJson(VENDORS, []);
export const getVendor = (id) => listVendors().find((v) => v.id === id) || null;

export function saveVendor(input) {
  const vendors = listVendors();
  const vendor = makeVendor(input);
  const i = vendors.findIndex((v) => v.id === vendor.id);
  if (i === -1) vendors.push(vendor);
  else vendors[i] = { ...vendors[i], ...vendor, nextNumber: vendors[i].nextNumber };
  writeJson(VENDORS, vendors);
  return vendor;
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

export function saveClient(input) {
  const clients = listClients();
  const client = makeClient(input);
  const i = clients.findIndex((c) => c.id === client.id);
  if (i === -1) clients.push(client);
  else clients[i] = { ...clients[i], ...client };
  writeJson(CLIENTS, clients);
  return client;
}

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

export function listInvoices() {
  if (!fs.existsSync(INVOICE_DIR)) return [];
  return fs.readdirSync(INVOICE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(INVOICE_DIR, f), null))
    .filter(Boolean)
    .sort((a, b) => (b.issueDate).localeCompare(a.issueDate) || (b.number - a.number));
}

export const getInvoice = (id) => readJson(invoicePath(id), null);

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
  if (create && fs.existsSync(file)) {
    throw new Error(`Invoice ${invoice.id} already exists; refusing to overwrite it.`);
  }
  writeJson(file, invoice);
  return invoice;
}

export function deleteInvoice(id) {
  fs.rmSync(invoicePath(id), { force: true });
}
