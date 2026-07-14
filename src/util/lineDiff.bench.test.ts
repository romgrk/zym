/*
 * lineDiff benchmark — not a correctness test. Skipped unless BENCH is set, so
 * it never runs in CI / the normal `node --test` sweep. Run with:
 *
 *   BENCH=1 node --test src/util/lineDiff.bench.test.ts
 *
 * Scenarios mirror the git gutter's inputs (buffer vs index blob of a large
 * file): a clustered edit (typical typing), scattered edits at increasing
 * divergence (the Myers search cost grows with edit distance D), and a fully
 * regenerated file (D hits the cap). Compare the logged numbers before and
 * after a change on the same machine; wall-time is too noisy to assert.
 */
import { test } from 'node:test';
import { diffLines } from './lineDiff.ts';

const LINES = 9_000; // large, but under the combined MAX_LINES=20000 cap

// Deterministic synthetic code-ish lines (no Math.random — stable across runs).
function buildFile(n: number, salt = 0): string[] {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    lines.push(`  const value${i} = compute(${(i * 7 + salt) % 997}) + ${i % 13}; // ${salt}`);
  }
  return lines;
}

function withEditEvery(a: readonly string[], stride: number): string[] {
  return a.map((line, i) => (i % stride === 0 ? line + ' /* edited */' : line));
}

function withClusterEdit(a: readonly string[], at: number, count: number): string[] {
  const b = [...a];
  for (let i = at; i < at + count; i++) b[i] = `  inserted_line(${i});`;
  return b;
}

function median(xs: number[]): number {
  const s = [...xs].sort((x, y) => x - y);
  return s[s.length >> 1];
}

test(`diffLines cost at ${LINES} lines`, { skip: !process.env.BENCH }, () => {
  const a = buildFile(LINES);
  const scenarios: Array<[string, readonly string[], readonly string[]]> = [
    ['identical', a, a],
    ['cluster 30 lines (typing)', a, withClusterEdit(a, 4000, 30)],
    ['every 100th edited (D~180)', a, withEditEvery(a, 100)],
    ['every 20th edited (D~900)', a, withEditEvery(a, 20)],
    ['every 10th edited (D~1800)', a, withEditEvery(a, 10)],
    ['every 5th edited (D~3600)', a, withEditEvery(a, 5)],
    ['regenerated file (D>cap)', a, buildFile(LINES, 1)],
  ];
  const RUNS = 5;
  for (const [, x, y] of scenarios) diffLines(x, y); // warm up

  console.log(`\ndiffLines() median over ${RUNS} runs, ${LINES} lines:`);
  for (const [name, x, y] of scenarios) {
    const times: number[] = [];
    let ops = 0;
    for (let r = 0; r < RUNS; r++) {
      const t0 = performance.now();
      ops = diffLines(x, y).length;
      times.push(performance.now() - t0);
    }
    console.log(`  ${name.padEnd(30)} ${median(times).toFixed(2).padStart(8)} ms  (${ops} ops)`);
  }
});
