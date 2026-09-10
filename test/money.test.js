import { test } from 'node:test';
import assert from 'node:assert/strict';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';
import {
  parseCents, parseQuantity, lineAmountCents, formatUSD, formatQuantity, sumCents,
  quantityInputValue, centsInputValue, MAX_CENTS,
} from '../src/money.js';

test('parseCents accepts the shapes a human types', () => {
  assert.equal(parseCents('150'), 15000);
  assert.equal(parseCents('150.00'), 15000);
  assert.equal(parseCents('$1,500.50'), 150050);
  assert.equal(parseCents(' 0.07 '), 7);
  assert.equal(parseCents('-25.00'), -2500);
});

test('parseCents rounds the first dropped digit rather than truncating', () => {
  assert.equal(parseCents('0.005'), 1);
  assert.equal(parseCents('0.004'), 0);
});

test('parseCents returns null for empty and garbage, never 0', () => {
  // An empty rate must not silently become $0.00 on a client's invoice.
  assert.equal(parseCents(''), null);
  assert.equal(parseCents('abc'), null);
  assert.equal(parseCents(null), null);
});

test('a value with no digit in it is not a number', () => {
  // "-." matched the old `-?\d*\.?\d*` pattern and was not one of the three
  // shapes rejected by hand, so it reached `Number("") * scale` and returned
  // -0. A rate of -0 is not null, so it survived the blank-row filter and
  // every "is this missing" check, and billed the line at $0.00.
  for (const input of ['-.', '.', '-', '-.-', '..', '$', '-$']) {
    assert.equal(parseCents(input), null, `parseCents(${JSON.stringify(input)})`);
    assert.equal(parseQuantity(input), null, `parseQuantity(${JSON.stringify(input)})`);
  }

  // A point on either side of the digits is still a number, and stays one.
  assert.equal(parseCents('.5'), 50);
  assert.equal(parseCents('-.5'), -50);
  assert.equal(parseCents('5.'), 500);
  assert.equal(parseCents('-5.'), -500);
});

test('line amounts stay exact where floats would not', () => {
  // 0.1 * 15000 in float arithmetic is 1500.0000000000002.
  assert.equal(lineAmountCents(parseQuantity('0.1'), parseCents('150')), 1500);
  assert.equal(lineAmountCents(parseQuantity('12.5'), parseCents('150')), 187500);
  assert.equal(lineAmountCents(parseQuantity('3'), parseCents('99.99')), 29997);
});

test('a long invoice sums without drift', () => {
  const amounts = Array.from({ length: 1000 }, () => lineAmountCents(parseQuantity('0.1'), parseCents('0.10')));
  assert.equal(sumCents(amounts), 1000); // exactly $10.00
});

test('formatting is the only place decimals appear', () => {
  assert.equal(formatUSD(187500), '$1,875.00');
  assert.equal(formatUSD(7), '$0.07');
  assert.equal(formatUSD(-2500), '-$25.00');
  assert.equal(formatQuantity(12500), '12.5');
  assert.equal(formatQuantity(3000), '3');
});

test('input values are valid for an <input type="number">', () => {
  // A number input silently blanks any value the HTML spec calls invalid, and
  // "9,999" is invalid. This is the rule the browser applies, asserted directly.
  for (const milli of [100, 12500, 999000, 1000000, 9999000, 123456789]) {
    const value = quantityInputValue(milli);
    assert.ok(!/[,\s$]/.test(value), `${milli} rendered as "${value}"`);
    assert.ok(!Number.isNaN(Number(value)), `Number("${value}") is NaN`);
  }
});

test('input values round-trip back to the same stored integer', () => {
  // The failure was not just display: the blank field submitted as empty and
  // wrote the quantity back as null, destroying it.
  for (const milli of [100, 12500, 999000, 1000000, 9999000, 123456789]) {
    assert.equal(parseQuantity(quantityInputValue(milli)), milli, `quantity ${milli}`);
  }
  for (const cents of [1, 200, 99999, 150000, 9999900, 123456789]) {
    assert.equal(parseCents(centsInputValue(cents)), cents, `rate ${cents}`);
  }
});

test('display formatting still groups thousands', () => {
  // The grouped forms are still correct for pages and the PDF; they are simply
  // not what goes into a form control.
  assert.equal(formatQuantity(9999000), '9,999');
  assert.equal(formatUSD(1999800), '$19,998.00');
  assert.equal(quantityInputValue(9999000), '9999');
});

test('a null quantity or rate renders an empty field, not a zero', () => {
  assert.equal(quantityInputValue(null), '');
  assert.equal(centsInputValue(null), '');
});


test('zero is a value and empty is not', () => {
  // parseCents returns null for "no answer" so a blank rate is not billed as
  // $0.00. Zero itself has to survive that, and it is falsy, so every caller
  // has to test `!= null` rather than truthiness.
  assert.equal(parseCents('0'), 0);
  assert.equal(parseCents('0.00'), 0);
  assert.equal(parseQuantity('0'), 0);
  assert.equal(parseCents(''), null);
  assert.equal(parseCents('   '), null);
  assert.equal(parseCents(null), null);
  assert.equal(parseCents(undefined), null);

  assert.equal(formatUSD(0), '$0.00');
  assert.equal(formatQuantity(0), '0');
  assert.equal(centsInputValue(0), '0.00');
  assert.equal(quantityInputValue(0), '0');

  assert.equal(formatUSD(null), '', 'a missing value formats as nothing, not as zero');
});

test('negative amounts round away from zero, like positive ones', () => {
  // A credit line is the reason this branch exists. Math.round breaks ties
  // toward positive infinity, so -2.5 would go to -2 without the guard.
  assert.equal(parseCents('-150.00'), -15000);
  assert.equal(parseCents('-0.005'), -1, 'the half rounds away from zero, not toward it');
  assert.equal(lineAmountCents(parseQuantity('-0.5'), parseCents('0.05')), -3);
  assert.equal(lineAmountCents(parseQuantity('2'), parseCents('-150.00')), -30000);
  assert.equal(formatUSD(-187500), '-$1,875.00');
  assert.equal(centsInputValue(-15000), '-150.00');
  assert.equal(sumCents([15000, -5000, null]), 10000);
});

test('a value past safe-integer range is rejected, not stored approximately', () => {
  // Holding a digit key down in the rate field reaches this with no malice.
  // Before the guard this returned 1e+23 and JSON.stringify wrote it back as
  // "1e+23", so the stored value no longer round-tripped to itself.
  assert.equal(parseCents('999999999999999999999'), null);
  assert.equal(parseQuantity('999999999999999999999'), null);

  // The boundary itself, to the cent. Rejecting one cent too early would be a
  // silent cap, which is the failure this guard exists to prevent.
  assert.equal(parseCents('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  assert.equal(parseCents('90071992547409.92'), null);
});

test('every value parseCents returns survives a JSON round trip exactly', () => {
  for (const input of ['0', '0.01', '1234.56', '-5.00', '90071992547409.91']) {
    const cents = parseCents(input);
    assert.equal(JSON.parse(JSON.stringify({ cents })).cents, cents);
    assert.ok(Number.isSafeInteger(cents), `${input} parsed to a non-integer`);
  }
});

test('MAX_CENTS is far below the safe-integer ceiling, deliberately', () => {
  // The two bounds do different jobs: safe-integer is correctness, MAX_CENTS is
  // plausibility. If these ever converge, the plausibility check has stopped
  // being a check on anything a human would notice.
  assert.ok(MAX_CENTS < Number.MAX_SAFE_INTEGER / 1000);
  assert.equal(formatUSD(MAX_CENTS), '$1,000,000,000.00');
});
