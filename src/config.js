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
