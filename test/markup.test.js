import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkup, parsePlain } from '../src/lib/markup.js';

/** A block's text, with bold marked `*` and italic `/`, for readable assertions. */
const styled = (runs) => runs
  .map((r) => `${r.bold ? '*' : ''}${r.italic ? '/' : ''}${r.text}`)
  .join('|');

const first = (text) => parseMarkup(text)[0];

test('a heading is its own block', () => {
  const block = first('# Environment restoration');
  assert.equal(block.type, 'heading');
  assert.equal(styled(block.runs), 'Environment restoration');
});

test('a hash with no space after it is not a heading', () => {
  assert.equal(first('#4 of six').type, 'paragraph');
});

test('bold and italic have two spellings each', () => {
  assert.equal(styled(first('**one** __two__').runs), '*one| |*two');
  assert.equal(styled(first('*one* _two_').runs), '/one| |/two');
});

test('emphasis nests', () => {
  assert.equal(styled(first('**bold with *italic* inside**').runs), '*bold with |*/italic|* inside');
});

test('a marker with no closer prints as the character it is', () => {
  assert.equal(styled(first('2 items * 3 crates').runs), '2 items * 3 crates');
  assert.equal(styled(first('**unfinished').runs), '**unfinished');
});

test('arithmetic does not turn into emphasis', () => {
  // The closer may not follow whitespace, which is the whole rule here.
  assert.equal(styled(first('2 * 3 * 4 units').runs), '2 * 3 * 4 units');
});

test('an underscore inside a word is part of the word', () => {
  // A filename in a description is the common case, and it used to be the
  // cheapest way to italicize half an invoice by accident.
  assert.equal(styled(first('snake_case_name and file_v2_final.pdf').runs),
    'snake_case_name and file_v2_final.pdf');
});

test('a backslash escapes a marker', () => {
  assert.equal(styled(first('5 \\* 3 and a literal \\*\\*pair\\*\\*').runs),
    '5 * 3 and a literal **pair**');
});

test('consecutive bullets are one list', () => {
  const [list] = parseMarkup('- first\n- second\n- third');
  assert.equal(list.type, 'list');
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 3);
  assert.equal(styled(list.items[2].runs), 'third');
});

test('an ordered list records where it starts, not every number typed', () => {
  // Renumbering is the renderer's job. Recording `start` is what lets a list
  // that genuinely begins at 3 keep doing so.
  const [list] = parseMarkup('3. third\n1. fourth\n9. fifth');
  assert.equal(list.ordered, true);
  assert.equal(list.start, 3);
  assert.equal(list.items.length, 3);
});

test('switching between bullets and numbers starts a second list', () => {
  const blocks = parseMarkup('- one\n1. two');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[1].ordered, true);
});

test('a blank line ends a list and becomes space', () => {
  const blocks = parseMarkup('- one\n\n- two');
  assert.deepEqual(blocks.map((b) => b.type), ['list', 'blank', 'list']);
});

test('each line is its own paragraph', () => {
  // CommonMark folds these into one. Descriptions became multi-line in 1.1.1
  // with every break printing, and joining them now would change documents
  // that were already produced.
  const blocks = parseMarkup('Restoration\nand verification');
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'paragraph']);
});

test('trailing blank lines contribute nothing', () => {
  assert.equal(parseMarkup('Restoration\n\n\n').length, 1);
});

test('parsePlain interprets nothing', () => {
  const blocks = parsePlain('# not a heading\n- not a bullet\n**not bold**');
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'paragraph', 'paragraph']);
  assert.equal(styled(blocks[2].runs), '**not bold**');
});

test('text carrying no markup parses identically either way', () => {
  // This is what makes the schema-version gate invisible for an ordinary
  // description: only text that actually uses the subset renders differently.
  const plain = 'Rocket skates (model XLR-8): fitting and calibration\nand a bench test';
  assert.deepEqual(parseMarkup(plain), parsePlain(plain));
});

test('empty input is no blocks at all', () => {
  assert.deepEqual(parseMarkup(''), []);
  assert.deepEqual(parseMarkup(null), []);
});
