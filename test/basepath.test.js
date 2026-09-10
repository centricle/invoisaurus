import { test } from 'node:test';
import assert from 'node:assert/strict';
import './tmpdir.js';

/**
 * The app mounted under a prefix, as the hosted demo runs it.
 *
 * Set before importing anything under src/, because config.js resolves it once
 * at import time. `node --test` gives each file its own process, which is what
 * makes a module-scoped environment variable testable at all.
 */
const PREFIX = '/etc/invoisaurus';
process.env.BASE_PATH = `${PREFIX}/`; // trailing slash on purpose; see below

const { app } = await import('../server.js');
const { BASE_PATH } = await import('../src/config.js');

async function withServer(fn) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

const get = (base, url) => fetch(base + url, { redirect: 'manual' });

test('a trailing slash is normalized away', () => {
  // `/etc/invoisaurus/` + `/invoices` would be `//invoices`, which a browser
  // reads as a protocol-relative URL to the host "invoices" -- an off-site
  // link produced by a typo in an environment variable.
  assert.equal(BASE_PATH, PREFIX);
});

test('every route answers under the prefix and nowhere else', async () => {
  await withServer(async (base) => {
    for (const p of ['/invoices', '/clients', '/vendors']) {
      assert.equal((await get(base, PREFIX + p)).status, 200, `${PREFIX}${p} should serve`);
      assert.equal((await get(base, p)).status, 404, `${p} should not`);
    }
      const root = await get(base, `${PREFIX}/`);
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), `${PREFIX}/invoices`);

    // The bare origin is not this app's, but 404ing someone who typed the
    // host is unhelpful when there is an obvious place to send them.
    const bare = await get(base, '/');
    assert.equal(bare.status, 302);
    assert.equal(bare.headers.get('location'), `${PREFIX}/`);
  });
});

test('no page emits a link that escapes the prefix', async () => {
  await withServer(async (base) => {
    for (const p of ['/invoices', '/clients', '/vendors', '/invoices/new']) {
      const html = await (await get(base, PREFIX + p)).text();
      const escaped = [...html.matchAll(/(?:href|action|src)="(\/[^"]*)"/g)]
        .map((m) => m[1])
        .filter((href) => !href.startsWith(PREFIX));

      // A single missed link is a visitor sent to the parent site's 404, which
      // is why these go through one helper rather than being written by hand.
      assert.deepEqual(escaped, [], `${p} emitted unprefixed links`);
    }
  });
});

test('redirects out of handlers carry the prefix', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}${PREFIX}/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        name: 'Marvin the Martian', type: 'individual',
        street: '1 Illudium Way', city: 'Mars', state: 'NM', zip: '87500',
      }),
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `${PREFIX}/clients/marvin-the-martian/edit`);
  });
});

test('cookies are scoped to the mount, not the host', async () => {
  await withServer(async (base) => {
    // Set at '/', the parent site would receive this app's cookies, and
    // clearCookie at a mismatched path clears nothing at all.
    const res = await fetch(`${base}${PREFIX}/clients`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        name: 'Daffy Duck', type: 'individual',
        street: '2 Duck Pond', city: 'Tucumcari', state: 'NM', zip: '88401',
      }),
      redirect: 'manual',
    });
    const cookies = (res.headers.getSetCookie?.() || []).join('\n');
    assert.match(cookies, /flash=/);
    assert.match(cookies, new RegExp(`Path=${PREFIX}(;|$)`, 'm'));
  });
});

test('static assets and the PDF both serve under the prefix', async () => {
  await withServer(async (base) => {
    const css = await get(base, `${PREFIX}/favicon.svg`);
    assert.equal(css.status, 200);
    assert.equal((await get(base, '/favicon.svg')).status, 404);

    const list = await (await get(base, `${PREFIX}/invoices`)).text();
    const id = (list.match(/([A-Z]{3}-\d{4})/) || [])[1];
    if (id) {
      const pdf = await get(base, `${PREFIX}/invoices/${id}/pdf`);
      assert.equal(pdf.status, 200);
      assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    }
  });
});
