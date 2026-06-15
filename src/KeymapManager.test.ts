import { test } from 'node:test';
import assert from 'node:assert/strict';
// quilx.ts instantiates a KeymapManager at load; import it first so the class is
// defined before that runs (KeymapManager ↔ quilx is a circular import).
import './quilx.ts';
import { KeymapManager } from './KeymapManager.ts';

test('getAllBindings flattens registered bindings with source, selector and priority', () => {
  const km = new KeymapManager();
  km.add('default-keymap', { '#AppWindow': { 'space n': 'notifications:toggle-log' } }, 0);
  km.add('user-keymap', { '#AppWindow': { 'space n': 'custom:thing' } }, 100);

  const rows = km.getAllBindings().filter((b) => b.keystroke === 'space n');
  assert.equal(rows.length, 2, 'one row per source for the same keystroke');

  const def = rows.find((b) => b.source === 'default-keymap')!;
  const usr = rows.find((b) => b.source === 'user-keymap')!;
  assert.equal(def.command, 'notifications:toggle-log');
  assert.equal(def.priority, 0);
  assert.equal(def.selector, '#AppWindow');
  assert.equal(usr.command, 'custom:thing');
  assert.equal(usr.priority, 100);
});

test('getAllBindings dedupes a selector that expands to multiple rules', () => {
  const km = new KeymapManager();
  // A compound selector parses into several rules; the binding should appear once.
  km.add('s', { '#A, #B': { x: 'cmd:x' } });
  const xs = km.getAllBindings().filter((b) => b.keystroke === 'x' && b.source === 's');
  assert.equal(xs.length, 1);
});

test('onBindingsChanged fires on add and remove, and stops after dispose', () => {
  const km = new KeymapManager();
  let count = 0;
  const sub = km.onBindingsChanged(() => { count++; });

  const binding = km.add('s', { '#AppWindow': { a: 'cmd:a' } });
  assert.equal(count, 1, 'add notifies');

  binding.dispose();
  assert.equal(count, 2, 'remove notifies');

  sub.dispose();
  km.add('s2', { '#AppWindow': { b: 'cmd:b' } });
  assert.equal(count, 2, 'no notification after unsubscribe');
});
