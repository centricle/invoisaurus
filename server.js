import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { PORT, ROOT_DIR, DATA_DIR, DEMO_MODE } from './src/config.js';
import { ensureDataDir } from './src/store.js';
import {
  formatUSD, formatQuantity, formatCents, quantityInputValue, centsInputValue,
} from './src/money.js';
import {
  clientLabel, addressLines, termById, dueDateFor, isOverdue, daysOverdue,
  formatInvoiceNumber,
} from './src/schema.js';
import { field, statusBadgeClass } from './src/viewHelpers.js';
import { ejsEngine } from './src/viewEngine.js';
import { takeFlash } from './src/flash.js';
import { demoSession, installDemoBackend, resetSession } from './src/demo.js';
import { clientsRouter } from './src/routes/clients.js';
import { vendorsRouter } from './src/routes/vendors.js';
import { invoicesRouter } from './src/routes/invoices.js';

// In demo mode every visitor gets their own in-memory store, created when
// they arrive, so there is no directory to make -- and the serverless
// filesystem this runs on is read-only anyway.
installDemoBackend();
if (!DEMO_MODE) ensureDataDir();

// The data dir is rendered in the page footer, so show it home-relative rather
// than as an absolute path that carries a username into every screenshot.
const displayDataDir = DATA_DIR.startsWith(os.homedir())
  ? DATA_DIR.replace(os.homedir(), '~')
  : DATA_DIR;

export const app = express();
app.engine('ejs', ejsEngine);
app.set('view engine', 'ejs');
app.set('views', path.join(ROOT_DIR, 'src/views'));
// 100kb of form data is roughly 300 line items. The default is the same
// number; stating it makes it a decision rather than a default, now that the
// form is reachable by anyone.
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.static(path.join(ROOT_DIR, 'public')));

// After static, before anything that reads or writes records: binds this
// request to the visitor's own store. A no-op outside demo mode. Sitting
// below express.static keeps CSS and JS from minting a session apiece.
app.use(demoSession);

// Helpers every view needs. Kept in one place so no template reimplements money
// or invoice-number formatting and quietly disagrees with the PDF.
Object.assign(app.locals, {
  formatUSD, formatQuantity, formatCents, quantityInputValue, centsInputValue,
  clientLabel, addressLines, termById, dueDateFor, formatInvoiceNumber,
  isOverdue, daysOverdue, field, statusBadgeClass, dataDir: displayDataDir,
});

// A confirmation belongs to one moment, so it is read and cleared here rather
// than left in the URL where a refresh or a bookmark would show it again.
// See src/flash.js. `currentPath` rides along because nav highlighting is the
// same kind of thing: per-request state a template needs and cannot derive.
app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.flash = takeFlash(req, res);
  next();
});

app.get('/', (req, res) => res.redirect('/invoices'));

// Demo only: throw this visitor's records away and start over. A POST because
// it destroys data, so a crawler or a prefetch cannot trigger it.
app.post('/demo/reset', (req, res) => {
  if (!DEMO_MODE) return res.status(404).render('404', { what: 'Page' });
  resetSession(req, res);
  return res.redirect('/invoices');
});

app.use('/invoices', invoicesRouter);
app.use('/clients', clientsRouter);
app.use('/vendors', vendorsRouter);

app.use((req, res) => res.status(404).render('404', { what: 'Page' }));

// Rendering 404.ejs here produced "Something broke: <error> not found.", since
// that template appends "not found" to whatever it is handed. The error also
// carried an absolute path straight onto the page. Both are why this has a
// template of its own.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('500');
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
