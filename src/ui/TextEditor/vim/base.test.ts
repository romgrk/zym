import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Base } from './base.js';

// A throwaway operation subclass to exercise the registration + instance machinery.
class SampleMotion extends Base {
  static operationKind = 'motion';
  initialized = false;
  initialize() {
    this.initialized = true;
  }
}

test('vendored base.js loads as ESM and registers/looks up classes', () => {
  SampleMotion.register();
  assert.equal(Base.getClass('SampleMotion'), SampleMotion);
});

test('getClass throws for an unregistered name', () => {
  assert.throws(() => Base.getClass('NoSuchOperation'), /not found/);
});

test('getInstance constructs, assigns properties, and calls initialize', () => {
  SampleMotion.register();
  const vimState = {};
  const instance = Base.getInstance(vimState, 'SampleMotion', { count: 3 });
  assert.ok(instance instanceof SampleMotion);
  assert.equal(instance.vimState, vimState);
  assert.equal(instance.count, 3);
  assert.ok(instance.initialized);
});

test('operation-kind predicates and command-name derivation', () => {
  const instance = new SampleMotion({});
  assert.ok(instance.isMotion());
  assert.ok(!instance.isOperator());
  assert.ok(!instance.isTextObject());
  assert.equal(SampleMotion.getCommandName(), 'vim-mode-plus:sample-motion');
  assert.equal(SampleMotion.getCommandNameWithoutPrefix(), 'sample-motion');
});

test('count machinery reads through the vimState proxy', () => {
  // defaultCount when vimState has no count
  const a = new SampleMotion({ hasCount: () => false });
  assert.equal(a.getCount(), 1);
  // vimState-provided count when present
  const b = new SampleMotion({ hasCount: () => true, getCount: () => 5 });
  assert.equal(b.getCount(), 5);
});
