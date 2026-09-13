import { test } from 'node:test';
import fs from 'node:fs';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import { DATA_DIR } from './tmpdir.js';
import { createJsonStore } from '../src/store.js';
import { createMemoryBackend } from '../src/storage-memory.js';
import { assertStoreContract } from './store-contract.js';

/**
 * Both stores this repository ships, held to the recorded answer key. A third
 * implementation, elsewhere, imports `assertStoreContract` and does the same;
 * this file is also the example of how.
 */
const redact = (s) => s.replaceAll(DATA_DIR, '<DATA_DIR>');

test('the filesystem store answers the contract', async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  await assertStoreContract(() => createJsonStore({ dataDir: DATA_DIR }), { redact });
});

test('the memory store answers the contract', async () => {
  await assertStoreContract(
    () => createJsonStore({ backend: createMemoryBackend(), dataDir: DATA_DIR }),
    { redact },
  );
});
