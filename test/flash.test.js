import { test } from 'node:test';
import assert from 'node:assert/strict';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
import './tmpdir.js';
import { setFlash, takeFlash } from '../src/flash.js';

/** Enough of a response to observe what setFlash and takeFlash do to cookies. */
function fakeRes() {
  return {
    cookies: [],
    cleared: [],
    cookie(name, value, opts) { this.cookies.push({ name, value, opts }); },
    clearCookie(name, opts) { this.cleared.push({ name, opts }); },
  };
}

const reqWith = (value) => ({ headers: { cookie: `flash=${encodeURIComponent(value)}` } });

test('a flash carries a code and an argument, not a sentence', () => {
  const res = fakeRes();
  setFlash(res, 'invoice-created', 'ACM-0001');

  assert.equal(res.cookies[0].value, 'invoice-created:ACM-0001');
  assert.equal(res.cookies[0].opts.httpOnly, true);
  assert.equal(res.cookies[0].opts.sameSite, 'lax');
  assert.equal(res.cookies[0].opts.path, '/');
});

test('the message is assembled on the server, from the code', () => {
  assert.equal(
    takeFlash(reqWith('invoice-created:ACM-0001'), fakeRes()),
    'Invoice ACM-0001 created.',
  );
  assert.equal(takeFlash(reqWith('invoice-saved'), fakeRes()), 'Invoice saved.');
});

test('reading a flash clears it', () => {
  const res = fakeRes();
  takeFlash(reqWith('invoice-saved'), res);
  assert.deepEqual(res.cleared, [{ name: 'flash', opts: { path: '/' } }]);
});

test('no cookie is no message', () => {
  assert.equal(takeFlash({ headers: {} }, fakeRes()), '');
  assert.equal(takeFlash({ headers: { cookie: 'other=1' } }, fakeRes()), '');
});

test('a code the app did not write renders nothing', () => {
  // `MESSAGES[code]` alone reaches Object.prototype: `constructor` finds
  // `Object`, calls it with the argument, and returns the argument -- which
  // then renders in a success banner. `toString` yields "[object Object]".
  // Own-property lookup is what makes "a code from the fixed set" true.
  for (const value of ['constructor:PWNED', 'toString', 'valueOf', 'hasOwnProperty', 'nope']) {
    assert.equal(takeFlash(reqWith(value), fakeRes()), '', `${value} must not render`);
  }
});

test('setting a code the app did not write is a programming error', () => {
  assert.throws(() => setFlash(fakeRes(), 'nope'), /Unknown flash code/);
  assert.throws(() => setFlash(fakeRes(), 'constructor'), /Unknown flash code/);
});

test('an argument containing a colon survives the round trip', () => {
  // The split is on the first colon only, so the rest of the value is the
  // argument. A client named "Wile E. Coyote: Sole Proprietor" is not exotic.
  assert.equal(
    takeFlash(reqWith('client-created:Coyote: Sole Proprietor'), fakeRes()),
    'Coyote: Sole Proprietor added.',
  );
});
