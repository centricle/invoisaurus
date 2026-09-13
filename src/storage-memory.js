/**
 * A storage backend that never touches a disk, for the hosted demo.
 *
 * One of these per visitor. It implements the same six primitives as the
 * filesystem backend, keyed by the same absolute path strings, so `store.js`
 * cannot tell the difference and every invariant it enforces still holds.
 *
 * **Records are held as JSON text, not as objects.** A read has to return a
 * copy, because the filesystem cannot do anything else: handing back a live
 * reference would make a caller's mutation visible in the store before -- or
 * without -- a write.
 *
 * No current caller does that. `allocateInvoiceNumber` reads, increments and
 * writes with nothing in between, so today the two behave the same either way,
 * and the parity test below cannot tell them apart. The round trip is here for
 * the next caller: read-modify-maybe-write is an ordinary shape, and the day
 * one appears, object references would give the demo different semantics from
 * the product silently. `returns copies, not references` in
 * test/storage-parity.test.js is what actually holds the line.
 */
import path from 'node:path';

export function createMemoryBackend() {
  /** @type {Map<string, string>} absolute path -> JSON text */
  const files = new Map();

  const under = (dir) => {
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    return [...files.keys()].filter((f) => f.startsWith(prefix));
  };

  return {
    readJson(file, fallback) {
      if (!files.has(file)) return fallback;
      try {
        return JSON.parse(files.get(file));
      } catch (err) {
        // Unreachable through writeJson, which only ever stores its own
        // JSON.stringify output. Kept so the two backends fail the same way if
        // a fixture is ever seeded by hand with something malformed.
        throw new Error(`Corrupt data file ${file}: ${err.message}`);
      }
    },

    // Atomicity is free here: a Map.set either happened or it did not, and
    // nothing can observe a half-written value from another request.
    writeJson(file, value) {
      files.set(file, `${JSON.stringify(value, null, 2)}\n`);
    },

    // A path is a file if something is stored at it, and a directory if
    // anything is stored beneath it. Directories are implied by keys rather
    // than tracked, which is why ensureDir has nothing to do.
    exists: (file) => files.has(file) || under(file).length > 0,

    listDir: (dir) => under(dir).map((f) => path.relative(dir, f)).filter((f) => !f.includes(path.sep)),

    remove: (file) => { files.delete(file); },

    ensureDir: () => {},

    /** Demo-only: how much this visitor has accumulated, for the session cap. */
    size: () => files.size,

    /**
     * Everything held, as `{ path: text }`, and its inverse.
     *
     * A visitor's records exist in exactly one Lambda container's memory. To
     * survive a trip anywhere else -- a signup that lands on another
     * container minutes later, a fixture snapshot, a test that wants to look
     * -- they have to leave as plain data. Text rather than parsed objects,
     * for the same copy-not-reference reason as above.
     */
    dump: () => Object.fromEntries(files),
    load(snapshot) {
      for (const [file, text] of Object.entries(snapshot)) files.set(file, text);
    },
  };
}
