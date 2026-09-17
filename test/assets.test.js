import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import './tmpdir.js';
import { createApp } from '../src/app.js';
import { createJsonStore } from '../src/store.js';
import { createMemoryBackend } from '../src/storage-memory.js';

/**
 * `assets`: a host's static directories, mounted ahead of the engine's own
 * public/. Express static middleware answers with the first root that has the
 * requested file, so a host's file at the same path wins, and any path the
 * host does not have falls through to the engine. The case covered here is a
 * host that builds its own stylesheet from `invoisaurus/css` and serves it at
 * /css/dist/app.css.
 */
const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'invoisaurus-assets-'));
fs.mkdirSync(path.join(assets, 'css', 'dist'), { recursive: true });
fs.writeFileSync(path.join(assets, 'css', 'dist', 'app.css'), '/* host build */');
fs.writeFileSync(path.join(assets, 'host-only.txt'), 'host');

const store = createJsonStore({ backend: createMemoryBackend(), dataDir: '/assets-test' });
const app = createApp({ store, assets: [assets] });
let base;

before(async () => {
  await store.ensureDataDir();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  server.unref();
});

test('a host asset at the same path wins over the engine file', async () => {
  const res = await fetch(`${base}/css/dist/app.css`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '/* host build */');
});

test('the engine still serves what the host does not override', async () => {
  const js = await fetch(`${base}/js/theme.js`);
  assert.equal(js.status, 200);
  const host = await fetch(`${base}/host-only.txt`);
  assert.equal(await host.text(), 'host');
});
