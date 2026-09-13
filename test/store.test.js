import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// Must precede any src import: it binds INVOISAURUS_DATA_DIR before config.js
// resolves it. See test/tmpdir.js.
import { DATA_DIR } from './tmpdir.js';
import { createJsonStore } from '../src/store.js';

const store = createJsonStore({ dataDir: DATA_DIR });

beforeEach(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  await store.ensureDataDir();
});

const coyote = {
  name: 'Carnivorous Vulgaris, LLC', displayName: 'Coyote', type: 'business',
  address: { street: '1 Old Rd', city: 'Tucumcari', state: 'NM', zip: '88401' },
};

test('a client id is derived once and survives a total rename', async () => {
  const created = await store.createClient(coyote);
  assert.equal(created.id, 'coyote');

  await store.updateClient(created.id, {
    ...coyote, name: 'Acceleratti Incredibilus, LLC', displayName: 'Road Runner',
  });

  const after = await store.listClients();
  assert.equal(after.length, 1, 'rename must not create a second record');
  assert.equal(after[0].id, 'coyote', 'the id is what invoices and bookmarks point at');
  assert.equal(after[0].name, 'Acceleratti Incredibilus, LLC');
  assert.ok(await store.getClient('coyote'), 'a bookmarked /clients/coyote URL still resolves');
});

test('an update cannot change a client id, even if one is passed', async () => {
  // The old save() derived the id from the submitted name when none was carried
  // forward, which appended a second record with a fresh slug and orphaned every
  // invoice pointing at the original. Update takes the id as its own argument,
  // so that failure is not expressible.
  const created = await store.createClient(coyote);
  await store.updateClient(created.id, { ...coyote, id: 'hijacked', displayName: 'Hijacked' });

  const after = await store.listClients();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, 'coyote');
  assert.equal(await store.getClient('hijacked'), null);
});

test('updating a client that does not exist fails loudly', async () => {
  await assert.rejects(() => store.updateClient('ghost', coyote), /No client with id/);
});

test('clients with the same display name get distinct ids', async () => {
  const first = await store.createClient(coyote);
  const second = await store.createClient({ ...coyote, name: 'Coyote Corp' });
  assert.notEqual(first.id, second.id);
  assert.equal((await store.listClients()).length, 2);
});

test('createdAt survives an update', async () => {
  const created = await store.createClient(coyote);
  const updated = await store.updateClient(created.id, { ...coyote, displayName: 'Renamed' });
  assert.equal(updated.createdAt, created.createdAt);
});

test('a vendor id is stable across a rename, and the counter cannot go backward', async () => {
  const vendor = await store.createVendor({ name: 'ACME Corporation', numberPrefix: 'ACM-', nextNumber: 7 });
  assert.equal(vendor.id, 'acme-corporation');

  await store.allocateInvoiceNumber(vendor.id); // counter -> 8
  const updated = await store.updateVendor(vendor.id, {
    name: 'ACME Holdings LLC', numberPrefix: 'ACM-', numberPad: 4, nextNumber: 2,
  });

  assert.equal((await store.listVendors()).length, 1);
  assert.equal(updated.id, 'acme-corporation');
  assert.equal(updated.name, 'ACME Holdings LLC');
  assert.equal(updated.nextNumber, 8, 'a backward counter must be clamped, not accepted');
});

test('invoice numbers are never reused, including after a delete', async () => {
  const vendor = await store.createVendor({ name: 'ACME Corporation', numberPrefix: 'ACM-', nextNumber: 1 });
  const first = await store.allocateInvoiceNumber(vendor.id);
  await store.saveInvoice({ id: first.id, number: first.number, vendorId: vendor.id, clientId: 'x' });
  await store.deleteInvoice(first.id);

  const second = await store.allocateInvoiceNumber(vendor.id);
  assert.notEqual(second.id, first.id);
  assert.equal(second.number, first.number + 1);
});

test('an unsafe invoice id never reaches the filesystem', async () => {
  // The backstop behind the router's check. An id is a filename, and it arrives
  // from a URL parameter that Express percent-decodes and from a vendor prefix
  // that a human types.
  const outside = path.join(DATA_DIR, '..', 'invoisaurus-escaped.json');
  for (const id of ['../invoisaurus-escaped', 'a/b', 'x%2fy', '  ', '']) {
    await assert.rejects(() => store.getInvoice(id), /Unsafe invoice id/, JSON.stringify(id));
  }
  // An empty id is caught earlier, by the rule that a number must be allocated
  // before an invoice can be written at all.
  for (const id of ['../invoisaurus-escaped', 'a/b', 'x%2fy', '  ']) {
    await assert.rejects(
      () => store.saveInvoice({ id, vendorId: 'v', clientId: 'c', lineItems: [] }),
      /Unsafe invoice id/,
      JSON.stringify(id),
    );
  }
  assert.equal(fs.existsSync(outside), false, 'nothing was written outside the data directory');
});

test('creating an invoice refuses to write over an existing one', async () => {
  const vendor = await store.createVendor({ name: 'ACME Corporation', numberPrefix: 'ACM-', nextNumber: 1 });
  const { number, id } = await store.allocateInvoiceNumber(vendor.id);
  const invoice = {
    id, number, vendorId: vendor.id, clientId: 'coyote', issueDate: '2026-09-02',
    lineItems: [{ description: 'Discovery', quantityMilli: 1000, rateCents: 15000 }],
  };
  await store.saveInvoice(invoice, { create: true });

  // A collision means two vendors are issuing the same id. Renaming over the
  // first invoice loses it silently, which is the one outcome worth crashing to
  // avoid; an update of the same record is still allowed.
  await assert.rejects(() => store.saveInvoice({ ...invoice, notes: 'other' }, { create: true }), /already exists/);
  assert.equal((await store.getInvoice(id)).notes, '');
  await store.saveInvoice({ ...invoice, notes: 'edited' });
  assert.equal((await store.getInvoice(id)).notes, 'edited');
});

test('a malformed data file is reported, not silently replaced', async () => {
  // Returning [] for unreadable JSON would let the next save overwrite records
  // that are still on disk. Losing invoices is worse than a loud failure.
  fs.writeFileSync(path.join(DATA_DIR, 'clients.json'), '{"truncated": ');
  await assert.rejects(() => store.listClients(), /Corrupt data file/);
});


test('a damaged invoice file is set aside, not thrown and not swallowed', async () => {
  const vendor = await store.createVendor({
    name: 'ACME Corporation', numberPrefix: 'ACM-', numberPad: 4, nextNumber: 1,
  });
  const client = await store.createClient(coyote);
  const { number, id } = await store.allocateInvoiceNumber(vendor.id);
  await store.saveInvoice({
    id, number, vendorId: vendor.id, clientId: client.id, issueDate: '2026-09-02',
    lineItems: [{ description: 'Discovery', quantityMilli: 1000, rateCents: 15000 }],
  }, { create: true });

  fs.writeFileSync(path.join(DATA_DIR, 'invoices', 'ACM-0002.json'), '{"id": "ACM-000');

  const { invoices, unreadable } = await store.scanInvoices();
  assert.equal(invoices.length, 1, 'the readable invoice is still returned');
  assert.equal(invoices[0].id, 'ACM-0001');
  assert.equal(unreadable.length, 1, 'and the damaged one is reported rather than dropped');
  assert.equal(unreadable[0].file, 'ACM-0002.json');
  assert.match(unreadable[0].message, /Corrupt data file/);

  assert.equal((await store.listInvoices()).length, 1, 'listInvoices is the readable ones');
  assert.equal(await store.invoiceCountForClient(client.id), 1);
});

test('a file that parses but is not an invoice is set aside too', async () => {
  // Parsing and shape are different questions. Each of these is valid JSON, and
  // each one used to reach the list as though it were a record: invoiceTotals
  // called .map on a missing lineItems and 500'd the whole page, which is the
  // outcome scanInvoices exists to prevent.
  const vendor = await store.createVendor({ name: 'ACME Corporation', numberPrefix: 'ACM-', nextNumber: 1 });
  const { number, id } = await store.allocateInvoiceNumber(vendor.id);
  await store.saveInvoice({
    id, number, vendorId: vendor.id, clientId: 'coyote', issueDate: '2026-09-02',
    lineItems: [{ description: 'Discovery', quantityMilli: 1000, rateCents: 15000 }],
  }, { create: true });

  const junk = {
    'shape-object.json': '{}',
    'shape-array.json': '[]',
    'shape-string.json': '"oops"',
    'shape-null.json': 'null',
    'shape-number.json': '7',
    'shape-no-items.json': '{"id":"X-1","issueDate":"2026-09-02"}',
    'shape-null-item.json': '{"id":"X-2","issueDate":"2026-09-02","lineItems":[null]}',
  };
  for (const [file, body] of Object.entries(junk)) {
    fs.writeFileSync(path.join(DATA_DIR, 'invoices', file), body);
  }

  const { invoices, unreadable } = await store.scanInvoices();
  assert.equal(invoices.length, 1, 'the real invoice is still the only invoice');
  assert.equal(invoices[0].id, id);
  assert.deepEqual(
    unreadable.map((u) => u.file).sort(),
    Object.keys(junk).sort(),
    'every one of them is named on the page rather than dropped or thrown',
  );
});

test('an id whose file is not an invoice reads as no invoice at all', async () => {
  // The editor and the PDF route both dereference what getInvoice hands back.
  // A 404 is the honest answer for a file this app did not write; the list is
  // where the file gets named and explained.
  fs.writeFileSync(path.join(DATA_DIR, 'invoices', 'ACM-0001.json'), '{}');
  assert.equal(await store.getInvoice('ACM-0001'), null);
});

test('a damaged registry file is still a hard failure', async () => {
  // One invoice among hundreds can be set aside. Losing the client registry
  // cannot: every invoice on disk points into it, and a save over an empty
  // list would take the rest with it.
  fs.writeFileSync(path.join(DATA_DIR, 'clients.json'), 'not json');
  await assert.rejects(() => store.listClients(), /Corrupt data file/);
});
