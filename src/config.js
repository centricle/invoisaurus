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
 * default and the only safe default.
 */
export const DEMO_MODE = process.env.DEMO_MODE === 'true';

/**
 * A path prefix the whole app is served under, e.g. `/etc/invoisaurus`.
 *
 * The hosted demo lives at a subpath of another site, reached by a Netlify
 * proxy that preserves the path -- so this process really does receive
 * `/etc/invoisaurus/invoices`, and mounting there is simpler and less
 * surprising than stripping the prefix on the way in and re-adding it to every
 * link on the way out.
 *
 * Empty by default, which must remain byte-for-byte the behavior the local
 * tool has always had. Normalized rather than trusted: a trailing slash would
 * produce `//invoices`, which is a protocol-relative URL to the host
 * `invoices` -- an off-site link, from a typo in an env var.
 */
const rawBasePath = process.env.BASE_PATH || '';
export const BASE_PATH = rawBasePath.replace(/\/+$/, '');

/** Prefix an app-absolute path. The one place a URL is built. */
export const u = (p = '/') => `${BASE_PATH}${p}`;
