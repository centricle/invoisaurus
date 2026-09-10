/**
 * Run the app the way the hosted demo runs it.
 *
 *   npm run demo                     http://localhost:7055
 *   npm run demo -- --base=/etc/x    served under a path prefix
 *
 * Demo mode gives every browser session its own set of records, held in memory
 * and seeded with the ACME cast, and writes nothing to disk at all. That is
 * worth being able to see before deploying it, because it is the one mode the
 * normal `npm run dev` cannot show you.
 *
 * A Node script rather than inline environment variables in package.json, so
 * the same command works in PowerShell as in a POSIX shell -- and so the
 * reasons below have somewhere to live.
 *
 * It spawns server.js rather than importing it. server.js binds a port only
 * when it is the process entry point, which is what lets the tests import the
 * app without taking one; imported from here it would configure everything and
 * then listen to nothing, which is exactly the silent no-op it looked like the
 * first time.
 */
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

process.env.DEMO_MODE = 'true';

// A port of its own, so this can run alongside `npm run dev` rather than
// fighting it for 7054. Running both at once is the useful comparison.
process.env.PORT = arg('port', '7055');

// Demo mode never reads or writes the data directory -- the whole point -- but
// pointing it somewhere that does not exist makes that structural rather than
// something you have to take on trust. If a code path ever does reach the
// filesystem, it fails here instead of quietly touching your real invoices.
process.env.INVOISAURUS_DATA_DIR = path.join(os.tmpdir(), 'invoisaurus-demo-should-not-exist');

// Empty by default: the hosted deploy mounts under /etc/invoisaurus, but that
// prefix is a hosting detail and testing it locally should be opt-in.
process.env.BASE_PATH = arg('base', '');

const base = process.env.BASE_PATH;
console.log('Demo mode. Nothing is written to disk; each browser session gets its own records.');
console.log(`  http://localhost:${process.env.PORT}${base || ''}/invoices`);
if (base) console.log(`  Mounted under ${base}, so the bare root is a 404. That is correct.`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
