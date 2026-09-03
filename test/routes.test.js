import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Route-level tests.
 *
 * Everything else in this suite tests pure functions, which is why the bugs
 * these cover survived: a path-traversal id, a snapshot frozen one save early
 * and a vendor swapped out from under a sent invoice all live in the request
 * handlers, where a unit test never looked. The app is imported against a
 * temporary data directory and bound to port 0, so these need no fixtures on
 * disk and no free port.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoisaurus-routes-'));
process.env.INVOISAURUS_DATA_DIR = dir;
const store = await import('../src/store.js');
const { app } = await import('../server.js');

let base;

before(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  server.unref();
});

const ACME = {
  name: 'ACME Corporation', email: 'billing@acme-corp.example', numberPrefix: 'ACM-',
  numberPad: 4, nextNumber: 1,
  address: { street: '1 Anvil Plaza', city: 'Sedona', state: 'AZ', zip: '86336' },
};
const COYOTE = {
  name: 'Wile E. Coyote', displayName: 'Coyote', type: 'individual',
  address: { street: '22 Mesa Verde Rd', city: 'Tucumcari', state: 'NM', zip: '88401' },
};

let vendor;
let client;

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  store.ensureDataDir();
  vendor = store.createVendor(ACME);
  client = store.createClient(COYOTE);
});

/** Save an invoice straight through the store, bypassing the form. */
function seedInvoice(overrides = {}) {
  const { number, id } = store.allocateInvoiceNumber(vendor.id);
  return store.saveInvoice({
    id,
    number,
    vendorId: vendor.id,
    clientId: client.id,
    issueDate: '2026-09-02',
    terms: 'net30',
    status: 'draft',
    lineItems: [{ description: 'Discovery', quantityMilli: 1000, rateCents: 15000 }],
    ...overrides,
  }, { create: true });
}

const post = (url, fields) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields),
  redirect: 'manual',
});

const formFields = (invoice, overrides = {}) => ({
  vendorId: invoice.vendorId,
  clientId: invoice.clientId,
  issueDate: invoice.issueDate,
  terms: invoice.terms,
  dueDate: invoice.dueDate,
  status: invoice.status,
  notes: invoice.notes || '',
  'description[]': invoice.lineItems[0].description,
  'quantity[]': '1',
  'rate[]': '150',
  ...overrides,
});

test('an invoice id that is not filename-safe never reaches the store', async () => {
  // Express percent-decodes route params, so these arrive at the handler as
  // `../clients` and `../../clients`. Before the guard, the first one returned
  // 200 with the contents of clients.json rendered into the invoice form.
  for (const id of ['%2e%2e%2fclients', '..%2F..%2Fclients', '%2e%2e%2f%2e%2e%2fvendors']) {
    const res = await fetch(`${base}/invoices/${id}`);
    assert.equal(res.status, 404, `GET /invoices/${id} must not resolve`);
    const body = await res.text();
    assert.ok(!body.includes('Wile E. Coyote'), `GET /invoices/${id} leaked registry data`);
  }
});

test('the PDF and delete routes reject the same ids', async () => {
  assert.equal((await fetch(`${base}/invoices/%2e%2e%2fclients/pdf`)).status, 404);
  assert.equal((await post('/invoices/%2e%2e%2fclients/delete', {})).status, 404);
});

test('the delete confirmation carries the id as data, not as script', async () => {
  const invoice = seedInvoice();
  const body = await (await fetch(`${base}/invoices/${invoice.id}`)).text();

  // An inline onsubmit would be HTML-escaped, which the browser undoes before
  // the JS parser runs -- so an apostrophe in the id would close the string.
  assert.ok(!/onsubmit=/.test(body), 'no inline submit handler on the page');
  assert.ok(body.includes(`data-delete-invoice="${invoice.id}"`));
});

test('sending an invoice freezes the details it is being sent with', async () => {
  // The freeze must be decided on the status the record *had*. Reading the
  // submitted status froze one save too early and preserved the address from
  // the previous draft save -- an address the invoice was never sent with.
  const draft = seedInvoice();
  store.updateClient(client.id, { ...COYOTE, address: { ...COYOTE.address, street: '9 Rimrock Way' } });

  const res = await post(`/invoices/${draft.id}`, formFields(draft, { status: 'sent' }));
  assert.equal(res.status, 302);

  const saved = store.getInvoice(draft.id);
  assert.equal(saved.status, 'sent');
  assert.equal(saved.billTo.address.street, '9 Rimrock Way');
});

test('a sent invoice stops following the registry on the next save', async () => {
  const sent = seedInvoice({ status: 'sent' });
  await post(`/invoices/${sent.id}`, formFields(sent, { notes: 'Thanks.' }));
  store.updateClient(client.id, { ...COYOTE, address: { ...COYOTE.address, street: '9 Rimrock Way' } });
  await post(`/invoices/${sent.id}`, formFields(sent, { notes: 'Thanks again.' }));

  const saved = store.getInvoice(sent.id);
  assert.equal(saved.billTo.address.street, '22 Mesa Verde Rd');
  assert.equal(saved.notes, 'Thanks again.', 'the editable fields still save');
});

test('a submitted vendorId cannot move an invoice out of its number series', async () => {
  const ajax = store.createVendor({ ...ACME, name: 'Ajax Novelty Co.', numberPrefix: 'AJX-' });
  const sent = seedInvoice({ status: 'sent' });

  await post(`/invoices/${sent.id}`, formFields(sent, { vendorId: ajax.id }));

  const saved = store.getInvoice(sent.id);
  assert.equal(saved.vendorId, vendor.id, 'the vendor is fixed at creation');
  assert.ok(saved.id.startsWith('ACM-'), 'the number stays in the series that issued it');
});

test('the vendor picker disappears once the invoice exists', async () => {
  const invoice = seedInvoice();
  const body = await (await fetch(`${base}/invoices/${invoice.id}`)).text();
  assert.ok(!body.includes('name="vendorId"'), 'no control that the server would ignore');
  assert.ok(body.includes('ACME Corporation'));
});
