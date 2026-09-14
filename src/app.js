/**
 * The application, as a function of how it is being run.
 *
 * Everything an entry point used to decide by reading the environment is an
 * argument here: where the app is mounted, which store a request gets, what
 * runs before the routers, and what the chrome says. `server.js` builds the
 * local tool and the hosted demo from it; a host that adds accounts, tenants
 * and billing builds its own app from the same function and never edits a
 * route. That is the whole reason this is a factory and not a module that
 * configures itself on import.
 *
 * Nothing here reads `process.env`. The one thing that does is `config.js`,
 * and only `server.js` reads that. (src/paths.js reads one variable, to find
 * this package's own files inside a bundle; that is about where the code is,
 * not how it is run.)
 */
import express from 'express';
import { VIEWS_DIR, PUBLIC_DIR } from './paths.js';
import {
  formatUSD, formatQuantity, formatCents, quantityInputValue, centsInputValue,
} from './money.js';
import {
  clientLabel, addressLines, termById, dueDateFor, isOverdue, daysOverdue,
  formatInvoiceNumber,
} from './schema.js';
import { field, statusBadgeClass } from './viewHelpers.js';
import { ejsEngine } from './viewEngine.js';
import { takeFlash } from './flash.js';
import { createCsrf } from './csrf.js';
import { clientsRouter } from './routes/clients.js';
import { vendorsRouter } from './routes/vendors.js';
import { invoicesRouter } from './routes/invoices.js';

/**
 * @param {object} options
 * @param {string} [options.basePath] A path prefix the whole app is served
 *   under, e.g. `/etc/invoisaurus`. Empty means the root. A trailing slash is
 *   normalized away: `/etc/invoisaurus/` + `/invoices` would be `//invoices`,
 *   a protocol-relative URL to the host "invoices".
 * @param {object|Function|null} [options.store] The store a request gets when
 *   nothing earlier in the chain attached one: an instance, or `(req, res) =>
 *   store`. Null when `middleware` always supplies it.
 * @param {Function[]} [options.middleware] Run after static files and before
 *   anything that reads or writes records. This is where a request gets its
 *   store (`req.store`), and where the chrome slots on `res.locals` -- `banner`,
 *   `badge`, `navRight`, `footer`, `watermark` -- are filled per request.
 * @param {object} [options.locals] Extra `app.locals`: defaults for the chrome
 *   slots, or anything a host's templates need.
 * @param {string[]} [options.allowOrigins] Origins, besides this app's own,
 *   that a browser may post from: the site a proxy serves this app under. See
 *   src/csrf.js for why that is needed and what else is checked.
 * @param {boolean} [options.home] Whether `GET /` redirects to the invoice
 *   list. A host with a landing page owns `/` itself and passes false.
 * @param {Function} [options.mount] `(app, { u }) => void`, called after the
 *   routers and before the 404 handler. Anything a caller wants to serve from
 *   this app that is not an invoice, client or vendor route goes in here,
 *   because a route added after the factory returns would sit behind the
 *   catch-all and never be reached.
 */
export function createApp({
  basePath = '',
  store = null,
  middleware = [],
  locals = {},
  allowOrigins = [],
  home = true,
  mount = null,
} = {}) {
  const base = String(basePath || '').replace(/\/+$/, '');
  /** Prefix an app-absolute path. The one place a URL is built. */
  const u = (p = '/') => `${base}${p}`;

  const app = express();
  app.engine('ejs', ejsEngine);
  app.set('view engine', 'ejs');
  app.set('views', VIEWS_DIR);
  // 100kb of form data is roughly 300 line items. The default is the same
  // number; stating it makes it a decision rather than a default, now that the
  // form is reachable by anyone.
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use(base || '/', express.static(PUBLIC_DIR));

  // Helpers every view needs. Kept in one place so no template reimplements money
  // or invoice-number formatting and quietly disagrees with the PDF.
  Object.assign(app.locals, {
    formatUSD, formatQuantity, formatCents, quantityInputValue, centsInputValue,
    clientLabel, addressLines, termById, dueDateFor, formatInvoiceNumber,
    isOverdue, daysOverdue, field, statusBadgeClass,
    // Every link and form action in a template goes through this. A bare
    // href="/invoices" is correct locally and off-site under the demo's prefix.
    u,
    basePath: base,
    // Cookies are scoped to where the app is mounted. Set at '/' while the app
    // lives under a prefix, the browser would return them to the parent site
    // too, and clearCookie at a different path silently fails to clear anything.
    cookiePath: base || '/',
    ...locals,
  });

  // After static, before anything that reads or writes records. Sitting below
  // express.static keeps CSS and JS from minting a guest session apiece.
  for (const fn of middleware) app.use(fn);

  // Every request carries the store its handlers read from. Whatever the
  // middleware above attached wins; otherwise the default. A request with no
  // store at all is a configuration error, and saying so beats a TypeError
  // three handlers down.
  app.use((req, res, next) => {
    req.store ??= typeof store === 'function' ? store(req, res) : store;
    if (!req.store) {
      return next(new Error('No store for this request. Pass `store` to createApp, or attach req.store in middleware.'));
    }
    return next();
  });

  // Every request that changes something has to prove it came from a page this
  // app served. After the store, so a misconfigured app fails on that first;
  // before the routers, so no handler can forget. See src/csrf.js.
  app.use(createCsrf({ cookiePath: base || '/', allowOrigins }).middleware);

  // A confirmation belongs to one moment, so it is read and cleared here rather
  // than left in the URL where a refresh or a bookmark would show it again.
  // See src/flash.js. `currentPath` rides along because nav highlighting is the
  // same kind of thing: per-request state a template needs and cannot derive.
  app.use((req, res, next) => {
    // The prefix is mounting detail, not part of the page's identity: the nav
    // highlights on the first segment, which would otherwise read "etc".
    res.locals.currentPath = base && req.path.startsWith(base)
      ? req.path.slice(base.length) || '/'
      : req.path;
    res.locals.flash = takeFlash(req, res);

    // Redirects are prefixed here rather than at each of the eight call sites.
    // A handler saying `res.redirect('/invoices')` means the invoice list, and
    // it should not have to know where the app happens to be mounted -- one
    // missed call site would send a visitor to the parent site's 404.
    const redirect = res.redirect.bind(res);
    res.redirect = (...args) => {
      const url = args.pop();
      return redirect(...args, typeof url === 'string' && url.startsWith('/') ? u(url) : url);
    };

    next();
  });

  if (home) app.get(u('/'), (req, res) => res.redirect('/invoices'));

  // Mounted under a prefix, the bare origin belongs to nobody: this app never
  // registered it, so it would 404. Anyone landing there typed the host or
  // followed an old link, so send them to the front door. Registered only when
  // there is a prefix, because without one this route is the line above.
  // `'/'`, not `u('/')`: res.redirect is wrapped above to prefix app-relative
  // paths, so prefixing here too produces /etc/invoisaurus/etc/invoisaurus/.
  if (base) app.get('/', (req, res) => res.redirect('/'));

  app.use(u('/invoices'), invoicesRouter);
  app.use(u('/clients'), clientsRouter);
  app.use(u('/vendors'), vendorsRouter);

  if (mount) mount(app, { u });

  app.use((req, res) => res.status(404).render('404', { what: 'Page' }));

  // Rendering 404.ejs here produced "Something broke: <error> not found.", since
  // that template appends "not found" to whatever it is handed. The error also
  // carried an absolute path straight onto the page. Both are why this has a
  // template of its own.
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('500');
  });

  return app;
}
