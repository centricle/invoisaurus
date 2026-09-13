/**
 * Where this package's own files are: templates, static assets, fonts.
 *
 * `import.meta.url` is the natural answer and the right one for every way the
 * app is normally run. It does not survive being bundled, though: a serverless
 * bundler transpiles the module to CommonJS and replaces `import.meta` with an
 * empty object, so `fileURLToPath(undefined)` throws while the module is still
 * being imported -- before any request, with a stack that points here rather
 * than at the bundler. Hence the override, checked first so the failing call
 * is never reached when it is set.
 *
 * A host that installs this as a dependency sets `INVOISAURUS_ROOT` to the
 * package directory inside its own bundle, for the same reason the demo
 * function does: the files a bundler cannot see in the import graph still
 * have to be found at runtime.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = process.env.INVOISAURUS_ROOT
  ? path.resolve(process.env.INVOISAURUS_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VIEWS_DIR = path.join(PKG_ROOT, 'src/views');
export const PUBLIC_DIR = path.join(PKG_ROOT, 'public');
export const FONTS_DIR = path.join(PKG_ROOT, 'src/lib/pdf/fonts');
