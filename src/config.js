import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The data directory is deliberately outside this repository's tracked tree.
 * It holds client names, addresses and billing history, none of which belong in
 * a repo that might be shared or published. The default `./data` is gitignored
 * here; where it actually lives and how it is backed up is up to whoever runs
 * the app.
 */
export const DATA_DIR = path.resolve(process.env.INVOISAURUS_DATA_DIR || path.join(ROOT, 'data'));

export const PORT = Number(process.env.PORT || 7054);
export const ROOT_DIR = ROOT;

/**
 * Demo mode: every visitor gets a private, in-memory set of records and
 * nothing is ever written to disk.
 *
 * Compared against the exact string rather than tested for truthiness, so a
 * stray `DEMO_MODE=false` or `DEMO_MODE=0` in an environment cannot switch a
 * real installation into a mode where its saves quietly go nowhere. Off is the
 * default and the only safe default. Matches `thehelm/lib/demo.js`.
 */
export const DEMO_MODE = process.env.DEMO_MODE === 'true';
