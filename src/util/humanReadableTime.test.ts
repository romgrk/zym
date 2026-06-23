import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanReadableTime } from './humanReadableTime.ts';

// A fixed reference "now": 2026-06-22 15:30 local time.
const NOW = new Date(2026, 5, 22, 15, 30, 0).getTime();
const at = (y: number, mo: number, d: number, h = 9, mi = 5): number =>
  new Date(y, mo, d, h, mi, 0).getTime();

test('humanReadableTime: today shows just the clock time', () => {
  assert.equal(humanReadableTime(at(2026, 5, 22, 14, 3), NOW), '14:03');
});

test('humanReadableTime: yesterday is labelled with the time', () => {
  assert.equal(humanReadableTime(at(2026, 5, 21, 8, 9), NOW), 'Yesterday 08:09');
});

test('humanReadableTime: earlier this year shows day, month and time', () => {
  assert.equal(humanReadableTime(at(2026, 0, 3, 23, 59), NOW), '3 Jan 23:59');
});

test('humanReadableTime: a previous year shows the date with the year (no time)', () => {
  assert.equal(humanReadableTime(at(2024, 10, 9, 12, 0), NOW), '9 Nov 2024');
});
