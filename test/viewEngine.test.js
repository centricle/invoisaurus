import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Binds INVOISAURUS_DATA_DIR before config.js resolves it. See test/tmpdir.js.
// Nothing here reaches the store today; the import is what keeps that from
// being the reason, as tmpdir.js explains.
import './tmpdir.js';
import { ejsEngine } from '../src/viewEngine.js';

const render = (file, data) => new Promise((resolve, reject) => {
  ejsEngine(file, data, (err, html) => (err ? reject(err) : resolve(html)));
});

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoisaurus-views-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

test('a local named "client" does not break includes', async () => {
  // ejs.renderFile promotes `client` out of the data object and treats it as
  // the client-compile option, which removes `include` from scope. "Client" is
  // this app's central noun, so this must keep working.
  const dir = fixture({
    'partial.ejs': '<span><%= client.name %></span>',
    'page.ejs': "<div><%- include('partial') %></div>",
  });
  const html = await render(path.join(dir, 'page.ejs'), { client: { name: 'Wile E. Coyote' } });
  assert.equal(html, '<div><span>Wile E. Coyote</span></div>');
});

test('other EJS option names are also safe as locals', async () => {
  const dir = fixture({
    'partial.ejs': '<%= context %>|<%= scope %>|<%= debug %>',
    'page.ejs': "<%- include('partial') %>",
  });
  const html = await render(path.join(dir, 'page.ejs'), { context: 'a', scope: 'b', debug: 'c' });
  assert.equal(html, 'a|b|c');
});

test('includes resolve relative to the including template', async () => {
  const dir = fixture({ 'partial.ejs': 'inner', 'page.ejs': "[<%- include('partial') %>]" });
  assert.equal(await render(path.join(dir, 'page.ejs'), {}), '[inner]');
});

test('a template error reaches the callback rather than throwing', async () => {
  const dir = fixture({ 'bad.ejs': '<%= nope.missing %>' });
  await assert.rejects(() => render(path.join(dir, 'bad.ejs'), {}));
});
