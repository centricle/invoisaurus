/**
 * JSON-record persistence: the rules, not the bytes.
 *
 * Layout under the data directory:
 *   vendors.json            array of vendor records
 *   clients.json            array of client records
 *   invoices/ACM-0001.json  one file per invoice
 *
 * `createJsonStore` returns one store over one directory and one backend.
 * Reads and writes go through the backend, which owns the atomic temp-file
 * rename on disk and, in the hosted demo, is a per-visitor map instead.
 * Nothing in this file knows or cares which is in use: the paths are the same
 * strings either way, so every guarantee below holds in both.
 *
 * Every method is async, and deliberately so even though both backends here
 * are synchronous underneath. The methods are the store contract -- what a
 * database-backed store has to implement to be a drop-in -- and a contract
 * that is sometimes a promise and sometimes a value is one where a forgotten
 * `await` works against the JSON store and fails against the next one.
 * `test/store-contract.js` runs the same script against every implementation.
 */
import path from 'node:path';
import { fsBackend } from './storage.js';
import {
  formatInvoiceNumber, makeVendor, makeClient, makeInvoice, uniqueId, INVOICE_ID,
  prefixTakenError,
} from './schema.js';

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
 * A store over `dataDir`, reading and writing through `backend`.
 *
 * The directory is a constructor argument rather than a module constant so two
 * stores can exist in one process -- every demo visitor has one -- and so a
 * test can point a store at a scratch directory without having to set an
 * environment variable before the module is imported.
 */
export function createJsonStore({ backend = fsBackend, dataDir } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new TypeError('createJsonStore needs a dataDir: the directory the records live in.');
  }
  const ROOT = path.resolve(dataDir);
  const VENDORS = path.join(ROOT, 'vendors.json');
  const CLIENTS = path.join(ROOT, 'clients.json');
  const INVOICE_DIR = path.join(ROOT, 'invoices');
  const { readJson, writeJson, exists, listDir, remove, ensureDir } = backend;

  // --- Vendors -------------------------------------------------------------

  const vendors = () => readJson(VENDORS, []);
  const vendorById = (id) => vendors().find((v) => v.id === id) || null;

  /**
   * Refuse a prefix another vendor already issues. `validateVendor` says the
   * same thing to the form; this is the guarantee for callers that never saw a
   * form. Two vendors sharing a prefix produce the same invoice id, and the
   * second one written would replace the first.
   */
  const assertPrefixFree = (prefix, exceptId = null) => {
    if (vendors().some((v) => v.id !== exceptId && v.numberPrefix === prefix)) {
      throw new Error(prefixTakenError(prefix));
    }
  };

  /**
   * Allocate the next invoice number for a vendor and persist the increment
   * before returning. Read-modify-write is synchronous and Node is single
   * threaded, so no two invoices in this process can claim the same number.
   * Two processes sharing a directory are not protected; see BACKLOG.
   *
   * Numbers are never reused, including after a delete. A gap in the series is a
   * voided invoice; a reused number is an accounting problem.
   */
  const allocate = (vendorId) => {
    const all = vendors();
    const vendor = all.find((v) => v.id === vendorId);
    if (!vendor) throw new Error(`Unknown vendor: ${vendorId}`);
    const number = vendor.nextNumber;
    vendor.nextNumber = number + 1;
    writeJson(VENDORS, all);
    return { number, id: formatInvoiceNumber(vendor, number) };
  };

  // --- Clients -------------------------------------------------------------

  const clients = () => readJson(CLIENTS, []);
  const clientById = (id) => clients().find((c) => c.id === id) || null;

  // --- Invoices ------------------------------------------------------------

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
  const invoicePath = (id) => {
    const file = path.resolve(INVOICE_DIR, `${id}.json`);
    if (!INVOICE_ID.test(String(id)) || path.dirname(file) !== path.resolve(INVOICE_DIR)) {
      throw new Error(`Unsafe invoice id: ${JSON.stringify(String(id))}`);
    }
    return file;
  };

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
  const scan = () => {
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
  };

  const readable = () => scan().invoices;

  /**
   * One invoice, or null when there is no usable record at that id.
   *
   * A file that parses but is not shaped like an invoice is not a record this
   * app wrote, so it gets the same answer a missing file gets rather than
   * crashing the editor and the PDF route. The invoice list is where a damaged
   * file is named and explained; this is only the path that stops a 500.
   */
  const invoiceById = (id) => {
    const invoice = readJson(invoicePath(id), null);
    return isInvoiceShaped(invoice) ? invoice : null;
  };

  /**
   * Write an invoice. `create` refuses to write over a file that already exists.
   *
   * Without that guard a second vendor issuing the same id -- which is what two
   * vendors sharing a number prefix produces -- renames silently over the first
   * vendor's invoice. No error, no flash, the record is simply gone. Validation
   * makes duplicate prefixes unreachable through the UI; this makes the data loss
   * unreachable at all.
   */
  const save = (input, { create = false } = {}) => {
    const invoice = makeInvoice(input);
    if (!invoice.id) throw new Error('Invoice has no id; allocate a number first.');
    const file = invoicePath(invoice.id);
    if (create && exists(file)) {
      throw new Error(`Invoice ${invoice.id} already exists; refusing to overwrite it.`);
    }
    writeJson(file, invoice);
    return invoice;
  };

  return {
    async ensureDataDir() {
      ensureDir(INVOICE_DIR);
      for (const file of [VENDORS, CLIENTS]) {
        if (!exists(file)) writeJson(file, []);
      }
    },

    // --- Vendors -----------------------------------------------------------

    async listVendors() { return vendors(); },
    async getVendor(id) { return vendorById(id); },

    /** Create a vendor and assign its id. See updateVendor for why this is split. */
    async createVendor(input) {
      const vendor = makeVendor({ ...input, id: uniqueId(input.name, vendors().map((v) => v.id)) });
      assertPrefixFree(vendor.numberPrefix);
      const all = vendors();
      all.push(vendor);
      writeJson(VENDORS, all);
      return vendor;
    },

    /**
     * Update a vendor in place. The id comes from the caller, never the form.
     *
     * `nextNumber` is the one field an edit can corrupt: moving it backward
     * reissues a number already on a client's books. Callers should validate with
     * `validateVendor(input, { existing })` for a readable error; the floor is
     * enforced here regardless, so a missed check cannot produce a duplicate.
     */
    async updateVendor(id, input) {
      const all = vendors();
      const i = all.findIndex((v) => v.id === id);
      if (i === -1) throw new Error(`No vendor with id "${id}"`);
      const vendor = makeVendor({ ...input, id });
      assertPrefixFree(vendor.numberPrefix, id);
      vendor.nextNumber = Math.max(vendor.nextNumber, all[i].nextNumber);
      vendor.createdAt = all[i].createdAt;
      all[i] = { ...all[i], ...vendor };
      writeJson(VENDORS, all);
      return all[i];
    },

    async allocateInvoiceNumber(vendorId) { return allocate(vendorId); },

    // --- Clients -----------------------------------------------------------

    async listClients() { return clients(); },
    async getClient(id) { return clientById(id); },

    /**
     * Create a client and assign its id.
     *
     * The id is derived once, here, and never again. Everything downstream -- every
     * invoice's `clientId`, every bookmarked /clients/<id>/edit URL -- depends on it
     * outliving any number of renames.
     */
    async createClient(input) {
      const taken = clients().map((c) => c.id);
      const client = makeClient({ ...input, id: uniqueId(input.displayName || input.name, taken) });
      const all = clients();
      all.push(client);
      writeJson(CLIENTS, all);
      return client;
    },

    /**
     * Update a client in place. The id is taken from the caller's `id` argument and
     * never from the submitted fields.
     *
     * Create and update are separate functions rather than one save() because a
     * single save() cannot tell an update from a create, and a caller who forgot to
     * carry the id forward got a silently duplicated record with a fresh slug --
     * leaving every existing invoice pointing at the original, now-orphaned copy.
     * Update cannot invent an id, so that failure is no longer expressible.
     */
    async updateClient(id, input) {
      const all = clients();
      const i = all.findIndex((c) => c.id === id);
      if (i === -1) throw new Error(`No client with id "${id}"`);
      all[i] = { ...all[i], ...makeClient({ ...input, id }), createdAt: all[i].createdAt };
      writeJson(CLIENTS, all);
      return all[i];
    },

    /** Ids in use, for collision-free id assignment. */
    async takenClientIds() { return clients().map((c) => c.id); },
    async takenVendorIds() { return vendors().map((v) => v.id); },

    /** Invoices referencing a client, so the edit form can say how many are affected
     *  and that the snapshot leaves them alone. */
    async invoiceCountForClient(clientId) {
      return readable().filter((inv) => inv.clientId === clientId).length;
    },

    // --- Invoices ----------------------------------------------------------

    async scanInvoices() { return scan(); },

    /** The readable invoices, newest first. Callers that cannot show a damaged file
     *  to anyone want this; the invoice list itself wants `scanInvoices`. */
    async listInvoices() { return readable(); },

    async getInvoice(id) { return invoiceById(id); },

    async saveInvoice(input, options) { return save(input, options); },

    /**
     * Allocate a number and write the invoice under it, as one operation.
     *
     * The two steps used to be separate calls at every creation site, and the
     * gap between them is where a failed write burns a number: the counter has
     * moved and nothing is on disk under it. On the filesystem that gap is
     * still there and still narrow. Offering it as one call is what lets a
     * database-backed store close it entirely, with the increment and the
     * insert in one statement, without the callers changing again.
     */
    async createInvoice(input) {
      const { number, id } = allocate(input.vendorId);
      return save({ ...input, id, number }, { create: true });
    },

    async deleteInvoice(id) {
      remove(invoicePath(id));
    },
  };
}
