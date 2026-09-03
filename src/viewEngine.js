import fs from 'node:fs';
import ejs from 'ejs';

/**
 * A view engine that keeps template data and compiler options separate.
 *
 * Express hands `res.render` locals straight to `ejs.renderFile`, which
 * promotes a fixed set of keys out of the data object and treats them as
 * compiler options instead. `client` is on that list. This application's
 * central noun is "client", so rendering a form with a client record as a local
 * silently switched EJS into client-compile mode — where `include` is not
 * defined — and every include in the template failed with the deeply unhelpful
 * "include is not a function".
 *
 * The same trap is waiting on every other name EJS promotes: `delimiter`,
 * `scope`, `context`, `debug`, `compileDebug`, `_with`, `rmWhitespace`,
 * `strict`, `async`, and `cache` on the `renderFile` path. (`filename` is
 * promoted too, but `renderFile` overwrites it immediately afterward, so it
 * cannot break a render the way `client` does.)
 *
 * Rather than banning a list of ordinary English words from being template
 * locals, read the file and call `ejs.render` with three arguments. Given data
 * and options separately it promotes nothing; called with two it would promote
 * from the data just as `renderFile` does.
 */
const cache = new Map();
const shouldCache = process.env.NODE_ENV === 'production';

export function ejsEngine(filePath, data, callback) {
  try {
    let template = shouldCache ? cache.get(filePath) : null;
    if (template == null) {
      template = fs.readFileSync(filePath, 'utf8');
      if (shouldCache) cache.set(filePath, template);
    }
    callback(null, ejs.render(template, data, { filename: filePath }));
  } catch (err) {
    callback(err);
  }
}
