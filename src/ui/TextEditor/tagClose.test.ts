import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagToAutoClose } from './tagClose.ts';

test('closes an opening tag in expression position', () => {
  assert.equal(tagToAutoClose('return <div'), 'div');
  assert.equal(tagToAutoClose('  <Foo.Bar'), 'Foo.Bar');
  assert.equal(tagToAutoClose('x = <my-elem'), 'my-elem');
  assert.equal(tagToAutoClose('<div className="a"'), 'div');
  assert.equal(tagToAutoClose('<div><span'), 'span'); // after a previous tag's >
});

test('fragment `<>` closes to `</>`', () => {
  assert.equal(tagToAutoClose('return <'), '');
});

test('does NOT close a generic (the `<` follows an identifier)', () => {
  assert.equal(tagToAutoClose('const x: Array<string'), null);
  assert.equal(tagToAutoClose('useState<number'), null);
  assert.equal(tagToAutoClose('foo<Bar'), null);
});

test('does NOT close closing/self-closing tags or non-tags', () => {
  assert.equal(tagToAutoClose('  </div'), null); // closing tag
  assert.equal(tagToAutoClose('  <br/'), null); // self-closing
  assert.equal(tagToAutoClose('if (a < 3'), null); // `< 3` — no tag name
  assert.equal(tagToAutoClose('<div>already</div'), null); // closing again, after a >
  assert.equal(tagToAutoClose('no angle bracket here'), null);
});

test('uses the nearest unclosed `<`', () => {
  // `<div>` is closed; the open one is `<span`.
  assert.equal(tagToAutoClose('<div>text <span'), 'span');
});
