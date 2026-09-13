/**
 * The font files a style embeds, read once per process.
 *
 * These are IBM Plex Mono, unmodified, under the SIL Open Font License 1.1 --
 * OFL.txt sits beside them. They are shipped exactly as released rather than
 * pre-subset, for two reasons. Subsetting them here saves nothing where it
 * counts: pdf-lib subsets again at embed time, so the document a client
 * receives is within about a hundred bytes either way, and the only saving is
 * in this repository. And a subsetting tool drops the font's name table by
 * default, which takes the OFL notice out of the file the license asks to keep
 * it in -- and leaves a derived binary nobody can regenerate without a Python
 * toolchain. The license also reserves the name "Plex" for unmodified
 * releases, which is a question that simply does not arise if the bytes are
 * the ones IBM shipped.
 *
 * The path is resolved under ROOT_DIR and never with `new URL(...,
 * import.meta.url)`. A serverless bundler transpiles this module to CommonJS
 * and replaces `import.meta` with an empty object, so the URL form throws
 * while the module is still being imported -- which is exactly the trap
 * src/config.js documents and works around.
 *
 * Netlify's tracer follows imports, and a file read at runtime appears in no
 * import graph, so these are invisible to it. netlify.toml carries them in
 * `included_files` for the same reason it carries src/views, and
 * scripts/check-bundle.mjs asserts they arrived.
 */
import fs from 'node:fs';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { ROOT_DIR } from '../../config.js';

const DIR = path.join(ROOT_DIR, 'src/lib/pdf/fonts');

export const MONO_REGULAR = 'IBMPlexMono-Regular.ttf';
export const MONO_MEDIUM = 'IBMPlexMono-Medium.ttf';

/**
 * File name to bytes.
 *
 * The PDF route regenerates the document on every request, and an editor with
 * the preview open asks for it on every save, so re-reading these off disk
 * each time is pure waste. They never change within a process.
 *
 * Lazy rather than read at import: a missing file should fail the PDF route,
 * not refuse to start the app. Every other page still works, and the error
 * says what to do about it.
 */
const cache = new Map();

export function fontBytes(file) {
  if (!cache.has(file)) {
    try {
      cache.set(file, fs.readFileSync(path.join(DIR, file)));
    } catch (cause) {
      throw new Error(
        `Cannot read ${file} from ${DIR}. In a deploy this means the bundle does `
        + 'not carry it: netlify.toml [functions] included_files must list '
        + '"src/lib/pdf/fonts/**". Verify with `npm run check:bundle`.',
        { cause },
      );
    }
  }
  return cache.get(file);
}

/**
 * Embed one of these faces, subset to the glyphs the document actually draws.
 *
 * fontkit is registered on the document rather than once globally, because
 * that is where pdf-lib keeps it: a document created without it throws on the
 * first custom embed. Registering twice is harmless.
 *
 * `subset: true` is not optional. Without it every invoice carries the whole
 * face -- about half a megabyte across two weights, on a document whose entire
 * job is to be emailed.
 */
export async function embedBundled(doc, file) {
  doc.registerFontkit(fontkit);
  return doc.embedFont(fontBytes(file), { subset: true });
}
