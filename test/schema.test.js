import { test } from 'node:test';
import assert from 'node:assert/strict';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';
import {
  dueDateFor, addDays, formatInvoiceNumber, makeVendor, makeClient, makeInvoice, validateVendor,
  snapshotClient, invoiceTotals, validateInvoice, addressLines, isOverdue, daysOverdue,
  formatLongDate, validateClient, termById,
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

test('only a sent invoice can be overdue', () => {
  const past = { dueDate: '2026-08-01' };
  assert.equal(isOverdue({ ...past, status: 'sent' }, '2026-09-03'), true);
  assert.equal(isOverdue({ ...past, status: 'draft' }, '2026-09-03'), false);
  assert.equal(isOverdue({ ...past, status: 'paid' }, '2026-09-03'), false);
  assert.equal(isOverdue({ ...past, status: 'void' }, '2026-09-03'), false);
});

test('an invoice is not overdue on its due date', () => {
  assert.equal(isOverdue({ status: 'sent', dueDate: '2026-09-03' }, '2026-09-03'), false);
  assert.equal(daysOverdue({ dueDate: '2026-09-01' }, '2026-09-03'), 2);
});

test('isOverdue is safe to use as a filter predicate', () => {
  // Array.filter passes (element, index, array). Passing isOverdue by
  // reference put the index into `asOf`, so every date compared against a
  // number and the overdue count was always zero — while the same function
  // called with one argument elsewhere reported correctly.
  const invoices = [
    { status: 'sent', dueDate: '2026-07-15' },
    { status: 'sent', dueDate: '2026-08-01' },
    { status: 'draft', dueDate: '2026-07-01' },
  ];
  assert.equal(invoices.filter((inv) => isOverdue(inv, '2026-09-03')).length, 2);
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


test('a client needs a legal name and a real type', () => {
  const ok = { name: 'Wile E. Coyote', type: 'individual' };
  assert.deepEqual(validateClient(ok), []);

  assert.match(validateClient({ ...ok, name: '   ' })[0], /Legal name is required/);
  assert.match(validateClient({ ...ok, type: 'walrus' })[0], /Business or Individual/);
  assert.equal(validateClient({ name: '', type: '' }).length, 2, 'both problems are reported at once');
});

test('a vendor counter may move forward but not backward', () => {
  // Gaps are voided invoices. A duplicate is on someone's books twice.
  const existing = makeVendor({ name: 'ACME Corporation', numberPrefix: 'ACM-', nextNumber: 42 });
  const input = { name: 'ACME Corporation', numberPrefix: 'ACM-', numberPad: 4 };

  assert.deepEqual(validateVendor({ ...input, nextNumber: 42 }, { existing }), []);
  assert.deepEqual(validateVendor({ ...input, nextNumber: 99 }, { existing }), []);
  assert.match(
    validateVendor({ ...input, nextNumber: 41 }, { existing })[0],
    /cannot move backward from 42/,
  );
});

test('number padding has to be a whole number in range', () => {
  const input = { name: 'ACME Corporation', numberPrefix: 'ACM-', nextNumber: 1 };
  assert.deepEqual(validateVendor({ ...input, numberPad: 4 }), []);
  for (const numberPad of [0, 11, 2.5, Number('')]) {
    assert.match(validateVendor({ ...input, numberPad })[0], /padding must be between 1 and 10/);
  }
});

test('an unrecognized terms value falls back rather than erroring', () => {
  // Worth pinning because it is a silent path: makeInvoice validates `status`
  // against a list but not `terms`, so a junk value resolves to TERMS[0] and
  // the due date quietly equals the issue date. That is the current contract.
  assert.equal(termById('net45').days, 45);
  assert.equal(termById('nonsense').id, 'on-receipt');
  assert.equal(dueDateFor('2026-09-02', 'nonsense'), '2026-09-02');
  assert.equal(dueDateFor('2026-09-02', 'net15'), '2026-09-17');
  assert.equal(dueDateFor('2026-09-02', 'net60'), '2026-11-01');
});
