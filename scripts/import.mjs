/**
 * Create draft invoices from CSV files of line items, one invoice per file.
 *
 *   npm run import -- hours-august.csv --client wile-e-coyote
 *   npm run import -- a.csv b.csv --client wile-e-coyote --vendor acme-corporation \
 *     --date 2026-09-14 --terms net30 --notes "Services rendered in August." --dry-run
 *
 * The CSV shape is documented in src/import.js and the README.
 *
 * Every file is read and every invoice validated before the first number is
 * allocated. `createInvoice` moves the vendor's counter as it writes and has no
 * rollback, so validating as it went would leave the first file's invoice on
 * disk and a burned number behind a typo in the second. Numbers are allocated
 * in the order the files are named.
 *
 * Invoices are always created as drafts. A draft's Bill To and Remit From
 * still follow the client and vendor records, so anything wrong on them can be
 * fixed before the invoice is marked sent.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { createJsonStore } from '../src/store.js';
import { lineItemsFromCsv } from '../src/import.js';
import {
  makeInvoice, withSnapshots, validateInvoice, invoiceTotals, clientLabel, today, TERMS,
} from '../src/schema.js';
import { formatUSD } from '../src/money.js';
import { DATA_DIR } from '../src/config.js';

const USAGE = `Usage: npm run import -- <file.csv>... --client <id> [options]

  --client <id>      Client to bill (required)
  --vendor <id>      Issuing vendor (required when there is more than one)
  --date YYYY-MM-DD  Issue date (default: today)
  --terms <id>       ${TERMS.map((t) => t.id).join(', ')} (default: net30)
  --notes <text>     Notes printed on every invoice created
  --dry-run          Validate and print, write nothing`;

const fail = (lines) => {
  for (const line of [].concat(lines)) console.error(line);
  process.exit(1);
};

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      client: { type: 'string' },
      vendor: { type: 'string' },
      date: { type: 'string' },
      terms: { type: 'string', default: 'net30' },
      notes: { type: 'string', default: '' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (err) {
  fail([err.message, '', USAGE]);
}

const { values: opts, positionals: files } = parsed;
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!files.length) fail(['Name at least one CSV file.', '', USAGE]);

const store = createJsonStore({ dataDir: DATA_DIR });
const vendors = await store.listVendors();
const clients = await store.listClients();
const ids = (records) => records.map((r) => r.id).join(', ') || '(none)';

// The client is never guessed. Defaulting it is how one client's invoice goes
// to another, which is why the editor makes it the first thing picked too.
if (!opts.client) fail(['--client is required. Clients: ' + ids(clients)]);
const client = clients.find((c) => c.id === opts.client);
if (!client) fail([`No client with id "${opts.client}". Clients: ${ids(clients)}`]);

let vendor;
if (opts.vendor) {
  vendor = vendors.find((v) => v.id === opts.vendor);
  if (!vendor) fail([`No vendor with id "${opts.vendor}". Vendors: ${ids(vendors)}`]);
} else if (vendors.length === 1) {
  [vendor] = vendors;
} else {
  fail([`--vendor is required when there is not exactly one vendor. Vendors: ${ids(vendors)}`]);
}

// Checked here because the schema would not catch it: an unknown terms id
// falls back to Due on Receipt, which is a due date nobody asked for.
if (!TERMS.some((t) => t.id === opts.terms)) {
  fail([`Unknown terms "${opts.terms}". Terms: ${TERMS.map((t) => t.id).join(', ')}`]);
}

const drafts = [];
const errors = [];
for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    errors.push(`${file}: ${err.message}`);
    continue;
  }
  const { lineItems, errors: csvErrors } = lineItemsFromCsv(text);
  if (csvErrors.length) {
    errors.push(...csvErrors.map((e) => `${file}: ${e}`));
    continue;
  }
  const input = makeInvoice({
    vendorId: vendor.id,
    clientId: client.id,
    issueDate: opts.date || today(),
    terms: opts.terms,
    status: 'draft',
    style: vendor.defaultStyle,
    notes: opts.notes,
    lineItems,
  });
  const invalid = validateInvoice(input, { vendor, client });
  if (invalid.length) errors.push(...invalid.map((e) => `${file}: ${e}`));
  else drafts.push({ file, input });
}

if (errors.length) fail(['Nothing was imported and no invoice numbers were used:', ...errors.map((e) => `  - ${e}`)]);

const row = (id, invoice, suffix = '') => {
  const lines = invoice.lineItems.length;
  const total = formatUSD(invoiceTotals(invoice).totalCents);
  return `${id.padEnd(12)} ${clientLabel(client)}  ${lines} line${lines === 1 ? '' : 's'}  ${total}  `
    + `issued ${invoice.issueDate}, due ${invoice.dueDate}${suffix}`;
};

if (opts['dry-run']) {
  for (const { file, input } of drafts) console.log(row('(dry run)', input, `  <- ${file}`));
  console.log('\nNothing written.');
  process.exit(0);
}

await store.ensureDataDir();
for (const { file, input } of drafts) {
  const invoice = await store.createInvoice(withSnapshots(input, { vendor, client, force: true }));
  console.log(row(invoice.id, invoice, `  <- ${file}`));
}
console.log(`\nCreated ${drafts.length} draft invoice(s) in ${DATA_DIR}`);
