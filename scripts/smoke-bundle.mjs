/**
 * Invoke the built function bundle the way Lambda would, and read a PDF back.
 *
 * check-bundle.mjs proves the archive holds the right files. This proves the
 * code inside it runs: the bundle is unzipped, its handler is called with a
 * bare API Gateway event, and the invoice list and three PDFs are requested
 * through it. Nothing else can catch what this catches. The suite runs the
 * source, the bundler rewrites the source into CommonJS, and 2.0.0 shipped a
 * demo whose every PDF was a 500 with 211 tests green -- a default export
 * resolved as a module namespace once transpiled, and nowhere else.
 *
 *   npx netlify build && npm run check:bundle && npm run smoke:bundle
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZIP = path.join(ROOT, '.netlify/functions/app.zip');

if (!fs.existsSync(ZIP)) {
  console.error(`No bundle at ${path.relative(ROOT, ZIP)}. Run \`npx netlify build\` first.`);
  process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoisaurus-bundle-'));
execFileSync('unzip', ['-q', ZIP, '-d', dir]);

// What the demo function reads at startup; see netlify/demo-env.js.
process.env.LAMBDA_TASK_ROOT = dir;

const event = (p, headers = {}) => ({
  httpMethod: 'GET', path: p, headers, queryStringParameters: null,
  body: null, isBase64Encoded: false, multiValueHeaders: {},
});

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed += 1;
};

try {
  const { handler } = createRequire(import.meta.url)(path.join(dir, 'app.js'));

  const list = await handler(event('/invoices'), {});
  check(list.statusCode === 200, `GET /invoices -> ${list.statusCode}`);
  check(/ACM-0001/.test(list.body), 'the list names a seeded invoice');

  const setCookie = list.multiValueHeaders?.['set-cookie'] || [list.headers?.['set-cookie']].filter(Boolean);
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');

  for (const id of ['ACM-0001', 'ACM-0002', 'ACM-0003']) {
    const res = await handler(event(`/invoices/${id}/pdf`, { cookie }), {});
    const bytes = Buffer.from(res.body || '', res.isBase64Encoded ? 'base64' : 'utf8');
    const isPdf = res.statusCode === 200
      && res.headers?.['content-type'] === 'application/pdf'
      && bytes.subarray(0, 5).toString() === '%PDF-'
      && bytes.length > 1000;
    check(isPdf, `GET /invoices/${id}/pdf -> ${res.statusCode} ${res.headers?.['content-type']} ${bytes.length} bytes`);
  }
} catch (err) {
  console.error(err);
  failed += 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} check(s) failed. The bundle does not do what the source does.`);
  process.exit(1);
}
console.log('The bundle serves the app and its PDFs.');
