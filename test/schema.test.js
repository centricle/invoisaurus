import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dueDateFor, addDays, formatInvoiceNumber, makeVendor, makeClient, makeInvoice, validateVendor,
  snapshotClient, invoiceTotals, validateInvoice, addressLines, formatLongDate,
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

test('long dates are built from the string, not a Date', () => {
  // new Date('2026-01-01') is UTC midnight, which is Dec 31 in US timezones.
  assert.equal(formatLongDate('2026-01-01'), 'January 1, 2026');
  assert.equal(formatLongDate('2026-09-03'), 'September 3, 2026');
  assert.equal(formatLongDate('2026-12-31'), 'December 31, 2026');
  assert.equal(formatLongDate(''), '');
});

const vendorForm = (overrides = {}) => ({
  name: 'ACME Corporation', numberPrefix: 'ACM-', numberPad: 4, nextNumber: 1, ...overrides,
});

test('an invoice prefix has to be usable as a filename', () => {
  // The prefix is the leading half of every invoice id, and an invoice id is a
  // filename. A prefix of `../` wrote records outside the data directory; one
  // containing `/` produced a record whose URL could not match /invoices/:id,
  // leaving it unreachable and undeletable from the UI.
  for (const bad of ['../../tmp/pwn-', '2026/', 'ACM/', "O'Neil-", 'a'.repeat(17), 'A B']) {
    const errors = validateVendor(vendorForm({ numberPrefix: bad }));
    assert.ok(errors.some((e) => e.includes('prefix')), `${JSON.stringify(bad)} must be rejected`);
  }
  for (const good of ['ACM-', 'AJX-', 'a', 'INV.', 'x_9-']) {
    assert.deepEqual(validateVendor(vendorForm({ numberPrefix: good })), [], good);
  }
});

test('an invoice prefix is required and unique across vendors', () => {
  // Two vendors sharing a prefix issue the same invoice id, and the second one
  // saved replaced the first on disk with no error and no warning.
  assert.ok(validateVendor(vendorForm({ numberPrefix: '' }))[0].includes('required'));
  assert.ok(validateVendor(vendorForm({ numberPrefix: '   ' }))[0].includes('required'));

  const clash = validateVendor(vendorForm({ numberPrefix: 'ACM-' }), { takenPrefixes: ['ACM-'] });
  assert.ok(clash.some((e) => e.includes('already issues')), clash.join(' / '));
  assert.deepEqual(validateVendor(vendorForm({ numberPrefix: 'AJX-' }), { takenPrefixes: ['ACM-'] }), []);
});

test('two vendors cannot produce the same invoice id', () => {
  const a = makeVendor({ name: 'A Co', numberPrefix: 'ACO-' });
  const b = makeVendor({ name: 'B Co', numberPrefix: 'BCO-' });
  assert.notEqual(formatInvoiceNumber(a, 1), formatInvoiceNumber(b, 1));
});
