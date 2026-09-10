import { test } from 'node:test';
import assert from 'node:assert/strict';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';
import fs from 'node:fs';
import { fsBackend, useBackendResolver } from '../src/storage.js';
import { createMemoryBackend } from '../src/storage-memory.js';
import { DATA_DIR } from '../src/config.js';
import * as store from '../src/store.js';

/**
 * The demo runs the real store against a different backend. That is only safe
 * if the two are indistinguishable to store.js, so rather than assert the
 * memory backend "looks right", run one script of operations against both and
 * require the same answers -- including the same thrown messages.
 *
 * Every invariant exercised below is one the audit or a past bug put there:
 * ids are immutable, an update cannot invent a record, a create cannot
 * overwrite one, and a number is never reused after a delete.
 */
function script() {
  const log = [];
  const say = (label, value) => log.push(`${label}: ${JSON.stringify(value)}`);
  const sayThrow = (label, fn) => {
    try { fn(); say(label, 'NO THROW'); } catch (err) { say(label, err.message.replace(DATA_DIR, '<DATA_DIR>')); }
  };

  store.ensureDataDir();
  say('empty vendors', store.listVendors());
  say('empty invoices', store.listInvoices());

  const vendor = store.createVendor({ name: 'ACME Corporation', numberPrefix: 'ACM-', numberPad: 4, nextNumber: 1 });
  say('vendor id', vendor.id);

  const client = store.createClient({ name: 'Wile E. Coyote', type: 'individual' });
  say('client id', client.id);

  // Renaming must not mint a second record or change the id.
  const renamed = store.updateClient(client.id, { ...client, name: 'Carnivorous Vulgaris, LLC', type: 'business' });
  say('id after rename', renamed.id);
  say('client count after rename', store.listClients().length);
  say('createdAt preserved', renamed.createdAt === client.createdAt);

  sayThrow('update unknown id', () => store.updateClient('nope', { name: 'X', type: 'business' }));

  // Allocation advances the vendor counter and never hands back the same number.
  const first = store.allocateInvoiceNumber(vendor.id);
  const second = store.allocateInvoiceNumber(vendor.id);
  say('allocated', [first.id, second.id]);
  say('nextNumber', store.getVendor(vendor.id).nextNumber);

  const invoice = store.saveInvoice({
    id: first.id, number: first.number, vendorId: vendor.id, clientId: client.id,
    issueDate: '2026-09-09', lineItems: [{ description: 'Anvil', quantityMilli: 2000, rateCents: 8500 }],
  }, { create: true });
  say('saved', invoice.id);

  sayThrow('create over existing', () => store.saveInvoice({ ...invoice }, { create: true }));

  say('scan', store.scanInvoices().invoices.map((i) => i.id));
  say('count for client', store.invoiceCountForClient(client.id));

  store.deleteInvoice(invoice.id);
  say('after delete', store.listInvoices().map((i) => i.id));
  // The gap is the point: a deleted invoice's number is retired, not recycled.
  say('next after delete', store.allocateInvoiceNumber(vendor.id).id);

  // A counter may never move backward, whichever backend is underneath.
  const clamped = store.updateVendor(vendor.id, { ...store.getVendor(vendor.id), nextNumber: 1 });
  say('counter floor', clamped.nextNumber);

  return log;
}

test('the memory backend is indistinguishable from the filesystem', () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  useBackendResolver(() => fsBackend);
  const onDisk = script();

  const memory = createMemoryBackend();
  useBackendResolver(() => memory);
  const inMemory = script();

  useBackendResolver(() => fsBackend);

  assert.deepEqual(inMemory, onDisk);
  assert.ok(onDisk.length > 15, 'the script should actually exercise something');
});

test('the demo backend writes nothing to disk', () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const memory = createMemoryBackend();
  useBackendResolver(() => memory);
  script();
  useBackendResolver(() => fsBackend);

  // The requirement, tested directly rather than inferred: after a full script
  // of creates, updates, saves and deletes, the data directory does not exist.
  assert.equal(fs.existsSync(DATA_DIR), false);
  assert.ok(memory.size() > 0, 'and yet the records are there in memory');
});

test('both backends return copies, not references', () => {
  // Not reachable through store.js today -- see the note in storage-memory.js.
  // Asserted at the backend level because that is where the two could diverge,
  // and because the first read-modify-without-write caller should find this
  // already guaranteed rather than discover it.
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const file = `${DATA_DIR}/vendors.json`;

  for (const [name, backend] of [['fs', fsBackend], ['memory', createMemoryBackend()]]) {
    backend.ensureDir(DATA_DIR);
    backend.writeJson(file, [{ id: 'acme', nextNumber: 7 }]);

    const read = backend.readJson(file, []);
    read[0].nextNumber = 999;

    assert.equal(backend.readJson(file, [])[0].nextNumber, 7,
      `${name} backend leaked a mutation that was never written`);
    assert.notEqual(backend.readJson(file, []), backend.readJson(file, []),
      `${name} backend handed out the same object twice`);
  }

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
