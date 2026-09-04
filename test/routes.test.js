import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// Must precede any src import: it binds INVOISAURUS_DATA_DIR before config.js
// resolves it. See test/tmpdir.js.
import { DATA_DIR } from './tmpdir.js';
import * as store from '../src/store.js';
import { app } from '../server.js';
import { pdfText } from './pdftext.js';

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
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
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


test('creating an invoice allocates a number and freezes the snapshot', async () => {
  const res = await post('/invoices', {
    vendorId: vendor.id,
    clientId: client.id,
    issueDate: '2026-09-02',
    terms: 'net30',
    dueDate: '2026-10-02',
    status: 'draft',
    notes: 'Thanks.',
    'description[]': 'Discovery',
    'quantity[]': '12.5',
    'rate[]': '150.00',
  });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/invoices/ACM-0001');
  assert.match(res.headers.get('set-cookie') || '', /flash=invoice-created%3AACM-0001/);

  const saved = store.getInvoice('ACM-0001');
  assert.equal(saved.number, 1);
  assert.equal(saved.lineItems[0].quantityMilli, 12500, 'quantity is stored in thousandths');
  assert.equal(saved.lineItems[0].rateCents, 15000, 'rate is stored in cents');
  assert.equal(saved.billTo.name, 'Wile E. Coyote', 'the client is snapshotted at creation');
  assert.equal(saved.remitFrom.name, 'ACME Corporation', 'so is the vendor');
  assert.equal(store.getVendor(vendor.id).nextNumber, 2, 'the counter moved once');
});

test('an invoice that fails validation does not burn a number', async () => {
  // The number is allocated after validation for exactly this reason. Moving
  // the allocation above the check leaves a gap in the series every time
  // someone submits an incomplete form, and gaps read as lost invoices.
  const res = await post('/invoices', {
    vendorId: vendor.id,
    clientId: client.id,
    issueDate: '2026-09-02',
    terms: 'net30',
    status: 'draft',
    'description[]': '',
    'quantity[]': '',
    'rate[]': '',
  });

  assert.equal(res.status, 422);
  assert.match(await res.text(), /needs at least one line item/);
  assert.equal(store.getVendor(vendor.id).nextNumber, 1, 'the counter did not move');
  assert.deepEqual(store.listInvoices(), [], 'and nothing was written');
});

test('a well-formed id for an invoice that does not exist is a 404', async () => {
  // Every other 404 test uses a malformed id, which the router's param guard
  // rejects before a handler runs. This is the other branch: a perfectly legal
  // id that simply has no file behind it.
  assert.equal((await fetch(`${base}/invoices/ACM-9999`)).status, 404);
  assert.equal((await fetch(`${base}/invoices/ACM-9999/pdf`)).status, 404);
  assert.equal((await post('/invoices/ACM-9999', {})).status, 404);
  assert.equal((await post('/invoices/ACM-9999/delete', {})).status, 404);
});

test('one unreadable file does not take the invoice list down with it', async () => {
  const good = seedInvoice();
  fs.writeFileSync(path.join(DATA_DIR, 'invoices', 'ACM-0002.json'), '{"id": "ACM-000');

  const res = await fetch(`${base}/invoices`);
  assert.equal(res.status, 200, 'a damaged file is not a 500');

  const body = await res.text();
  assert.ok(body.includes(good.id), 'the readable invoices still render');
  assert.ok(body.includes('ACM-0002.json'), 'the damaged file is named on the page');
  assert.ok(body.includes('unreadable'), 'and marked as such rather than shown as an invoice');
  // The parse error carries the file's absolute path. The filename is enough to
  // go and find it, so the message stays out of the markup.
  assert.ok(!body.includes('Corrupt data file'), 'the raw parse error is not rendered');
});

test('the PDF route serves the real document, inline or as a download', async () => {
  const invoice = seedInvoice();

  const inline = await fetch(`${base}/invoices/${invoice.id}/pdf`);
  assert.equal(inline.status, 200);
  assert.equal(inline.headers.get('content-type'), 'application/pdf');
  assert.match(inline.headers.get('content-disposition'), /^inline; filename="ACM-0001\.pdf"$/);

  const download = await fetch(`${base}/invoices/${invoice.id}/pdf?download=1`);
  assert.match(download.headers.get('content-disposition'), /^attachment; /);
});

test('a sent invoice keeps printing the vendor it was actually sent from', async () => {
  // The snapshot rationale is about what a regenerated PDF says years later,
  // so the PDF is where it has to be asserted. The vendor side had no test at
  // all: only the client side did.
  const sent = seedInvoice({ status: 'sent' });
  await post(`/invoices/${sent.id}`, formFields(sent, { notes: 'Sent.' }));

  store.updateVendor(vendor.id, {
    ...ACME, name: 'ACME Holdings LLC', address: { ...ACME.address, street: '4 Ledge Court' },
  });

  const text = pdfText(await (await fetch(`${base}/invoices/${sent.id}/pdf`)).arrayBuffer());
  assert.ok(text.includes('ACME Corporation'), 'the PDF prints the name it was sent under');
  assert.ok(text.includes('1 Anvil Plaza'), 'and the address it was sent from');
  assert.ok(!text.includes('ACME Holdings LLC'), 'not the renamed registry entry');
});

test('a confirmation is shown once and does not survive a refresh', async () => {
  const res = await post('/invoices', {
    vendorId: vendor.id,
    clientId: client.id,
    issueDate: '2026-09-02',
    terms: 'net30',
    status: 'draft',
    'description[]': 'Discovery',
    'quantity[]': '1',
    'rate[]': '150',
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];

  const first = await fetch(`${base}/invoices/ACM-0001`, { headers: { cookie } });
  assert.ok((await first.text()).includes('Invoice ACM-0001 created.'));
  assert.match(first.headers.get('set-cookie') || '', /flash=;/, 'the cookie is cleared on read');

  const again = await fetch(`${base}/invoices/ACM-0001`);
  assert.ok(!(await again.text()).includes('created.'), 'a refresh does not re-show it');
});

test('a flash code the app did not write renders nothing', async () => {
  // `MESSAGES[code]` on its own reaches Object.prototype, so `constructor`
  // found `Object`, called it, and rendered the argument back in a success
  // banner. The lookup is an own-property check for that reason.
  for (const cookie of ['flash=constructor%3APWNED', 'flash=toString', 'flash=valueOf', 'flash=nope']) {
    const body = await (await fetch(`${base}/invoices`, { headers: { cookie } })).text();
    assert.ok(!body.includes('PWNED'), `${cookie} must not reach the page`);
    assert.ok(!body.includes('[object Object]'), `${cookie} must not reach the page`);
    assert.ok(!body.includes('role="status"'), `${cookie} must not render a banner at all`);
  }
});
