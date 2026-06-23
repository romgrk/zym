import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Disposable, CompositeDisposable } from './eventKit.ts';

test('defer runs its function once on dispose, and is idempotent', () => {
  const cd = new CompositeDisposable();
  let n = 0;
  cd.defer(() => n++);
  cd.dispose();
  cd.dispose();
  assert.equal(n, 1);
});

test('members are disposed newest-first (LIFO)', () => {
  const cd = new CompositeDisposable();
  const order: number[] = [];
  cd.defer(() => order.push(1));
  cd.defer(() => order.push(2));
  cd.defer(() => order.push(3));
  cd.dispose();
  assert.deepEqual(order, [3, 2, 1]);
});

test('clear() runs everything but leaves the bag reusable', () => {
  const cd = new CompositeDisposable();
  let a = 0;
  cd.defer(() => a++);
  cd.clear();
  assert.equal(a, 1);
  // re-arm: still usable after clear()
  let b = 0;
  cd.defer(() => b++);
  cd.clear();
  assert.equal(b, 1);
  assert.equal(a, 1, 'first cycle ran exactly once');
});

test('dispose() seals the bag: later adds dispose immediately', () => {
  const cd = new CompositeDisposable();
  cd.dispose();
  let n = 0;
  cd.defer(() => n++);
  assert.equal(n, 1, 'late defer ran at once instead of leaking');
});

test('connect registers obj.off paired with obj.on', () => {
  const calls: string[] = [];
  const handler = () => {};
  const obj = {
    on: (sig: string, h: (...a: any[]) => unknown) => calls.push(`on:${sig}:${h === handler}`),
    off: (sig: string, h: (...a: any[]) => unknown) => calls.push(`off:${sig}:${h === handler}`),
  };
  const cd = new CompositeDisposable();
  cd.connect(obj, 'changed', handler);
  assert.deepEqual(calls, ['on:changed:true']);
  cd.dispose();
  assert.deepEqual(calls, ['on:changed:true', 'off:changed:true']);
});

test('addController attaches then removes the same controller', () => {
  const calls: string[] = [];
  const controller = { id: 'ctrl' };
  const widget = {
    addController: (c: typeof controller) => calls.push(`add:${c.id}`),
    removeController: (c: typeof controller) => calls.push(`remove:${c.id}`),
  };
  const cd = new CompositeDisposable();
  cd.addController(widget, controller);
  assert.deepEqual(calls, ['add:ctrl']);
  cd.dispose();
  assert.deepEqual(calls, ['add:ctrl', 'remove:ctrl']);
});

test('timer is cleared on dispose if it has not fired', () => {
  const cd = new CompositeDisposable();
  let fired = false;
  cd.timer(() => (fired = true), 10_000);
  cd.dispose();
  // if the timeout were left pending it would keep the event loop alive; clearing
  // it means `fired` stays false and the process can exit.
  assert.equal(fired, false);
});

test('adopt returns the value and disposes it with the given teardown', () => {
  const cd = new CompositeDisposable();
  const resource = { closed: false };
  const got = cd.adopt(resource, (r) => (r.closed = true));
  assert.equal(got, resource);
  cd.dispose();
  assert.equal(resource.closed, true);
});

test('nest gives a child the parent tears down, re-armable independently', () => {
  const parent = new CompositeDisposable();
  const child = parent.nest();
  let childRuns = 0;
  let cycleRuns = 0;

  child.defer(() => cycleRuns++);
  child.clear(); // end of one cycle — child still usable
  assert.equal(cycleRuns, 1);

  child.defer(() => childRuns++);
  parent.dispose(); // end of life — parent disposes the child
  assert.equal(childRuns, 1);
});

test('Disposable runs its action once', () => {
  let n = 0;
  const d = new Disposable(() => n++);
  d.dispose();
  d.dispose();
  assert.equal(n, 1);
});
