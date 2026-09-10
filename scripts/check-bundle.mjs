/**
 * Refuse to ship a function bundle containing anything private.
 *
 * Netlify's tracer packages files the import graph never mentions. It reads
 * `path.join(ROOT, 'data')` out of src/config.js and includes the entire data
 * directory -- real invoices, client addresses, and the private git repo
 * inside it. That happened; this exists because it happened.
 *
 * The netlify.toml exclusion is the fix. This is the check that the fix is
 * still working, because the failure is completely silent: the build goes
 * green, the site works, and the records are simply sitting inside a
 * deployed artifact.
 *
 *   npx netlify build && npm run check:bundle
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, '.netlify/functions');

// Anything matching these has no business in a public artifact.
const FORBIDDEN = [
  { pattern: /^data\//, why: 'the invoice data directory' },
  { pattern: /(^|\/)\.git\//, why: 'a git repository' },
  { pattern: /(^|\/)\.env/, why: 'an environment file' },
  { pattern: /^tmp\//, why: 'scratch files' },
  { pattern: /(^|\/)(CLAUDE|STATUS|ROADMAP|BACKLOG|BRIEF)\.md$/, why: 'a private working document' },
];

if (!fs.existsSync(DIR)) {
  console.error(`No bundles at ${path.relative(ROOT, DIR)}. Run \`npx netlify build\` first.`);
  process.exit(1);
}

const zips = fs.readdirSync(DIR).filter((f) => f.endsWith('.zip'));
if (!zips.length) {
  console.error(`No .zip bundles in ${path.relative(ROOT, DIR)}.`);
  process.exit(1);
}

let bad = 0;
for (const zip of zips) {
  const listing = execFileSync('unzip', ['-Z1', path.join(DIR, zip)], { encoding: 'utf8' })
    .split('\n').filter(Boolean);

  for (const { pattern, why } of FORBIDDEN) {
    const hits = listing.filter((entry) => pattern.test(entry));
    if (hits.length) {
      bad += hits.length;
      console.error(`\n${zip} contains ${why} (${hits.length} entries):`);
      for (const hit of hits.slice(0, 5)) console.error(`  ${hit}`);
      if (hits.length > 5) console.error(`  ...and ${hits.length - 5} more`);
    }
  }
  console.log(`${zip}: ${listing.length} entries`);
}

if (bad) {
  console.error(`\nRefusing to ship. Exclude these in netlify.toml [functions] included_files.`);
  process.exit(1);
}
console.log('No private files in any bundle.');
