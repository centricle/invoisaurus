/**
 * Bind INVOISAURUS_DATA_DIR to a fresh temporary directory, as a side effect of
 * being imported.
 *
 * src/config.js resolves DATA_DIR once, at import time, so the environment has
 * to be set before anything that reaches src/store.js is loaded. Reaching it
 * indirectly is the easy part to miss: test/invoices.test.js imports
 * src/routes/invoices.js, which imports the store two levels down, and it does
 * not touch the store today only because it happens to import pure functions
 * from it.
 *
 * Hence the side effect rather than an exported setup function. ES imports all
 * evaluate before the module body runs, so a function called from the body
 * would fire after src/config.js had already resolved. Importing this module
 * above the src imports is what makes the ordering work.
 *
 * Every test file imports it, including the ones with no path to the store at
 * all. The README tells a stranger that the suite never touches their invoice
 * records; that should hold because of what these files do, not because of
 * what they currently happen not to import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'invoisaurus-test-'));

process.env.INVOISAURUS_DATA_DIR = DATA_DIR;
