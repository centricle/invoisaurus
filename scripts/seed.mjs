/**
 * Demo data: one vendor, one client, one invoice.
 *
 * Records come from `src/fixtures/acme.js`, shared with the hosted demo. This
 * script deliberately seeds only the single draft: it writes into a real data
 * directory that someone is about to put their own invoices in, so one
 * obviously-fake client is a sample and three would be cleanup.
 *
 * Run once after install to get a populated app to look at. Everything it
 * creates is fictional and safe to delete -- see `--remove` below, and the
 * "Demo data" section of the README.
 *
 *   node scripts/seed.mjs            create the demo records (idempotent)
 *   node scripts/seed.mjs --remove   clear them again
 *
 * The order below is not arbitrary. `createVendor` and `createClient` derive
 * the record id themselves and ignore any id passed in, so the returned record
 * is the only place the real id exists. `allocateInvoiceNumber` persists the
 * counter increment before it returns and there is no rollback, so validation
 * has to pass first or a failed seed burns a number out of the series.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDataDir, listVendors, listClients, listInvoices,
  createVendor, createClient, allocateInvoiceNumber, saveInvoice,
} from '../src/store.js';
import { makeInvoice, withSnapshots, validateInvoice, invoiceTotals, today } from '../src/schema.js';
import { parseQuantity, parseCents, formatUSD } from '../src/money.js';
import { DATA_DIR } from '../src/config.js';
// The cast lives in one place so this and the hosted demo cannot drift.
import { VENDOR, CLIENT, LINE_ITEMS, NOTES, VENDOR_ID, CLIENT_ID } from '../src/fixtures/acme.js';

function seed() {
  ensureDataDir();

  const existingVendor = listVendors().find((v) => v.id === VENDOR_ID);
  const existingClient = listClients().find((c) => c.id === CLIENT_ID);
  const hasInvoice = listInvoices().some((i) => i.vendorId === VENDOR_ID);

  if (existingVendor && existingClient && hasInvoice) {
    console.log('Demo data already present, nothing to do.');
    console.log(`Data dir: ${DATA_DIR}`);
    return;
  }

  // createVendor/createClient append unconditionally -- there is no upsert, so
  // seeding twice without these guards yields acme-corporation-2.
  const vendor = existingVendor || createVendor(VENDOR);
  const client = existingClient || createClient(CLIENT);

  const draft = makeInvoice({
    vendorId: vendor.id,
    clientId: client.id,
    issueDate: today(),
    terms: 'net30',
    status: 'draft',
    notes: NOTES,
    lineItems: LINE_ITEMS.map((li) => ({
      description: li.description,
      quantityMilli: parseQuantity(li.quantity),
      rateCents: parseCents(li.rate),
    })),
  });

  const errors = validateInvoice(draft, { vendor, client });
  if (errors.length) {
    console.error('Demo invoice failed validation, so no number was allocated:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const { number, id } = allocateInvoiceNumber(vendor.id);
  // `create: true` for the same reason the create route uses it: the number was
  // just allocated, so nothing should exist at that id, and if something does
  // the right answer is to stop rather than to rename over an invoice.
  const invoice = saveInvoice(withSnapshots(
    { ...draft, id, number },
    { vendor, client, force: true },
  ), { create: true });

  console.log(`Vendor   ${vendor.name} (${vendor.id})`);
  console.log(`Client   ${client.name} (${client.id})`);
  console.log(`Invoice  ${invoice.id}, ${invoice.status}, ${formatUSD(invoiceTotals(invoice).totalCents)}`);
  console.log(`\nData dir: ${DATA_DIR}`);
  console.log('Remove it all again with: npm run seed -- --remove');
}

function remove() {
  if (!fs.existsSync(DATA_DIR)) {
    console.log('Nothing to remove; no data directory at ' + DATA_DIR);
    return;
  }

  const vendors = listVendors();
  const clients = listClients();
  const invoices = listInvoices();

  // Refuse rather than guess. This deletes data files, so it only runs when
  // the directory holds the demo records and nothing else.
  const onlyDemo = vendors.every((v) => v.id === VENDOR_ID)
    && clients.every((c) => c.id === CLIENT_ID)
    && invoices.every((i) => i.vendorId === VENDOR_ID);

  if (!onlyDemo) {
    console.error('Refusing to remove: this data directory holds records that are not demo data.');
    console.error(`  ${DATA_DIR}`);
    console.error('Delete the demo vendor, client and invoice by hand, or point');
    console.error('INVOISAURUS_DATA_DIR somewhere else.');
    process.exit(1);
  }

  for (const invoice of invoices) {
    fs.rmSync(path.join(DATA_DIR, 'invoices', `${invoice.id}.json`), { force: true });
  }
  fs.rmSync(path.join(DATA_DIR, 'vendors.json'), { force: true });
  fs.rmSync(path.join(DATA_DIR, 'clients.json'), { force: true });
  ensureDataDir(); // leaves empty registries, and any git repo here, intact

  console.log(`Removed ${vendors.length} vendor(s), ${clients.length} client(s), ${invoices.length} invoice(s).`);
  console.log(`Data dir: ${DATA_DIR}`);
}

if (process.argv.includes('--remove')) remove();
else seed();
