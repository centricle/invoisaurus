import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dueDateFor, addDays, formatInvoiceNumber, makeVendor, makeClient, makeInvoice,
  snapshotClient, invoiceTotals, validateInvoice, addressLines,
} from '../src/schema.js';
import { parseCents, parseQuantity } from '../src/money.js';

test('due dates are calendar arithmetic, not timezone arithmetic', () => {
  assert.equal(dueDateFor('2026-09-02', 'net30'), '2026-10-02');
  assert.equal(dueDateFor('2026-09-02', 'on-receipt'), '2026-09-02');
  assert.equal(addDays('2026-12-20', 30), '2027-01-19'); // year rollover
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');  // leap year
});

test('invoice numbers are per-vendor and zero-padded', () => {
  const acme = makeVendor({ name: 'ACME Corporation', numberPrefix: 'ACM-', numberPad: 4 });
  const ajax = makeVendor({ name: 'Ajax Novelty Co.', numberPrefix: 'AJX-', numberPad: 4 });
  assert.equal(formatInvoiceNumber(acme, 1), 'ACM-0001');
  assert.equal(formatInvoiceNumber(acme, 42), 'ACM-0042');
  // The prefix is what keeps two entities' number 14 from colliding.
  assert.notEqual(formatInvoiceNumber(acme, 14), formatInvoiceNumber(ajax, 14));
});

test('an invoice snapshots the client and does not track later edits', () => {
  const client = makeClient({ name: 'Wile E. Coyote', address: { street: '1 Old Rd', city: 'Tucumcari', state: 'NM', zip: '88401' } });
  const invoice = makeInvoice({ vendorId: 'acme-corporation', clientId: client.id, billTo: snapshotClient(client) });

  client.address.street = '2 New Ave'; // client moves

  assert.equal(invoice.billTo.address.street, '1 Old Rd');
  assert.equal(invoice.clientId, client.id); // still queryable
});

test('totals are derived from line items', () => {
  const invoice = makeInvoice({
    vendorId: 'acme-corporation',
    clientId: 'coyote',
    lineItems: [
      { description: 'Discovery', quantityMilli: parseQuantity('12.5'), rateCents: parseCents('150') },
      { description: 'Build', quantityMilli: parseQuantity('8'), rateCents: parseCents('150') },
    ],
  });
  assert.equal(invoiceTotals(invoice).totalCents, 187500 + 120000);
});

test('validation catches the ways an invoice goes out wrong', () => {
  assert.deepEqual(validateInvoice(makeInvoice({ vendorId: 'acme-corporation', clientId: 'coyote', lineItems: [] })),
    ['An invoice needs at least one line item.']);

  const missingRate = makeInvoice({
    vendorId: 'acme-corporation', clientId: 'coyote',
    lineItems: [{ description: 'Work', quantityMilli: parseQuantity('1'), rateCents: parseCents('') }],
  });
  assert.ok(validateInvoice(missingRate).some((e) => e.includes('rate')));
});

test('address lines omit empties instead of printing blank rows', () => {
  assert.deepEqual(
    addressLines({ street: '1 Anvil Plaza', street2: '', city: 'Sedona', state: 'AZ', zip: '86336' }),
    ['1 Anvil Plaza', 'Sedona, AZ 86336'],
  );
});
