/**
 * The store contract, as a script every implementation has to answer alike.
 *
 * The demo runs the real routes against a store held in memory; a hosted
 * version runs them against a database. That is only safe if the stores are
 * indistinguishable to the code above them, so rather than assert that each
 * one "looks right", one script of operations is run against every
 * implementation and the same answers are required -- including the same
 * thrown messages, because a route branches on those.
 *
 * Every invariant exercised below is one the audit or a past bug put there:
 * ids are immutable, an update cannot invent a record, a create cannot
 * overwrite one, a number is never reused after a delete, two vendors cannot
 * share a prefix.
 *
 * `store-contract.golden.json` is the answer key, recorded from the JSON
 * store. A new implementation compares against it with `assertStoreContract`
 * and fails on the first line that differs, which names the operation rather
 * than the whole log. Regenerate the key only when the contract itself
 * changes, and read the diff: a changed line is a changed rule.
 */
import fs from 'node:fs';
import assert from 'node:assert/strict';

const GOLDEN = new URL('./store-contract.golden.json', import.meta.url);

/**
 * Run the script against `store` and return the log.
 *
 * `redact` scrubs anything environment-specific out of error messages before
 * they are logged; the JSON store's messages can carry the data directory.
 */
export async function storeContractScript(store, { redact = (s) => s } = {}) {
  const log = [];
  const say = (label, value) => log.push(`${label}: ${JSON.stringify(value)}`);
  const sayThrow = async (label, fn) => {
    try {
      await fn();
      say(label, 'NO THROW');
    } catch (err) {
      say(label, redact(err.message));
    }
  };

  await store.ensureDataDir();
  say('empty vendors', await store.listVendors());
  say('empty invoices', await store.listInvoices());
  say('scan of nothing', await store.scanInvoices());

  const vendor = await store.createVendor({ name: 'ACME Corporation', numberPrefix: 'ACM-', numberPad: 4, nextNumber: 1 });
  say('vendor id', vendor.id);
  say('vendor shape', Object.keys(vendor).sort());

  // A prefix names a number series, and a series has one owner.
  await sayThrow('second vendor with the same prefix', () =>
    store.createVendor({ name: 'Ajax Novelty Co.', numberPrefix: 'ACM-', numberPad: 4, nextNumber: 1 }));
  const ajax = await store.createVendor({ name: 'Ajax Novelty Co.', numberPrefix: 'AJX-', numberPad: 3, nextNumber: 10 });
  say('second vendor id', ajax.id);
  await sayThrow('update onto a taken prefix', () => store.updateVendor(ajax.id, { ...ajax, numberPrefix: 'ACM-' }));
  say('update keeping own prefix', (await store.updateVendor(ajax.id, { ...ajax, name: 'Ajax Novelties' })).name);
  say('vendor count', (await store.listVendors()).length);
  say('unknown vendor', await store.getVendor('nope'));
  await sayThrow('update unknown vendor', () => store.updateVendor('nope', { name: 'X', numberPrefix: 'X-' }));

  const client = await store.createClient({ name: 'Wile E. Coyote', type: 'individual' });
  say('client id', client.id);
  say('client shape', Object.keys(client).sort());

  // Renaming must not mint a second record or change the id.
  const renamed = await store.updateClient(client.id, { ...client, name: 'Carnivorous Vulgaris, LLC', type: 'business' });
  say('id after rename', renamed.id);
  say('client count after rename', (await store.listClients()).length);
  say('createdAt preserved', renamed.createdAt === client.createdAt);
  say('id cannot be changed by an update', (await store.updateClient(client.id, { ...client, id: 'hijacked' })).id);
  say('hijacked id resolves to', await store.getClient('hijacked'));

  await sayThrow('update unknown client', () => store.updateClient('nope', { name: 'X', type: 'business' }));

  // A second client with the same display name gets a distinct id.
  const twin = await store.createClient({ name: 'Wile E. Coyote', type: 'individual' });
  say('twin id', twin.id);
  say('taken client ids', await store.takenClientIds());
  say('taken vendor ids', await store.takenVendorIds());

  // Allocation advances the vendor counter and never hands back the same number.
  const first = await store.allocateInvoiceNumber(vendor.id);
  const second = await store.allocateInvoiceNumber(vendor.id);
  say('allocated', [first.id, second.id]);
  say('nextNumber', (await store.getVendor(vendor.id)).nextNumber);
  await sayThrow('allocate for unknown vendor', () => store.allocateInvoiceNumber('nope'));

  const invoice = await store.saveInvoice({
    id: first.id, number: first.number, vendorId: vendor.id, clientId: client.id,
    issueDate: '2026-09-09', lineItems: [{ description: 'Anvil', quantityMilli: 2000, rateCents: 8500 }],
  }, { create: true });
  say('saved', invoice.id);
  say('invoice shape', Object.keys(invoice).sort());
  say('line item shape', Object.keys(invoice.lineItems[0]).sort());

  await sayThrow('create over existing', () => store.saveInvoice({ ...invoice }, { create: true }));
  say('update over existing', (await store.saveInvoice({ ...invoice, notes: 'edited' })).notes);
  say('read back', (await store.getInvoice(invoice.id)).notes);
  await sayThrow('save without an id', () => store.saveInvoice({ vendorId: vendor.id, clientId: client.id }));
  await sayThrow('save with an unsafe id', () => store.saveInvoice({ id: '../escape', vendorId: vendor.id, clientId: client.id }));
  await sayThrow('read an unsafe id', () => store.getInvoice('a/b'));
  say('read a missing id', await store.getInvoice('ACM-9999'));

  // createInvoice allocates and writes as one step, and the number keeps
  // climbing from wherever the counter is.
  const created = await store.createInvoice({
    vendorId: vendor.id, clientId: client.id, issueDate: '2026-09-10',
    lineItems: [{ description: 'Rocket skates', quantityMilli: 1000, rateCents: 12000 }],
  });
  say('created', [created.id, created.number]);
  say('nextNumber after create', (await store.getVendor(vendor.id)).nextNumber);
  await sayThrow('create for unknown vendor', () => store.createInvoice({ vendorId: 'nope', clientId: client.id }));

  say('scan', (await store.scanInvoices()).invoices.map((i) => i.id));
  say('list order is newest first', (await store.listInvoices()).map((i) => i.issueDate));
  say('count for client', await store.invoiceCountForClient(client.id));
  say('count for twin', await store.invoiceCountForClient(twin.id));

  await store.deleteInvoice(invoice.id);
  say('after delete', (await store.listInvoices()).map((i) => i.id));
  say('deleted reads as', await store.getInvoice(invoice.id));
  // The gap is the point: a deleted invoice's number is retired, not recycled.
  say('next after delete', (await store.createInvoice({ vendorId: vendor.id, clientId: client.id })).id);
  await sayThrow('delete an unsafe id', () => store.deleteInvoice('../escape'));

  // A counter may never move backward, whichever store is underneath.
  const clamped = await store.updateVendor(vendor.id, { ...(await store.getVendor(vendor.id)), nextNumber: 1 });
  say('counter floor', clamped.nextNumber);

  // The other vendor's series is its own.
  say('other series', (await store.createInvoice({ vendorId: ajax.id, clientId: client.id })).id);

  return log;
}

/**
 * Run the script through a fresh store from `makeStore` and compare it, line
 * by line, with the recorded answer key.
 */
export async function assertStoreContract(makeStore, { redact } = {}) {
  const expected = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const actual = await storeContractScript(await makeStore(), { redact });

  for (let i = 0; i < Math.max(expected.length, actual.length); i += 1) {
    assert.equal(actual[i], expected[i], `store contract diverges at step ${i + 1}`);
  }
}
