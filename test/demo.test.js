import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Order matters: both bind environment that src/config.js reads at import
// time. See the header of each.
import './demomode.js';

const DATA_DIR = path.join(os.tmpdir(), `invoisaurus-demo-never-${process.pid}`);
process.env.INVOISAURUS_DATA_DIR = DATA_DIR;

const { app } = await import('../server.js');
const { sessionCount } = await import('../src/demo.js');

/** A visitor: keeps its own cookie jar, the way a browser would. */
function visitor(base) {
  let cookie = '';
  return async function go(url, opts = {}) {
    const res = await fetch(base + url, {
      ...opts,
      headers: { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) },
      redirect: 'manual',
    });
    const set = res.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    return res;
  };
}

const form = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body),
});

async function withServer(fn) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('a demo visitor arrives at a populated app', async () => {
  await withServer(async (base) => {
    const html = await (await visitor(base)('/invoices')).text();

    // Every status badge on screen at once is the reason DEMO_INVOICES has
    // five entries rather than one; see src/fixtures/acme.js.
    for (const status of ['draft', 'sent', 'paid', 'void']) {
      assert.match(html, new RegExp(`>\\s*${status}\\s*<`, 'i'), `no ${status} invoice on the list`);
    }
    // Relative issue dates, so this keeps holding as the demo ages.
    assert.match(html, /\d+d late/, 'nothing is overdue');
    assert.match(html, /1 overdue/);
  });
});

test('two visitors cannot see each other\'s records', async () => {
  await withServer(async (base) => {
    const a = visitor(base);
    const b = visitor(base);

    await a('/invoices'); // establishes a session
    await b('/invoices');

    const created = await a('/clients', form({
      name: 'Marvin the Martian', type: 'individual',
      street: '1 Illudium Way', city: 'Mars', state: 'NM', zip: '87500',
    }));
    assert.equal(created.status, 302);

    assert.match(await (await a('/clients')).text(), /Marvin the Martian/);
    assert.doesNotMatch(await (await b('/clients')).text(), /Marvin the Martian/);
  });
});

test('resetting throws the visitor\'s records away', async () => {
  await withServer(async (base) => {
    const a = visitor(base);
    await a('/invoices');
    await a('/clients', form({
      name: 'Marvin the Martian', type: 'individual',
      street: '1 Illudium Way', city: 'Mars', state: 'NM', zip: '87500',
    }));
    assert.match(await (await a('/clients')).text(), /Marvin the Martian/);

    assert.equal((await a('/demo/reset', { method: 'POST' })).status, 302);
    const after = await (await a('/clients')).text();
    assert.doesNotMatch(after, /Marvin the Martian/);
    assert.match(after, /Wile E. Coyote/, 'and is reseeded rather than left empty');
  });
});

test('a cookie naming a session that is gone reseeds and says so', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/invoices`, {
      headers: { cookie: 'demo_sid=00000000-0000-0000-0000-000000000000' },
      redirect: 'manual',
    });
    // Containers recycle; the visitor should get a working app, not an error.
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Wile E. Coyote/);
  });
});

test('the PDF is generated from the visitor\'s own records', async () => {
  await withServer(async (base) => {
    const a = visitor(base);
    await a('/invoices');
    const res = await a('/invoices/ACM-0001/pdf');

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    assert.ok(bytes.length > 1000, 'a real document, not an error page');
  });
});

test('demo mode writes nothing to disk, at all', async () => {
  await withServer(async (base) => {
    const a = visitor(base);
    await a('/invoices');
    await a('/clients', form({
      name: 'Marvin the Martian', type: 'individual',
      street: '1 Illudium Way', city: 'Mars', state: 'NM', zip: '87500',
    }));
    await a('/invoices', form({
      clientId: 'wile-e-coyote', issueDate: '2026-09-09', terms: 'net30',
      description: ['Anvil'], quantity: ['2'], rate: ['85.00'],
    }));
    await a('/invoices/ACM-0001/delete', { method: 'POST' });

    // The requirement, asserted directly. INVOISAURUS_DATA_DIR points at a
    // path nothing has created, and after a full round of creates, saves and
    // deletes it still does not exist.
    assert.equal(fs.existsSync(DATA_DIR), false, `demo mode created ${DATA_DIR}`);
    assert.ok(sessionCount() > 0, 'and yet the records are held in memory');
  });
});
