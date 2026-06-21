/*
 * assert.ts — assertion helpers (ported from xedel's utils/assert.js).
 */

export function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
  if (condition) return;
  // eslint-disable-next-line no-debugger -- intentional: break into the debugger on assertion failure
  debugger;
  throw new Error(message);
}

export function unreachable(): never {
  // eslint-disable-next-line no-debugger -- intentional: break into the debugger when an unreachable path is hit
  debugger;
  throw new Error('unreachable');
}
