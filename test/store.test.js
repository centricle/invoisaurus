import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The store resolves DATA_DIR at import time, so the environment must be set
// before it is loaded.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoisaurus-store-'));
process.env.INVOISAURUS_DATA_DIR = dir;
const store = await import('../src/store.js');

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  store.ensureDataDir();
});

const coyote = {
  name: 'Carnivorous Vulgaris, LLC', displayName: 'Coyote', type: 'business',
  address: { street: '1 Old Rd', city: 'Tucumcari', state: 'NM', zip: '88401' },
};

test('a client id is derived once and survives a total rename', () => {
  const created = store.createClient(coyote);
  assert.equal(created.id, 'coyote');

  store.updateClient(created.id, {
    ...coyote, name: 'Acceleratti Incredibilus, LLC', displayName: 'Road Runner',
  });

  const after = store.listClients();
  assert.equal(after.length, 1, 'rename must not create a second record');
  assert.equal(after[0].id, 'coyote', 'the id is what invoices and bookmarks point at');
  assert.equal(after[0].name, 'Acceleratti Incredibilus, LLC');
  assert.ok(store.getClient('coyote'), 'a bookmarked /clients/coyote URL still resolves');
});

test('an update cannot change a client id, even if one is passed', () => {
  // The old save() derived the id from the submitted name when none was carried
  // forward, which appended a second record with a fresh slug and orphaned every
  // invoice pointing at the original. Update takes the id as its own argument,
  // so that failure is not expressible.
  const created = store.createClient(coyote);
  store.updateClient(created.id, { ...coyote, id: 'hijacked', displayName: 'Hijacked' });

  const after = store.listClients();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, 'coyote');
  assert.equal(store.getClient('hijacked'), null);
});

test('updating a client that does not exist fails loudly', () => {
  assert.throws(() => store.updateClient('ghost', coyote), /No client with id/);
});

test('clients with the same display name get distinct ids', () => {
  const first = store.createClient(coyote);
  const second = store.createClient({ ...coyote, name: 'Coyote Corp' });
  assert.notEqual(first.id, second.id);
  assert.equal(store.listClients().length, 2);
});

test('createdAt survives an update', () => {
  const created = store.createClient(coyote);
  const updated = store.updateClient(created.id, { ...coyote, displayName: 'Renamed' });
  assert.equal(updated.createdAt, created.createdAt);
});

test('a vendor id is stable across a rename, and the counter cannot go backward', () => {
  const vendor = store.createVendor({ name: 'ACME Corporation', numberPrefix: 'ACM-', nextNumber: 7 });
  assert.equal(vendor.id, 'acme-corporation');

  store.allocateInvoiceNumber(vendor.id); // counter -> 8
  const updated = store.updateVendor(vendor.id, {
    name: 'ACME Holdings LLC', numberPrefix: 'ACM-', numberPad: 4, nextNumber: 2,
  });

  assert.equal(store.listVendors().length, 1);
  assert.equal(updated.id, 'acme-corporation');
  assert.equal(updated.name, 'ACME Holdings LLC');
  assert.equal(updated.nextNumber, 8, 'a backward counter must be clamped, not accepted');
});

test('invoice numbers are never reused, including after a delete', () => {
  const vendor = store.createVendor({ name: 'ACME Corporation', numberPrefix: 'ACM-', nextNumber: 1 });
  const first = store.allocateInvoiceNumber(vendor.id);
  store.saveInvoice({ id: first.id, number: first.number, vendorId: vendor.id, clientId: 'x' });
  store.deleteInvoice(first.id);

  const second = store.allocateInvoiceNumber(vendor.id);
  assert.notEqual(second.id, first.id);
  assert.equal(second.number, first.number + 1);
});

test('an unsafe invoice id never reaches the filesystem', () => {
  // The backstop behind the router's check. An id is a filename, and it arrives
  // from a URL parameter that Express percent-decodes and from a vendor prefix
  // that a human types.
  const outside = path.join(dir, '..', 'invoisaurus-escaped.json');
  for (const id of ['../invoisaurus-escaped', 'a/b', 'x%2fy', '  ', '']) {
    assert.throws(() => store.getInvoice(id), /Unsafe invoice id/, JSON.stringify(id));
  }
  // An empty id is caught earlier, by the rule that a number must be allocated
  // before an invoice can be written at all.
  for (const id of ['../invoisaurus-escaped', 'a/b', 'x%2fy', '  ']) {
    assert.throws(
      () => store.saveInvoice({ id, vendorId: 'v', clientId: 'c', lineItems: [] }),
      /Unsafe invoice id/,
      JSON.stringify(id),
    );
  }
  assert.equal(fs.existsSync(outside), false, 'nothing was written outside the data directory');
});

test('creating an invoice refuses to write over an existing one', () => {
  const vendor = store.createVendor({ name: 'ACME Corporation', numberPrefix: 'ACM-', nextNumber: 1 });
  const { number, id } = store.allocateInvoiceNumber(vendor.id);
  const invoice = {
    id, number, vendorId: vendor.id, clientId: 'coyote', issueDate: '2026-09-02',
    lineItems: [{ description: 'Discovery', quantityMilli: 1000, rateCents: 15000 }],
  };
  store.saveInvoice(invoice, { create: true });

  // A collision means two vendors are issuing the same id. Renaming over the
  // first invoice loses it silently, which is the one outcome worth crashing to
  // avoid; an update of the same record is still allowed.
  assert.throws(() => store.saveInvoice({ ...invoice, notes: 'other' }, { create: true }), /already exists/);
  assert.equal(store.getInvoice(id).notes, '');
  store.saveInvoice({ ...invoice, notes: 'edited' });
  assert.equal(store.getInvoice(id).notes, 'edited');
});

test('a malformed data file is reported, not silently replaced', () => {
  // Returning [] for unreadable JSON would let the next save overwrite records
  // that are still on disk. Losing invoices is worse than a loud failure.
  fs.writeFileSync(path.join(dir, 'clients.json'), '{"truncated": ');
  assert.throws(() => store.listClients(), /Corrupt data file/);
});
