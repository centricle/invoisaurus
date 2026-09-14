import { test } from 'node:test';
import assert from 'node:assert/strict';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';
import { parseCsv, lineItemsFromCsv } from '../src/import.js';

test('parseCsv splits plain rows', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('parseCsv keeps commas, doubled quotes and line breaks inside a quoted field', () => {
  const rows = parseCsv('description,qty\n"Say ""hi"", then\nleave",2\n');
  assert.deepEqual(rows, [['description', 'qty'], ['Say "hi", then\nleave', '2']]);
});

test('parseCsv reads CRLF files and a missing final newline the same', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('parseCsv strips a byte order mark', () => {
  assert.deepEqual(parseCsv('﻿description\nx\n'), [['description'], ['x']]);
});

test('parseCsv keeps an empty last field', () => {
  assert.deepEqual(parseCsv('a,b\n1,\n'), [['a', 'b'], ['1', '']]);
});

test('parseCsv refuses an unclosed quote rather than swallowing the file', () => {
  assert.throws(() => parseCsv('a,b\n1,2\n"open,3\n4,5\n'), /Unclosed quote starting on line 3/);
});

test('lineItemsFromCsv parses into cents and thousandths', () => {
  const { lineItems, errors } = lineItemsFromCsv(
    'description,quantity,rate\n"**Heading**\r\nBody line.",7.5,125.00\nAnvil,2,"$1,250"\n',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(lineItems, [
    { description: '**Heading**\nBody line.', quantityMilli: 7500, rateCents: 12500 },
    { description: 'Anvil', quantityMilli: 2000, rateCents: 125000 },
  ]);
});

test('lineItemsFromCsv matches headers loosely and ignores extra columns', () => {
  const { lineItems, errors } = lineItemsFromCsv('Date, Rate ,Description,QTY\n2026-09-01,85,Anvil,1\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(lineItems, [{ description: 'Anvil', quantityMilli: 1000, rateCents: 8500 }]);
});

test('lineItemsFromCsv names a missing column', () => {
  const { errors } = lineItemsFromCsv('description,quantity\nAnvil,1\n');
  assert.deepEqual(errors, ['No "rate" column in the header row.']);
});

test('lineItemsFromCsv reports bad values by spreadsheet row, skipping blank rows', () => {
  const { errors } = lineItemsFromCsv('description,quantity,rate\nAnvil,1,85\n,,\nSkates,three,\n');
  assert.deepEqual(errors, ['Row 4: "three" is not a quantity.', 'Row 4: "" is not a rate.']);
});

test('lineItemsFromCsv wants at least one row', () => {
  assert.deepEqual(lineItemsFromCsv('description,quantity,rate\n').errors, ['No line items below the header row.']);
  assert.deepEqual(lineItemsFromCsv('').errors.length, 3);
});

test('lineItemsFromCsv returns a parse failure as an error', () => {
  assert.match(lineItemsFromCsv('description,quantity,rate\n"x,1,2\n').errors[0], /Unclosed quote/);
});
