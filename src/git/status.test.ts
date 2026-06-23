import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus, parseNumstat, parseLsFiles, parseNameStatusZ, parseCommitLog, parseCommitFiles } from './status.ts';

// Porcelain v2 -z uses NUL terminators on every record (headers included).
const Z = (...records: string[]) => records.map((r) => r + '\0').join('');

test('parseStatus: clean repo on a branch', () => {
  const s = parseStatus(Z('# branch.oid abc1234def', '# branch.head main'));
  assert.equal(s.branch, 'main');
  assert.equal(s.commit, 'abc1234def');
  assert.equal(s.ahead, null);
  assert.equal(s.behind, null);
  assert.equal(s.conflicts, false);
  assert.deepEqual(s.entries, []);
});

test('parseStatus: ahead/behind from branch.ab', () => {
  const s = parseStatus(Z('# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3'));
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 3);
});

test('parseStatus: detached HEAD → short SHA', () => {
  const s = parseStatus(Z('# branch.oid 0123456789abcdef', '# branch.head (detached)'));
  assert.equal(s.branch, '0123456'); // 7-char abbreviation
});

test('parseStatus: unborn branch keeps the branch name', () => {
  const s = parseStatus(Z('# branch.oid (initial)', '# branch.head main'));
  assert.equal(s.branch, 'main');
  assert.equal(s.commit, null); // unborn branch has no HEAD commit
});

test('parseStatus: tracked modified (worktree only) vs staged', () => {
  const s = parseStatus(
    Z(
      '# branch.head main',
      '1 .M N... 100644 100644 100644 aaa bbb src/a.ts', // unstaged only
      '1 M. N... 100644 100644 100644 ccc ddd src/b.ts', // staged only
      '1 MM N... 100644 100644 100644 eee fff src/c.ts', // both
    ),
  );
  assert.deepEqual(
    s.entries.map((e) => [e.relPath, e.staged, e.unstaged, e.untracked, e.conflicted]),
    [
      ['src/a.ts', false, true, false, false],
      ['src/b.ts', true, false, false, false],
      ['src/c.ts', true, true, false, false],
    ],
  );
});

test('parseStatus: untracked', () => {
  const s = parseStatus(Z('# branch.head main', '? new file.txt'));
  assert.equal(s.entries.length, 1);
  assert.deepEqual(
    [s.entries[0].relPath, s.entries[0].untracked, s.entries[0].unstaged],
    ['new file.txt', true, true], // path with a space preserved
  );
});

test('parseStatus: ignored entries are skipped', () => {
  const s = parseStatus(Z('# branch.head main', '! dist/bundle.js'));
  assert.deepEqual(s.entries, []);
});

test('parseStatus: rename consumes the original-path token', () => {
  const s = parseStatus(
    Z(
      '# branch.head main',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts',
      'old/name.ts', // original path — must be consumed, not parsed as an entry
      '1 .M N... 100644 100644 100644 ccc ddd after.ts',
    ),
  );
  assert.deepEqual(
    s.entries.map((e) => e.relPath),
    ['new/name.ts', 'after.ts'],
  );
  assert.equal(s.entries[0].staged, true);
});

test('parseStatus: conflicts', () => {
  const s = parseStatus(
    Z('# branch.head main', 'u UU N... 100644 100644 100644 100644 a b c conflict.ts'),
  );
  assert.equal(s.conflicts, true);
  assert.equal(s.entries[0].conflicted, true);
  assert.equal(s.entries[0].relPath, 'conflict.ts');
});

test('parseStatus: empty input', () => {
  const s = parseStatus('');
  assert.deepEqual(s, { branch: null, commit: null, ahead: null, behind: null, conflicts: false, entries: [] });
});

test('parseNumstat: normal + binary', () => {
  const m = parseNumstat(Z('3\t1\tsrc/a.ts', '-\t-\timg/logo.png', '10\t0\tdocs/new.md'));
  assert.deepEqual(m.get('src/a.ts'), { added: 3, removed: 1 });
  assert.deepEqual(m.get('img/logo.png'), { added: 0, removed: 0 }); // binary
  assert.deepEqual(m.get('docs/new.md'), { added: 10, removed: 0 });
  assert.equal(m.size, 3);
});

test('parseNumstat: rename (old\\0new tokens)', () => {
  // "<a>\t<r>\t" then old path, then new path, each NUL-terminated.
  const m = parseNumstat('5\t2\t\0old/x.ts\0new/x.ts\0' + '1\t1\tplain.ts\0');
  assert.deepEqual(m.get('new/x.ts'), { added: 5, removed: 2 });
  assert.equal(m.has('old/x.ts'), false);
  assert.deepEqual(m.get('plain.ts'), { added: 1, removed: 1 });
});

test('parseNumstat: empty input', () => {
  assert.equal(parseNumstat('').size, 0);
});

test('parseLsFiles: paths with spaces, trailing NUL', () => {
  assert.deepEqual(parseLsFiles('a.ts\0dir/b c.ts\0'), ['a.ts', 'dir/b c.ts']);
  assert.deepEqual(parseLsFiles(''), []);
});

// --- parseNameStatusZ: `git diff --name-status -z` -------------------------

test('parseNameStatusZ: simple add/modify/delete', () => {
  const files = parseNameStatusZ('A\0src/new.ts\0M\0src/edit.ts\0D\0src/gone.ts\0');
  assert.deepEqual(files, [
    { status: 'A', relPath: 'src/new.ts' },
    { status: 'M', relPath: 'src/edit.ts' },
    { status: 'D', relPath: 'src/gone.ts' },
  ]);
});

test('parseNameStatusZ: rename and copy carry old + new path tokens', () => {
  const files = parseNameStatusZ('R100\0old/a.ts\0new/a.ts\0C75\0src/base.ts\0src/copy.ts\0');
  assert.deepEqual(files, [
    { status: 'R', relPath: 'new/a.ts', oldRelPath: 'old/a.ts' },
    { status: 'C', relPath: 'src/copy.ts', oldRelPath: 'src/base.ts' },
  ]);
});

test('parseNameStatusZ: paths with spaces; empty input', () => {
  assert.deepEqual(parseNameStatusZ('M\0dir/a b.ts\0'), [{ status: 'M', relPath: 'dir/a b.ts' }]);
  assert.deepEqual(parseNameStatusZ(''), []);
});

// --- parseCommitLog: unit-separated `git log --format` records -------------

test('parseCommitLog: fields split on the unit separator', () => {
  const US = '\x1f';
  const out =
    ['abc123full', 'abc123', 'fix: the thing', 'Ada', '3 days ago', '1700000000'].join(US) +
    '\n' +
    ['def456full', 'def456', 'feat: a thing', 'Bob', '5 days ago', '1699000000'].join(US) +
    '\n';
  assert.deepEqual(parseCommitLog(out), [
    { sha: 'abc123full', shortSha: 'abc123', subject: 'fix: the thing', author: 'Ada', date: '3 days ago', timestamp: 1700000000, refs: [] },
    { sha: 'def456full', shortSha: 'def456', subject: 'feat: a thing', author: 'Bob', date: '5 days ago', timestamp: 1699000000, refs: [] },
  ]);
});

test('parseCommitLog: subject keeps spaces; empty input', () => {
  const US = '\x1f';
  const [c] = parseCommitLog(['h', 'h', 'a subject with spaces', 'X', 'now', '0', ''].join(US));
  assert.equal(c.subject, 'a subject with spaces');
  assert.deepEqual(c.refs, []);
  assert.deepEqual(parseCommitLog(''), []);
});

test('parseCommitLog: classifies the `%D` decoration into branch/remote/tag refs', () => {
  const US = '\x1f';
  // The HEAD commit's decoration as `git log --decorate=full --format=%D` prints it:
  // the checked-out branch (HEAD -> …), a remote, the symbolic origin/HEAD, another
  // local branch, and a tag — all fully qualified.
  const decoration =
    'HEAD -> refs/heads/master, refs/remotes/origin/master, refs/remotes/origin/HEAD, ' +
    'refs/heads/feat/x, refs/tags/v1.2.0';
  const [c] = parseCommitLog(['h', 'h', 's', 'A', 'now', '0', decoration].join(US));
  assert.deepEqual(c.refs, [
    { name: 'master', kind: 'branch', head: true },
    { name: 'origin/master', kind: 'remote', head: false },
    // origin/HEAD (the symbolic default-branch pointer) is dropped as noise.
    { name: 'feat/x', kind: 'branch', head: false },
    { name: 'v1.2.0', kind: 'tag', head: false },
  ]);
});

test('parseCommitLog: a detached HEAD decorates as a bare HEAD ref', () => {
  const US = '\x1f';
  const [c] = parseCommitLog(['h', 'h', 's', 'A', 'now', '0', 'HEAD, refs/tags/v2'].join(US));
  assert.deepEqual(c.refs, [
    { name: 'HEAD', kind: 'head', head: true },
    { name: 'v2', kind: 'tag', head: false },
  ]);
});

// --- parseCommitFiles: RS-delimited `git log --name-only` records -----------

test('parseCommitFiles: maps each sha to its changed paths', () => {
  const RS = '\x1e';
  // A merge commit (no files), then a commit with a blank line before its files.
  const out =
    `${RS}merge000\n` +
    `${RS}abc123\n\nsrc/a.ts\nsrc/b.ts\n` +
    `${RS}def456\n\ndocs/readme.md\n`;
  const map = parseCommitFiles(out);
  assert.deepEqual(map.get('merge000'), []);
  assert.deepEqual(map.get('abc123'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(map.get('def456'), ['docs/readme.md']);
  assert.deepEqual(parseCommitFiles(''), new Map());
});
