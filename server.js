import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { PORT, ROOT_DIR, DATA_DIR } from './src/config.js';
import { ensureDataDir } from './src/store.js';
import {
  formatUSD, formatQuantity, formatCents, quantityInputValue, centsInputValue,
} from './src/money.js';
import {
  clientLabel, addressLines, termById, dueDateFor, isOverdue, daysOverdue,
  formatInvoiceNumber,
} from './src/schema.js';
import { field } from './src/viewHelpers.js';
import { ejsEngine } from './src/viewEngine.js';
import { clientsRouter } from './src/routes/clients.js';
import { vendorsRouter } from './src/routes/vendors.js';
import { invoicesRouter } from './src/routes/invoices.js';

ensureDataDir();

// The data dir is rendered in the page footer, so show it home-relative rather
// than as an absolute path that carries a username into every screenshot.
const displayDataDir = DATA_DIR.startsWith(os.homedir())
  ? DATA_DIR.replace(os.homedir(), '~')
  : DATA_DIR;

export const app = express();
app.engine('ejs', ejsEngine);
app.set('view engine', 'ejs');
app.set('views', path.join(ROOT_DIR, 'src/views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT_DIR, 'public')));

// Helpers every view needs. Kept in one place so no template reimplements money
// or invoice-number formatting and quietly disagrees with the PDF.
Object.assign(app.locals, {
  formatUSD, formatQuantity, formatCents, quantityInputValue, centsInputValue,
  clientLabel, addressLines, termById, dueDateFor, formatInvoiceNumber,
  isOverdue, daysOverdue, field, dataDir: displayDataDir,
});

app.get('/', (req, res) => res.redirect('/invoices'));

app.use('/invoices', invoicesRouter);
app.use('/clients', clientsRouter);
app.use('/vendors', vendorsRouter);

app.use((req, res) => res.status(404).render('404', { what: 'Page' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('404', { what: `Something broke: ${err.message}` });
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
