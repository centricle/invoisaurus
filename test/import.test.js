import { test } from 'node:test';
import assert from 'node:assert/strict';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCsv, lineItemsFromCsv } from '../src/import.js';
import { createJsonStore } from '../src/store.js';
import { VENDOR, CLIENT } from '../src/fixtures/acme.js';

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

// --- scripts/import.mjs ------------------------------------------------------

const SCRIPT = path.resolve(import.meta.dirname, '../scripts/import.mjs');

/** A data directory holding the ACME vendor and client, plus two CSVs. */
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoisaurus-import-'));
  const store = createJsonStore({ dataDir: dir });
  await store.ensureDataDir();
  const vendor = await store.createVendor(VENDOR);
  const client = await store.createClient(CLIENT);
  const good = path.join(dir, 'good.csv');
  const bad = path.join(dir, 'bad.csv');
  fs.writeFileSync(good, 'description,quantity,rate\n"**Skates**\nFitting.",3.5,150\nAnvil,2,85\n');
  fs.writeFileSync(bad, 'description,quantity,rate\nAnvil,lots,85\n');
  return { dir, store, vendor, client, good, bad };
}

const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
  encoding: 'utf8',
  env: { ...process.env, INVOISAURUS_DATA_DIR: dir },
});

test('import creates a numbered draft per file, with snapshots', async () => {
  const { dir, store, vendor, client, good } = await fixture();
  const result = run(dir, good, good, '--client', client.id, '--date', '2026-09-14', '--notes', 'August.');
  assert.equal(result.status, 0, result.stderr);

  const invoices = (await store.listInvoices()).sort((a, b) => a.number - b.number);
  assert.deepEqual(invoices.map((i) => i.id), ['ACM-0001', 'ACM-0002']);
  const [first] = invoices;
  assert.equal(first.status, 'draft');
  assert.equal(first.dueDate, '2026-10-14');
  assert.equal(first.notes, 'August.');
  assert.equal(first.billTo.name, client.name);
  assert.equal(first.remitFrom.name, vendor.name);
  assert.equal(first.lineItems[0].description, '**Skates**\nFitting.');
  assert.match(result.stdout, /ACM-0001 .* 2 lines {2}\$695\.00/);
});

test('import writes nothing and uses no number when any file is invalid', async () => {
  const { dir, store, client, good, bad } = await fixture();
  const result = run(dir, good, bad, '--client', client.id);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bad\.csv: Row 2: "lots" is not a quantity/);
  assert.deepEqual(await store.listInvoices(), []);
  assert.equal((await store.listVendors())[0].nextNumber, 1);
});

test('import --dry-run writes nothing', async () => {
  const { dir, store, client, good } = await fixture();
  const result = run(dir, good, '--client', client.id, '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\$695\.00/);
  assert.deepEqual(await store.listInvoices(), []);
  assert.equal((await store.listVendors())[0].nextNumber, 1);
});

test('import refuses to guess the client or accept unknown terms', async () => {
  const { dir, client, good } = await fixture();
  assert.match(run(dir, good).stderr, /--client is required/);
  assert.match(run(dir, good, '--client', 'road-runner').stderr, /No client with id "road-runner"/);
  assert.match(run(dir, good, '--client', client.id, '--terms', 'net90').stderr, /Unknown terms "net90"/);
});
