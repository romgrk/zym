import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import test from 'node:test';

import { openGitRepo } from '../../git.ts';
import type { GutterCellSink } from '../../syntax/gutterRenderers.ts';
import { tmpDir } from '../../util/testTmp.ts';
import { GitGutter } from './GitGutter.ts';

class TestGutter implements GutterCellSink {
  gitCell: ((viewLine: number) => string) | null = null;
  redraws = 0;

  setGitCell(cell: ((viewLine: number) => string) | null): void {
    this.gitCell = cell;
  }

  setDiagCell(): void {}

  redrawGutter(): void {
    this.redraws++;
  }
}

test('git gutter stays entirely disabled for a file outside a repository', () => {
  const dir = tmpDir('git-gutter-no-repo');
  const path = Path.join(dir, 'plain.ts');
  const repo = openGitRepo(dir);
  const sink = new TestGutter();
  let textReads = 0;
  const gutter = new GitGutter(sink, () => path, () => {
    textReads++;
    return 'const value = 1;\n';
  }, repo);

  gutter.refresh();
  gutter.scheduleUpdate();

  assert.equal(sink.gitCell, null);
  assert.equal(sink.redraws, 0);
  assert.equal(textReads, 0);
  assert.deepEqual(gutter.hunkStartRows(), []);
  assert.equal(gutter.unstagedHunkAtRow(0), null);
  assert.equal(gutter.stagedHunkAtRow(0), null);

  gutter.dispose();
  repo.dispose();
});

test('leaving a repository removes the git gutter column immediately', () => {
  const dir = tmpDir('git-gutter-repo-boundary');
  const checkout = Path.join(dir, 'checkout');
  Fs.mkdirSync(Path.join(checkout, '.git'), { recursive: true });
  let path = Path.join(checkout, 'tracked.ts');
  const repo = openGitRepo(dir);
  const sink = new TestGutter();
  const gutter = new GitGutter(sink, () => path, () => '', repo, undefined, () => false);

  gutter.refresh();
  assert.equal(typeof sink.gitCell, 'function');

  path = Path.join(dir, 'outside.ts');
  gutter.refresh();
  assert.equal(sink.gitCell, null);
  assert.deepEqual(gutter.hunkStartRows(), []);

  gutter.dispose();
  repo.dispose();
});
