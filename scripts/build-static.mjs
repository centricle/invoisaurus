/**
 * Stage `public/` into the Netlify publish directory, under BASE_PATH.
 *
 * The app is served from a function, but its CSS, JS and favicon are ordinary
 * files and should come off the CDN rather than waking a Lambda apiece. A
 * Netlify catch-all rewrite yields to real files in the publish directory, so
 * anything staged here is served directly and everything else falls through to
 * the function.
 *
 * The prefix has to be baked into the directory layout because the CDN matches
 * on the request path: with BASE_PATH=/etc/invoisaurus the browser asks for
 * `/etc/invoisaurus/css/dist/app.css`, so that is where the file has to be.
 * Read from the environment rather than hardcoded, so the layout cannot
 * disagree with the paths the templates generate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');
const DIST = path.join(ROOT, 'dist');
const target = path.join(DIST, BASE_PATH);

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
// public/css/app.css is the Tailwind *input* -- @import plus the custom base
// rules -- and public/css/dist/app.css is what the browser asks for. Copying
// both publishes the source next to its own build output for no reason.
const INPUT_CSS = path.join(ROOT, 'public/css/app.css');
fs.cpSync(path.join(ROOT, 'public'), target, {
  recursive: true,
  filter: (src) => src !== INPUT_CSS,
});

// The stylesheet is gitignored build output, so its absence here means
// css:build did not run -- which deploys a site with no styling at all and
// no error anywhere. Cheaper to fail the build than to notice in the browser.
const css = path.join(target, 'css/dist/app.css');
if (!fs.existsSync(css)) {
  console.error(`Missing ${path.relative(ROOT, css)}. Run css:build first.`);
  process.exit(1);
}

const count = fs.readdirSync(target, { recursive: true }).length;
console.log(`Staged ${count} entries into dist${BASE_PATH || '/'}`);
