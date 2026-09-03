import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { PORT, ROOT_DIR, DATA_DIR } from './src/config.js';
import { ensureDataDir, listInvoices, listVendors, listClients } from './src/store.js';
import { formatUSD, formatQuantity } from './src/money.js';
import { invoiceTotals, clientLabel, addressLines, termById } from './src/schema.js';

ensureDataDir();

// The data dir is rendered in the page footer, so show it home-relative rather
// than as an absolute path that carries a username into every screenshot.
const displayDataDir = DATA_DIR.startsWith(os.homedir())
  ? DATA_DIR.replace(os.homedir(), '~')
  : DATA_DIR;

export const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(ROOT_DIR, 'src/views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT_DIR, 'public')));

// Formatters every view needs. Kept in one place so no template reimplements
// money formatting and quietly disagrees with the PDF.
app.locals.formatUSD = formatUSD;
app.locals.formatQuantity = formatQuantity;
app.locals.clientLabel = clientLabel;
app.locals.addressLines = addressLines;
app.locals.termById = termById;

app.get('/', (req, res) => {
  const clients = listClients();
  const vendors = listVendors();
  const invoices = listInvoices().map((inv) => ({
    ...inv,
    totalCents: invoiceTotals(inv).totalCents,
    client: clients.find((c) => c.id === inv.clientId) || null,
  }));
  res.render('invoices/index', { invoices, clients, vendors, dataDir: displayDataDir });
});

// Bind a port only when this file is the entry point. Importing it -- which the
// route tests do, against a temporary data directory -- builds the app without
// taking a port.
//
// Loopback only. This is a single-user local tool with no login, so binding
// every interface would put an unauthenticated read/write invoice editor on
// whatever network the machine is currently joined to.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Invoisaurus  http://localhost:${PORT}`);
    console.log(`data      ${displayDataDir}`);
  });
}
