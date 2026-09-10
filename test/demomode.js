/**
 * Turn demo mode on, as a side effect of being imported.
 *
 * Same reasoning as test/tmpdir.js: src/config.js reads DEMO_MODE once at
 * import time, and every ES import evaluates before the module body, so a
 * setup function called from a test would fire too late. Import this above
 * the src imports.
 *
 * Deliberately does *not* set INVOISAURUS_DATA_DIR itself. The whole claim
 * under test is that demo mode writes nothing, and pointing it at a temp
 * directory that the suite then ignores would let a real write hide inside a
 * directory nobody checks. test/demo.test.js points it at a path that does not
 * exist and asserts it still does not.
 */
process.env.DEMO_MODE = 'true';
