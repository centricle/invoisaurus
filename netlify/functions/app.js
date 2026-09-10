/**
 * The hosted demo, as a Netlify function.
 *
 * The Express app is built in server.js and exported without binding a port,
 * so the same application object serves both `node server.js` locally and
 * this handler. There is no second app and no serverless-specific routing.
 *
 * Prior art: an Express-on-Netlify function elsewhere, running this pattern
 * in production since March 2026.
 *
 * `.js`, not `.mjs`, and that is load-bearing. Netlify transpiles the entry to
 * CommonJS and rewrites the bundle's package.json to `"type": "commonjs"`, but
 * a `.mjs` extension makes Node treat the file as ESM no matter what the
 * package.json says -- so the transpiled `module.exports` throws
 * "module is not defined in ES module scope" on the first invocation. The
 * build is green either way; the site is a 502.
 */
// Must come first: it sets the environment src/config.js reads at import time.
import '../demo-env.js';
import serverless from 'serverless-http';
import { app } from '../../server.js';

/**
 * `binary` is load-bearing. Without it serverless-http falls back to the
 * BINARY_CONTENT_TYPES environment variable, which defaults to empty, so
 * `application/pdf` is not recognized and the body is handled as text. The
 * failure is a PDF that downloads and will not open -- no error, no log line,
 * nothing pointing back here.
 *
 * No `basePath`. The proxy in front of this preserves the full path, so the
 * function receives `/etc/invoisaurus/...` and the app is mounted there.
 */
export const handler = serverless(app, { binary: ['application/pdf'] });
