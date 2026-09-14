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
 * Six primitives, keyed by absolute path strings. A store is built over one
 * backend (`createJsonStore({ backend })`), so the choice is made once, where
 * the store is made, and never consulted again per call. The earlier design
 * resolved the backend on every primitive through a process-wide hook, because
 * the store was a module singleton and a request had no other way to reach it;
 * a store that is an object the request carries needs no hook.
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
