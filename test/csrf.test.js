import { test, before } from 'node:test';
import assert from 'node:assert/strict';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';
import { createApp } from '../src/app.js';
import { createJsonStore } from '../src/store.js';
import { createMemoryBackend } from '../src/storage-memory.js';

/**
 * The refusals. Every other suite posts the way a real form does -- cookie
 * and field both present -- so this is the one place the other shapes a
 * request can arrive in are tried. Built straight from createApp over a
 * memory store, which is also the smallest working example of the factory.
 */
const store = createJsonStore({ backend: createMemoryBackend(), dataDir: '/csrf-test' });
const app = createApp({ store, allowOrigins: ['https://centricle.com'] });
let base;

before(async () => {
  await store.ensureDataDir();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  server.unref();
});

const COYOTE = {
  name: 'Wile E. Coyote', type: 'individual',
  street: '22 Mesa Verde Rd', city: 'Tucumcari', state: 'NM', zip: '88401',
};

const post = (fields, { headers = {}, cookie = '' } = {}) => fetch(`${base}/clients`, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    ...(cookie ? { cookie } : {}),
    ...headers,
  },
  body: new URLSearchParams(fields),
  redirect: 'manual',
});

/** What a browser holds after loading one page. */
async function browser() {
  const res = await fetch(`${base}/clients/new`);
  const set = res.headers.getSetCookie().find((c) => c.startsWith('csrf='));
  const token = set.split(';')[0].slice(5);
  const html = await res.text();
  return { cookie: `csrf=${token}`, token, set, html };
}

test('a post with nothing to show for itself is refused, and told why', async () => {
  const res = await post(COYOTE);
  assert.equal(res.status, 403);
  const body = await res.text();
  assert.match(body, /could not be verified/);
  assert.match(body, /reload the page/);
  assert.match(res.headers.get('set-cookie') || '', /^csrf=/, 'and the retry will have a cookie');
});

test('the page carries the same token the cookie does', async () => {
  const b = await browser();
  const field = b.html.match(/name="_csrf" value="([a-f0-9]{64})"/);
  assert.ok(field, 'the form renders the hidden field');
  assert.equal(field[1], b.token, 'and it is the cookie value');

  const res = await post({ ...COYOTE, _csrf: b.token }, { cookie: b.cookie });
  assert.equal(res.status, 302, 'cookie plus matching field is a real form post');
});

test('a field that does not match the cookie is refused', async () => {
  const b = await browser();
  const wrong = b.token.replace(/./g, (c) => (c === 'a' ? 'b' : 'a'));
  assert.equal((await post({ ...COYOTE, _csrf: wrong }, { cookie: b.cookie })).status, 403);
  assert.equal((await post({ ...COYOTE, _csrf: 'short' }, { cookie: b.cookie })).status, 403);
  assert.equal((await post({ ...COYOTE }, { cookie: b.cookie })).status, 403, 'a cookie alone is not proof');
});

test('the cookie is httpOnly, lax and scoped to the mount', async () => {
  const b = await browser();
  assert.match(b.set, /HttpOnly/);
  assert.match(b.set, /SameSite=Lax/);
  assert.match(b.set, /Path=\/(;|$)/);
});

test("the browser's own word is enough", async () => {
  // A modern browser labels every request. same-origin is accepted with no
  // token at all; the token exists for clients that say nothing.
  const res = await post(COYOTE, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(res.status, 302);
});

test('a cross-site post is refused whatever else it carries', async () => {
  const b = await browser();
  for (const site of ['cross-site', 'same-site']) {
    const res = await post({ ...COYOTE, _csrf: b.token }, {
      cookie: b.cookie, headers: { 'sec-fetch-site': site },
    });
    assert.equal(res.status, 403, `${site} with a valid token must still be refused`);
  }
});

test('an origin this app does not serve is refused', async () => {
  const b = await browser();
  const res = await post({ ...COYOTE, _csrf: b.token }, {
    cookie: b.cookie, headers: { origin: 'https://evil.example' },
  });
  assert.equal(res.status, 403);
});

test("the app's own origin and the operator's proxy are allowed", async () => {
  // No token on either: the Origin header is the proof. The second is how an
  // app proxied under another site keeps working, since the origin a browser
  // reports is the proxy's, not the function's.
  assert.equal((await post(COYOTE, { headers: { origin: base } })).status, 302);
  assert.equal((await post(COYOTE, { headers: { origin: 'https://centricle.com' } })).status, 302);
  assert.equal((await post(COYOTE, { headers: { origin: 'https://centricle.com/' } })).status, 403,
    'an origin is compared exactly; a browser never sends a trailing slash');
});

test('reading never needs a token', async () => {
  for (const url of ['/invoices', '/clients', '/vendors', '/clients/new']) {
    assert.equal((await fetch(`${base}${url}`)).status, 200, url);
  }
});
