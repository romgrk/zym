import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, type Block } from './blocks.ts';

const types = (blocks: Block[]) => blocks.map((b) => b.type);

test('headings, paragraphs, hr', () => {
  const b = parseBlocks('# Title\n\nsome **text** here\n\n---\n');
  assert.deepEqual(types(b), ['heading', 'paragraph', 'hr']);
  assert.deepEqual(b[0], { type: 'heading', level: 1, text: 'Title' });
  assert.equal((b[1] as any).text, 'some **text** here');
});

test('fenced code keeps lang + raw body', () => {
  const b = parseBlocks('```ts\nconst x = 1\nconst y = 2\n```\n');
  assert.equal(b.length, 1);
  assert.deepEqual(b[0], { type: 'code', lang: 'ts', code: 'const x = 1\nconst y = 2' });
});

test('unterminated fence still captures the body', () => {
  const b = parseBlocks('```\nno close\n');
  assert.deepEqual(b[0], { type: 'code', lang: undefined, code: 'no close' });
});

test('GFM table with alignments', () => {
  const md = '| Name | Qty |\n| :--- | --: |\n| apple | 3 |\n| pear | 10 |\n';
  const b = parseBlocks(md);
  assert.equal(b.length, 1);
  const t = b[0] as Extract<Block, { type: 'table' }>;
  assert.equal(t.type, 'table');
  assert.deepEqual(t.headers, ['Name', 'Qty']);
  assert.deepEqual(t.aligns, ['left', 'right']);
  assert.deepEqual(t.rows, [['apple', '3'], ['pear', '10']]);
});

test('ordered + nested list', () => {
  const md = '1. first\n2. second\n   - nested a\n   - nested b\n3. third\n';
  const b = parseBlocks(md);
  assert.equal(b.length, 1);
  const list = b[0] as Extract<Block, { type: 'list' }>;
  assert.equal(list.ordered, true);
  assert.deepEqual(list.items.map((i) => i.text), ['first', 'second', 'third']);
  const nested = list.items[1].children[0] as Extract<Block, { type: 'list' }>;
  assert.equal(nested.type, 'list');
  assert.equal(nested.ordered, false);
  assert.deepEqual(nested.items.map((i) => i.text), ['nested a', 'nested b']);
});

test('blockquote parses its inner blocks', () => {
  const b = parseBlocks('> quoted line\n> # quoted heading\n');
  assert.equal(b.length, 1);
  const bq = b[0] as Extract<Block, { type: 'blockquote' }>;
  assert.equal(bq.type, 'blockquote');
  assert.deepEqual(types(bq.blocks), ['paragraph', 'heading']);
});

test('a table does not swallow a following paragraph', () => {
  const b = parseBlocks('| a | b |\n| - | - |\n| 1 | 2 |\n\nafter the table\n');
  assert.deepEqual(types(b), ['table', 'paragraph']);
  assert.equal((b[1] as any).text, 'after the table');
});

test('escaped pipe stays literal in a cell', () => {
  const b = parseBlocks('| a | b |\n| - | - |\n| x \\| y | z |\n');
  const t = b[0] as Extract<Block, { type: 'table' }>;
  assert.deepEqual(t.rows, [['x | y', 'z']]);
});
