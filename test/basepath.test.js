import { test } from 'node:test';
import assert from 'node:assert/strict';
import './tmpdir.js';
// Demo mode, for its seeded records rather than for itself: the pages that
// matter most here are the edit forms, and an empty data directory has no
// record to open one for. That is what let three broken form actions through
// -- the only pages under test were the empty index screens.
import './demomode.js';

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

/** Load one page for its CSRF cookie, then post the way its form would. */
async function post(base, url, fields) {
  const page = await get(base, `${PREFIX}/invoices`);
  const set = page.headers.getSetCookie().find((c) => c.startsWith('csrf='));
  const token = set.split(';')[0].slice(5);
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `csrf=${token}` },
    body: new URLSearchParams({ ...fields, _csrf: token }),
    redirect: 'manual',
  });
  return { res, csrfCookie: set };
}

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

/**
 * Every page that renders a URL, not a hand-picked few.
 *
 * The original list was the four index pages, and it missed every form: three
 * `<form action>` attributes were built as `<%= isNew ? '/clients' : ... %>`,
 * which the prefixing pass skipped because the value starts with an EJS
 * expression rather than a slash. Saving anything 404'd in production, and the
 * endpoint tests all passed -- they POSTed to the right URL directly instead of
 * reading it off the form.
 *
 * `/invoices/new` is not enough on its own: with no `?clientId` it renders the
 * client picker, so the invoice editor was never on screen here at all.
 */
async function everyPage(base, get) {
  const list = await (await get(base, `${PREFIX}/invoices`)).text();
  const invoiceId = (list.match(/([A-Z]{3}-\d{4})/) || [])[1];

  const clients = await (await get(base, `${PREFIX}/clients`)).text();
  const clientId = (clients.match(/\/clients\/([a-z0-9-]+)\/edit/) || [])[1];

  const vendors = await (await get(base, `${PREFIX}/vendors`)).text();
  const vendorId = (vendors.match(/\/vendors\/([a-z0-9-]+)\/edit/) || [])[1];

  return [
    '/invoices', '/clients', '/vendors',
    '/invoices/new',                                    // the client picker
    clientId && `/invoices/new?clientId=${clientId}`,   // the invoice editor, new
    invoiceId && `/invoices/${invoiceId}`,              // the invoice editor, existing
    '/clients/new', clientId && `/clients/${clientId}/edit`,
    '/vendors/new', vendorId && `/vendors/${vendorId}/edit`,
    '/nope-404',
  ].filter(Boolean);
}

test('no page emits a link that escapes the prefix', async () => {
  await withServer(async (base) => {
    const pages = await everyPage(base, get);
    assert.ok(pages.length >= 10, `only ${pages.length} pages under test`);

    for (const p of pages) {
      const html = await (await get(base, PREFIX + p)).text();
      const escaped = [...html.matchAll(/(?:href|action|src)="(\/[^"]*)"/g)]
        .map((m) => m[1])
        .filter((href) => !href.startsWith(PREFIX));

      // A single missed link is a visitor sent to the parent site's 404 -- or,
      // for a form action, a save that silently goes nowhere.
      assert.deepEqual(escaped, [], `${p} emitted unprefixed links`);
    }
  });
});

test('redirects out of handlers carry the prefix', async () => {
  await withServer(async (base) => {
    const { res } = await post(base, `${PREFIX}/clients`, {
      name: 'Marvin the Martian', type: 'individual',
      street: '1 Illudium Way', city: 'Mars', state: 'NM', zip: '87500',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `${PREFIX}/clients/marvin-the-martian/edit`);
  });
});

test('cookies are scoped to the mount, not the host', async () => {
  await withServer(async (base) => {
    // Set at '/', the parent site would receive this app's cookies, and
    // clearCookie at a mismatched path clears nothing at all.
    const { res, csrfCookie } = await post(base, `${PREFIX}/clients`, {
      name: 'Daffy Duck', type: 'individual',
      street: '2 Duck Pond', city: 'Tucumcari', state: 'NM', zip: '88401',
    });
    const cookies = (res.headers.getSetCookie?.() || []).join('\n');
    assert.match(cookies, /flash=/);
    assert.match(cookies, new RegExp(`Path=${PREFIX}(;|$)`, 'm'));
    assert.match(csrfCookie, new RegExp(`Path=${PREFIX}(;|$)`), 'the CSRF cookie is scoped the same way');
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

test('every form posts back inside the prefix', async () => {
  await withServer(async (base) => {
    let checked = 0;
    for (const p of await everyPage(base, get)) {
      const html = await (await get(base, PREFIX + p)).text();
      for (const [, action] of html.matchAll(/<form[^>]*\saction="([^"]*)"/g)) {
        checked += 1;
        assert.ok(action.startsWith(PREFIX), `${p} posts to ${action}`);
      }
    }
    // The create and update forms for all three record types, plus delete,
    // the filter form and the demo reset. If this drops, a page stopped
    // rendering rather than a form being fixed.
    assert.ok(checked >= 8, `only ${checked} form actions seen`);
  });
});
