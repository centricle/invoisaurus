/**
 * Where records physically live.
 *
 * `store.js` holds every rule about invoice records -- numbers are never
 * reused, a create refuses to overwrite, an update cannot invent an id, a
 * damaged file is named rather than swallowed. Those rules are the product.
 * This module is the much smaller question of which bytes they act on, split
 * out so the hosted demo can answer it differently without a second copy of
 * any of them.
 *
 * The alternative was a demo branch inside each route. That would mean
 * reimplementing the invariants above for the demo, and a demo that
 * reimplements the product is a demo that eventually contradicts it.
 *
 * Six primitives, keyed by the same absolute path strings either way, so
 * `store.js` reads identically in both modes.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The real filesystem. This is the code that used to live in store.js. */
export const fsBackend = {
  readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      // A malformed file is a data-loss event, not a missing-value event. Fail
      // loudly rather than silently returning [] and letting a save overwrite it.
      throw new Error(`Corrupt data file ${file}: ${err.message}`);
    }
  },

  // Temp file plus rename, which is atomic on a single filesystem. A crash
  // mid-write leaves the previous version intact rather than a truncated invoice.
  writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  },

  exists: (file) => fs.existsSync(file),
  listDir: (dir) => fs.readdirSync(dir),
  remove: (file) => fs.rmSync(file, { force: true }),
  ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
};

/**
 * Which backend the current request is using.
 *
 * A hook rather than an import, so this module never has to know that demo
 * mode exists. `demo.js` installs a resolver that returns the calling
 * visitor's own store; with nothing installed, everything goes to disk exactly
 * as before.
 */
let resolve = () => fsBackend;

export function useBackendResolver(fn) {
  resolve = fn;
}

export const readJson = (file, fallback) => resolve().readJson(file, fallback);
export const writeJson = (file, value) => resolve().writeJson(file, value);
export const exists = (file) => resolve().exists(file);
export const listDir = (dir) => resolve().listDir(dir);
export const remove = (file) => resolve().remove(file);
export const ensureDir = (dir) => resolve().ensureDir(dir);
