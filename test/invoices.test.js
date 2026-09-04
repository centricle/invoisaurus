import { test } from 'node:test';
import assert from 'node:assert/strict';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';
import {
  makeInvoice, makeClient, makeVendor, withSnapshots, snapshotClient, snapshotVendor, validateInvoice,
} from '../src/schema.js';
import { lineItemsFromForm, invoiceFromForm } from '../src/routes/invoices.js';

const coyote = makeClient({ name: 'Wile E. Coyote', address: { street: '1 Old Rd', city: 'Tucumcari', state: 'NM', zip: '88401' } });
const acme = makeVendor({ name: 'ACME Corporation', numberPrefix: 'ACM-' });

test('a draft snapshot follows the registry', () => {
  const draft = makeInvoice({ vendorId: acme.id, clientId: coyote.id, status: 'draft' });
  const moved = { ...coyote, address: { ...coyote.address, street: '2 New Ave' } };
  const saved = withSnapshots(draft, { vendor: acme, client: moved });
  assert.equal(saved.billTo.address.street, '2 New Ave');
});

test('a sent invoice stops following the registry', () => {
  const sent = makeInvoice({
    vendorId: acme.id, clientId: coyote.id, status: 'sent',
    billTo: snapshotClient(coyote), remitFrom: snapshotVendor(acme),
  });
  const moved = { ...coyote, address: { ...coyote.address, street: '2 New Ave' } };
  const saved = withSnapshots(sent, { vendor: acme, client: moved });
  assert.equal(saved.billTo.address.street, '1 Old Rd');
});

test('force applies at creation even when the record is not a draft', () => {
  const sent = makeInvoice({ vendorId: acme.id, clientId: coyote.id, status: 'sent' });
  const saved = withSnapshots(sent, { vendor: acme, client: coyote, force: true });
  assert.equal(saved.billTo.name, 'Wile E. Coyote');
  assert.equal(saved.remitFrom.name, 'ACME Corporation');
});

test('blank trailing rows are dropped, partial rows are kept', () => {
  const items = lineItemsFromForm({
    description: ['Discovery', '', 'Build', ''],
    quantity: ['12.5', '', '', ''],
    rate: ['150', '', '150', ''],
  });
  // Row 2 and row 4 are entirely empty and vanish. Row 3 has a description and
  // a rate but no quantity, so it survives to be caught by validation rather
  // than silently disappearing along with whatever was typed into it.
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { description: 'Discovery', quantityMilli: 12500, rateCents: 15000 });
  assert.deepEqual(items[1], { description: 'Build', quantityMilli: null, rateCents: 15000 });
});

test('a single line item still parses as a list', () => {
  const items = lineItemsFromForm({ description: 'Only row', quantity: '1', rate: '99.99' });
  assert.equal(items.length, 1);
  assert.equal(items[0].rateCents, 9999);
});

test('the due date is inferred from terms when the form omits it', () => {
  const invoice = invoiceFromForm({ issueDate: '2026-09-02', terms: 'net45', vendorId: 'v', clientId: 'c' });
  assert.equal(invoice.dueDate, '2026-10-17');
});

test('an explicit due date overrides the terms calculation', () => {
  const invoice = invoiceFromForm({ issueDate: '2026-09-02', terms: 'net30', dueDate: '2026-09-15', vendorId: 'v', clientId: 'c' });
  assert.equal(invoice.dueDate, '2026-09-15');
});

test('an invoice cannot reference a client that does not exist', () => {
  // A non-empty id is not the same as a real record. Ids are slugified from the
  // display name, so `acceleratti-incredibilus-llc` is a plausible-looking
  // id for a client actually stored as `road-runner`. Without this check the
  // invoice saved with an empty billTo and rendered a PDF with a blank Bill To.
  const invoice = makeInvoice({
    vendorId: acme.id, clientId: 'acceleratti-incredibilus-llc',
    lineItems: [{ description: 'Work', quantityMilli: 1000, rateCents: 15000 }],
  });
  const errors = validateInvoice(invoice, { vendor: acme, client: null });
  assert.ok(errors.some((e) => e.includes('No client')), errors.join(' / '));
});

test('a resolvable client passes validation', () => {
  const invoice = makeInvoice({
    vendorId: acme.id, clientId: coyote.id,
    lineItems: [{ description: 'Work', quantityMilli: 1000, rateCents: 15000 }],
  });
  assert.deepEqual(validateInvoice(invoice, { vendor: acme, client: coyote }), []);
});

test('validation without refs still checks the ids are present', () => {
  // Callers that have not looked the records up (tests, fixtures) keep the old
  // behavior rather than being told every id is unknown.
  const invoice = makeInvoice({
    vendorId: 'v', clientId: 'c',
    lineItems: [{ description: 'Work', quantityMilli: 1000, rateCents: 15000 }],
  });
  assert.deepEqual(validateInvoice(invoice), []);
});
