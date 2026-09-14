import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// Must precede any src import: it binds INVOISAURUS_DATA_DIR before config.js
// resolves it. See test/tmpdir.js.
import { DATA_DIR } from './tmpdir.js';
import { createJsonStore } from '../src/store.js';
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
const store = createJsonStore({ dataDir: DATA_DIR });

// A browser that has loaded one page holds the CSRF cookie and can echo its
// token back in a form. `post` below does the same, so every request here
// is the kind a real form makes; test/csrf.test.js is where the refusals live.
let csrf = { cookie: '', token: '' };

before(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  server.unref();

  const first = await fetch(`${base}/invoices`);
  const token = first.headers.getSetCookie().find((c) => c.startsWith('csrf=')).split(';')[0].slice(5);
  csrf = { cookie: `csrf=${token}`, token };
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

beforeEach(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  await store.ensureDataDir();
  vendor = await store.createVendor(ACME);
  client = await store.createClient(COYOTE);
});

/** Save an invoice straight through the store, bypassing the form. */
async function seedInvoice(overrides = {}) {
  const { number, id } = await store.allocateInvoiceNumber(vendor.id);
  return await store.saveInvoice({
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
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: csrf.cookie },
  body: new URLSearchParams({ ...fields, _csrf: csrf.token }),
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
  const invoice = await seedInvoice();
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
  const draft = await seedInvoice();
  await store.updateClient(client.id, { ...COYOTE, address: { ...COYOTE.address, street: '9 Rimrock Way' } });

  const res = await post(`/invoices/${draft.id}`, formFields(draft, { status: 'sent' }));
  assert.equal(res.status, 302);

  const saved = await store.getInvoice(draft.id);
  assert.equal(saved.status, 'sent');
  assert.equal(saved.billTo.address.street, '9 Rimrock Way');
});

test('the editor marks the saved style as the pressed one', async () => {
  const draft = await seedInvoice();
  await post(`/invoices/${draft.id}`, formFields(draft, { style: 'modern' }));

  const body = await (await fetch(`${base}/invoices/${draft.id}`)).text();
  assert.match(body, /name="style" value="modern"[^>]*aria-pressed="true"/s);
  assert.match(body, /name="style" value="classic"[^>]*aria-pressed="false"/s);
  // Submitting the editor rather than a form of its own is what keeps a style
  // change from discarding unsaved line-item edits.
  assert.match(body, /form="invoice-form" name="style"/);
  // The hooks public/js/invoice-editor.js restyles in place through. Without
  // either, a click silently reverts to the full reload.
  assert.match(body, /<form[^>]*id="invoice-form"[^>]*data-invoice-form/s);
  assert.match(body, /<iframe[^>]*data-pdf-preview/s);
  assert.match(body, /role="group" aria-label="PDF style"/);
});

test('a sent, paid or void invoice shows its style as a disabled control', async () => {
  for (const status of ['sent', 'paid', 'void']) {
    const frozen = await seedInvoice({ status, style: 'modern' });
    const body = await (await fetch(`${base}/invoices/${frozen.id}`)).text();

    assert.ok(!/name="style"/.test(body), `${status}: nothing that could submit a style`);
    const group = /<div[^>]*aria-label="PDF style"[^>]*>([\s\S]*?)<\/div>/.exec(body);
    assert.ok(group, `${status}: the style it was issued in is still shown`);
    assert.match(group[0], /cursor-not-allowed/, `${status}: not-allowed cursor on the group`);
    assert.match(group[0], /title="The style is locked once an invoice leaves draft/, `${status}: says why`);

    const buttons = group[1].match(/<button[^>]*>/g);
    assert.equal(buttons.length, 2, status);
    assert.ok(buttons.every((b) => /\sdisabled[\s>]/.test(b)), `${status}: every button disabled`);
    assert.ok(buttons.every((b) => /pointer-events-none/.test(b)), `${status}: pointer reaches the group`);
    assert.match(group[1], /aria-pressed="true"[^>]*>Modern</, `${status}: the saved style is the pressed one`);
  }
});

test('a draft offers the style buttons with no locked tooltip', async () => {
  const draft = await seedInvoice();
  const body = await (await fetch(`${base}/invoices/${draft.id}`)).text();
  assert.ok(!/cursor-not-allowed/.test(body));
  assert.ok(!/The style is locked/.test(body));
});

test('choosing a style saves it, and an ordinary save keeps it', async () => {
  // The style buttons are submit buttons, so only the one that was clicked is
  // submitted and every other save arrives with no style field at all. A
  // handler defaulting an absent style rather than falling back to the stored
  // one would quietly reset a Modern invoice to Classic on the next Save.
  const draft = await seedInvoice();
  assert.equal(draft.style, 'classic', 'a new invoice starts in the vendor default');

  await post(`/invoices/${draft.id}`, formFields(draft, { style: 'modern' }));
  assert.equal((await store.getInvoice(draft.id)).style, 'modern');

  await post(`/invoices/${draft.id}`, formFields(draft, { notes: 'Thanks.' }));
  const saved = await store.getInvoice(draft.id);
  assert.equal(saved.style, 'modern', 'a save that submits no style leaves it alone');
  assert.equal(saved.notes, 'Thanks.', 'and still saves what it did submit');
});

test('a sent invoice keeps the style it was sent in', async () => {
  // Same reasoning as the snapshots: the client already has a PDF drawn one
  // way, and redrawing that invoice number another way makes one number into
  // two different-looking documents.
  const sent = await seedInvoice({ status: 'sent' });
  await post(`/invoices/${sent.id}`, formFields(sent, { style: 'modern' }));

  assert.equal((await store.getInvoice(sent.id)).style, 'classic');
});

test('a vendor default decides the style a new invoice starts in', async () => {
  await store.updateVendor(vendor.id, { ...ACME, defaultStyle: 'modern' });
  try {
    const res = await post('/invoices', formFields(await seedInvoice()));
    assert.equal(res.status, 302);
    const created = res.headers.get('location').split('/').pop();
    assert.equal((await store.getInvoice(created)).style, 'modern');
  } finally {
    await store.updateVendor(vendor.id, { ...ACME, defaultStyle: 'classic' });
  }
});

test('a sent invoice stops following the registry on the next save', async () => {
  const sent = await seedInvoice({ status: 'sent' });
  await post(`/invoices/${sent.id}`, formFields(sent, { notes: 'Thanks.' }));
  await store.updateClient(client.id, { ...COYOTE, address: { ...COYOTE.address, street: '9 Rimrock Way' } });
  await post(`/invoices/${sent.id}`, formFields(sent, { notes: 'Thanks again.' }));

  const saved = await store.getInvoice(sent.id);
  assert.equal(saved.billTo.address.street, '22 Mesa Verde Rd');
  assert.equal(saved.notes, 'Thanks again.', 'the editable fields still save');
});

test('a submitted vendorId cannot move an invoice out of its number series', async () => {
  const ajax = await store.createVendor({ ...ACME, name: 'Ajax Novelty Co.', numberPrefix: 'AJX-' });
  const sent = await seedInvoice({ status: 'sent' });

  await post(`/invoices/${sent.id}`, formFields(sent, { vendorId: ajax.id }));

  const saved = await store.getInvoice(sent.id);
  assert.equal(saved.vendorId, vendor.id, 'the vendor is fixed at creation');
  assert.ok(saved.id.startsWith('ACM-'), 'the number stays in the series that issued it');
});

test('the vendor picker disappears once the invoice exists', async () => {
  const invoice = await seedInvoice();
  const body = await (await fetch(`${base}/invoices/${invoice.id}`)).text();
  assert.ok(!body.includes('name="vendorId"'), 'no control that the server would ignore');
  assert.ok(body.includes('ACME Corporation'));
});


test('a fresh install is told what it is missing before it fills in a form', async () => {
  // With no vendors the editor used to open on an empty "Issued by" dropdown
  // and say nothing until a 422 came back with the whole form filled in. The
  // vendor is asked for first because it owns the number series.
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  await store.ensureDataDir();

  let body = await (await fetch(`${base}/invoices/new`)).text();
  assert.ok(body.includes('No vendors yet'), 'the vendor is the first thing missing');
  assert.ok(body.includes('/vendors/new'));

  const onlyVendor = await store.createVendor(ACME);
  body = await (await fetch(`${base}/invoices/new`)).text();
  assert.ok(body.includes('No clients yet'), 'then the client');
  assert.ok(body.includes('/clients/new'));

  // A clientId cannot conjure a vendor into existence either.
  const someClient = await store.createClient(COYOTE);
  body = await (await fetch(`${base}/invoices/new?clientId=${someClient.id}`)).text();
  assert.ok(body.includes('name="vendorId"') || body.includes('ACME Corporation'));
  assert.equal((await store.getVendor(onlyVendor.id)).nextNumber, 1, 'nothing was allocated by looking');
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

  const saved = await store.getInvoice('ACM-0001');
  assert.equal(saved.number, 1);
  assert.equal(saved.lineItems[0].quantityMilli, 12500, 'quantity is stored in thousandths');
  assert.equal(saved.lineItems[0].rateCents, 15000, 'rate is stored in cents');
  assert.equal(saved.billTo.name, 'Wile E. Coyote', 'the client is snapshotted at creation');
  assert.equal(saved.remitFrom.name, 'ACME Corporation', 'so is the vendor');
  assert.equal((await store.getVendor(vendor.id)).nextNumber, 2, 'the counter moved once');
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
  assert.equal((await store.getVendor(vendor.id)).nextNumber, 1, 'the counter did not move');
  assert.deepEqual(await store.listInvoices(), [], 'and nothing was written');
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
  const good = await seedInvoice();
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

test('a file that parses but is not an invoice does not take the list down', async () => {
  // The unreadable guard used to catch only files that would not parse. `{}`
  // parses, reached invoiceTotals, and turned the list into a 500 -- so a
  // half-finished hand edit took out the page that was supposed to report it.
  const good = await seedInvoice();
  for (const [file, body] of Object.entries({
    'ACM-0002.json': '{}',
    'ACM-0003.json': '[]',
    'ACM-0004.json': 'null',
  })) {
    fs.writeFileSync(path.join(DATA_DIR, 'invoices', file), body);
  }

  const res = await fetch(`${base}/invoices`);
  assert.equal(res.status, 200, 'a wrong-shaped file is not a 500 either');

  const body = await res.text();
  assert.ok(body.includes(good.id), 'the readable invoices still render');
  for (const file of ['ACM-0002.json', 'ACM-0003.json', 'ACM-0004.json']) {
    assert.ok(body.includes(file), `${file} is named on the page`);
  }
  assert.ok(body.includes('3 unreadable'), 'and counted in the footer');
});

test('the editor and the PDF route 404 on a file that is not a record', async () => {
  fs.writeFileSync(path.join(DATA_DIR, 'invoices', 'ACM-0007.json'), '{"id":"ACM-0007"}');
  assert.equal((await fetch(`${base}/invoices/ACM-0007`)).status, 404);
  assert.equal((await fetch(`${base}/invoices/ACM-0007/pdf`)).status, 404);
});

test('a server error explains itself without printing a filesystem path', async () => {
  // The 500 handler rendered 404.ejs, which appends "not found" to whatever it
  // is given -- so the page read "Something broke: <error> not found." It also
  // put the absolute path of the offending file on screen, which is a username
  // in every screenshot and the reason the footer shows the data dir as `~`.
  fs.writeFileSync(path.join(DATA_DIR, 'clients.json'), 'not json');

  const res = await fetch(`${base}/clients`);
  assert.equal(res.status, 500);

  const body = await res.text();
  assert.ok(!body.includes('not found'), 'the 404 template is not doing this job');
  assert.ok(!body.includes('Corrupt data file'), 'the raw error stays out of the page');
  // The footer prints the data directory by design, home-relative so it does
  // not carry a username. What must not appear is the path the *error* names.
  assert.ok(!body.includes('clients.json'), 'and so does the file it names');
  assert.ok(body.includes('Something broke'), 'but the reader is still told what happened');
  assert.ok(body.includes('terminal'), 'and where the detail actually is');
});

test('the PDF route serves the real document, inline or as a download', async () => {
  const invoice = await seedInvoice();

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
  const sent = await seedInvoice({ status: 'sent' });
  await post(`/invoices/${sent.id}`, formFields(sent, { notes: 'Sent.' }));

  await store.updateVendor(vendor.id, {
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
  const firstBody = await first.text();
  assert.ok(firstBody.includes('Invoice ACM-0001 created.'));
  // The hook public/js/unsaved.js removes the banner through once the form is
  // edited, so a stale confirmation cannot sit above unsaved work.
  assert.match(firstBody, /<p role="status" data-flash/);
  assert.match(first.headers.get('set-cookie') || '', /flash=;/, 'the cookie is cleared on read');

  const again = await fetch(`${base}/invoices/ACM-0001`);
  assert.ok(!(await again.text()).includes('created.'), 'a refresh does not re-show it');
});

test('every form page renders a hidden save bar wired to its form', async () => {
  const invoice = await seedInvoice();
  const pages = [
    [`/invoices/${invoice.id}`, 'invoice-form', 'Save Changes', `/invoices/${invoice.id}`],
    [`/invoices/new?clientId=${client.id}`, 'invoice-form', 'Create Invoice', '/invoices'],
    [`/clients/${client.id}/edit`, 'client-form', 'Save Changes', `/clients/${client.id}/edit`],
    ['/clients/new', 'client-form', 'Create Client', '/clients'],
    [`/vendors/${vendor.id}/edit`, 'vendor-form', 'Save Changes', `/vendors/${vendor.id}/edit`],
    ['/vendors/new', 'vendor-form', 'Create Vendor', '/vendors'],
  ];

  for (const [url, id, label, discard] of pages) {
    const res = await fetch(`${base}${url}`);
    assert.equal(res.status, 200, url);
    const body = await res.text();

    const formAt = body.search(new RegExp(`<form[^>]*id="${id}"[^>]*data-track-changes`));
    assert.ok(formAt !== -1, `${url}: the form opts in to change tracking`);
    const barAt = body.indexOf('<div data-save-bar hidden');
    assert.ok(barAt !== -1, `${url}: a save bar, hidden until there is something to save`);
    // After the form closes, so Enter in a field still submits through the
    // form's own button rather than the bar's.
    assert.ok(barAt > body.indexOf('</form>', formAt), `${url}: the bar follows the form`);

    const bar = body.slice(barAt);
    assert.match(bar, new RegExp(`href="${discard.replace(/[?]/g, '\\?')}" data-discard`), `${url}: Discard goes to the saved record`);
    assert.match(bar, new RegExp(`form="${id}"[^>]*>${label}</button>`), `${url}: Save submits the form, same label`);
    assert.ok(!body.includes('data-form-errors'), `${url}: a clean page is not marked rejected`);
  }
});

test('a rejected save marks the page as unsaved from the moment it loads', async () => {
  // The server renders the refused input back into the form. It matches what
  // the page loaded with, so a comparison alone would call it saved.
  const invoice = await seedInvoice();
  const responses = {
    'new invoice': await post('/invoices', {
      vendorId: vendor.id, clientId: client.id, issueDate: '2026-09-02', terms: 'net30',
      status: 'draft', 'description[]': '', 'quantity[]': '1', 'rate[]': '150',
    }),
    'invoice edit': await post(`/invoices/${invoice.id}`, formFields(invoice, { 'description[]': '' })),
    'new client': await post('/clients', { name: '', type: 'business' }),
    'client edit': await post(`/clients/${client.id}`, { name: '', type: 'individual' }),
    'new vendor': await post('/vendors', { name: '' }),
    'vendor edit': await post(`/vendors/${vendor.id}`, { name: '' }),
  };

  for (const [what, res] of Object.entries(responses)) {
    assert.equal(res.status, 422, what);
    const body = await res.text();
    assert.match(body, /data-form-errors/, `${what}: marked rejected`);
    assert.match(body, /data-save-bar/, `${what}: with the bar there to show`);
  }
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

test('a multi-line description survives the round trip to the PDF', async () => {
  await post('/invoices', {
    vendorId: vendor.id,
    clientId: client.id,
    issueDate: '2026-09-02',
    terms: 'net30',
    status: 'draft',
    'description[]': 'Environment restoration\r\nRepo and dependency audit',
    'quantity[]': '1',
    'rate[]': '150',
  });

  const saved = await store.getInvoice('ACM-0001');
  assert.equal(
    saved.lineItems[0].description,
    'Environment restoration\nRepo and dependency audit',
    'the record carries a line feed and no carriage return',
  );

  const res = await fetch(`${base}/invoices/ACM-0001/pdf`);
  const text = pdfText(Buffer.from(await res.arrayBuffer()));
  assert.match(text, /Environment restoration/);
  assert.match(text, /Repo and dependency audit/);
});
