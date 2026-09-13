/**
 * The entry point for the local tool and the hosted demo.
 *
 * Reads the environment (through src/config.js), decides which of the two it
 * is, and builds the app from `createApp`. Nothing below is a route; the
 * routes live in src/app.js and do not know how they were configured.
 */
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { PORT, DATA_DIR, DEMO_MODE, BASE_PATH } from './src/config.js';
import { createApp } from './src/app.js';
import { createJsonStore } from './src/store.js';
import { createGuestSessions } from './src/demo.js';
import { seedDemoStore } from './src/seed.js';

// The data dir is rendered in the page footer, so show it home-relative rather
// than as an absolute path that carries a username into every screenshot.
const displayDataDir = DATA_DIR.startsWith(os.homedir())
  ? DATA_DIR.replace(os.homedir(), '~')
  : DATA_DIR;

// The one store a local install has, over the one data directory. In demo mode
// every visitor gets their own in-memory store, created when they arrive, so
// there is no directory to make -- and the serverless filesystem this runs on
// is read-only anyway.
//
// ensureDataDir is synchronous underneath and has finished by the time its
// promise exists; the only thing left to handle is a rejection, which means
// the directory cannot be created and there is nothing to serve. Not awaited
// at top level, because Netlify's bundler emits CommonJS for the function and
// rejects top-level await outright (see netlify/demo-env.js).
const store = DEMO_MODE ? null : createJsonStore({ dataDir: DATA_DIR });
if (store) {
  store.ensureDataDir().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

/** Demo only. Exported for the tests, which count visitors. */
export const guest = DEMO_MODE
  ? createGuestSessions({ cookiePath: BASE_PATH || '/', seed: seedDemoStore })
  : null;

export const app = createApp({
  basePath: BASE_PATH,
  store,
  middleware: guest ? [guest.middleware] : [],
  locals: {
    footer: store ? { text: displayDataDir, mono: true } : null,
  },
  mount(app, { u }) {
    // Demo only: throw this visitor's records away and start over. A POST
    // because it destroys data, so a crawler or a prefetch cannot trigger it.
    if (guest) {
      app.post(u('/demo/reset'), (req, res) => {
        guest.reset(req, res);
        res.redirect('/invoices');
      });
    }
  },
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
