import { test } from 'node:test';
import assert from 'node:assert/strict';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import { DATA_DIR } from './tmpdir.js';
import fs from 'node:fs';
import { fsBackend } from '../src/storage.js';
import { createMemoryBackend } from '../src/storage-memory.js';
import { createJsonStore } from '../src/store.js';
import { storeContractScript } from './store-contract.js';

/**
 * The demo runs the real store against a different backend. That is only safe
 * if the two are indistinguishable to store.js, so the contract script is run
 * against both and the same answers are required. The script itself lives in
 * test/store-contract.js, because a third store implements it too.
 */
const redact = (s) => s.replaceAll(DATA_DIR, '<DATA_DIR>');

test('the memory backend is indistinguishable from the filesystem', async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const onDisk = await storeContractScript(createJsonStore({ dataDir: DATA_DIR }), { redact });

  const memory = createMemoryBackend();
  const inMemory = await storeContractScript(
    createJsonStore({ backend: memory, dataDir: DATA_DIR }), { redact },
  );

  assert.deepEqual(inMemory, onDisk);
  assert.ok(onDisk.length > 30, 'the script should actually exercise something');
});

test('the demo backend writes nothing to disk', async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const memory = createMemoryBackend();
  await storeContractScript(createJsonStore({ backend: memory, dataDir: DATA_DIR }));

  // The requirement, tested directly rather than inferred: after a full script
  // of creates, updates, saves and deletes, the data directory does not exist.
  assert.equal(fs.existsSync(DATA_DIR), false);
  assert.ok(memory.size() > 0, 'and yet the records are there in memory');
});

test('both backends return copies, not references', () => {
  // Not reachable through store.js today -- see the note in storage-memory.js.
  // Asserted at the backend level because that is where the two could diverge,
  // and because the first read-modify-without-write caller should find this
  // already guaranteed rather than discover it.
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const file = `${DATA_DIR}/vendors.json`;

  for (const [name, backend] of [['fs', fsBackend], ['memory', createMemoryBackend()]]) {
    backend.ensureDir(DATA_DIR);
    backend.writeJson(file, [{ id: 'acme', nextNumber: 7 }]);

    const read = backend.readJson(file, []);
    read[0].nextNumber = 999;

    assert.equal(backend.readJson(file, [])[0].nextNumber, 7,
      `${name} backend leaked a mutation that was never written`);
    assert.notEqual(backend.readJson(file, []), backend.readJson(file, []),
      `${name} backend handed out the same object twice`);
  }

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('a memory backend survives a round trip through plain data', async () => {
  // dump() is how a visitor's records leave the container they were made in.
  const memory = createMemoryBackend();
  await storeContractScript(createJsonStore({ backend: memory, dataDir: DATA_DIR }));

  const copy = createMemoryBackend();
  copy.load(memory.dump());
  const original = createJsonStore({ backend: memory, dataDir: DATA_DIR });
  const restored = createJsonStore({ backend: copy, dataDir: DATA_DIR });

  assert.deepEqual(await restored.listInvoices(), await original.listInvoices());
  assert.deepEqual(await restored.listVendors(), await original.listVendors());
  assert.notEqual(memory.dump(), copy.dump(), 'the snapshot is a copy, not the map');
});
