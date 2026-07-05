/*
 * The ACP fs capability's editor side: createDocumentFs must prefer live buffers
 * over disk (reads) and land writes in the open document, and sliceLines must
 * implement fs/read_text_file's 1-based line/limit window. Documents own
 * headless GtkSource buffers, so these need GTK (same setup as Document.test.ts).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import Gtk from 'gi:Gtk-4.0';
import { DocumentRegistry } from '../../ui/TextEditor/DocumentRegistry.ts';
import { createDocumentFs } from './documentFs.ts';
import { sliceLines } from './AcpSession.ts';

Gtk.init();

let dir: string;
before(() => { dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-docfs-')); });
after(() => { Fs.rmSync(dir, { recursive: true, force: true }); });

test('read falls back to disk when the path is not open', async () => {
  const registry = new DocumentRegistry();
  const fs = createDocumentFs(registry);
  const path = Path.join(dir, 'on-disk.txt');
  Fs.writeFileSync(path, 'disk content\n');
  assert.equal(await fs.readTextFile(path), 'disk content\n');
});

test('read of a missing path throws ENOENT (→ resource_not_found)', async () => {
  const fs = createDocumentFs(new DocumentRegistry());
  await assert.rejects(
    async () => fs.readTextFile(Path.join(dir, 'nope.txt')),
    (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
  );
});

test('read returns the live buffer of an open document, not stale disk state', async () => {
  const registry = new DocumentRegistry();
  const fs = createDocumentFs(registry);
  const path = Path.join(dir, 'open.txt');
  Fs.writeFileSync(path, 'saved\n');
  const { document } = registry.acquire(path);
  document.loadFile(path);
  document.restoreUnsaved('unsaved buffer edits\n'); // a dirty buffer, never written
  assert.equal(await fs.readTextFile(path), 'unsaved buffer edits\n');
  assert.equal(Fs.readFileSync(path, 'utf8'), 'saved\n'); // disk untouched by the read
  registry.release(document);
});

test('read of a lazily-assigned (not loaded) document falls back to disk', async () => {
  const registry = new DocumentRegistry();
  const fs = createDocumentFs(registry);
  const path = Path.join(dir, 'lazy.txt');
  Fs.writeFileSync(path, 'lazy disk\n');
  const { document } = registry.acquire(path);
  document.assignPath(path); // identity only — content never read
  assert.equal(await fs.readTextFile(path), 'lazy disk\n');
  registry.release(document);
});

test('write creates the file, parent directories included', async () => {
  const fs = createDocumentFs(new DocumentRegistry());
  const path = Path.join(dir, 'a/b/new.txt');
  await fs.writeTextFile(path, 'created\n');
  assert.equal(Fs.readFileSync(path, 'utf8'), 'created\n');
});

test('write lands in the open document: buffer replaced, unmodified, disk in sync', async () => {
  const registry = new DocumentRegistry();
  const fs = createDocumentFs(registry);
  const path = Path.join(dir, 'written.txt');
  Fs.writeFileSync(path, 'before\n');
  const { document } = registry.acquire(path);
  document.loadFile(path);
  document.restoreUnsaved('user was typing here\n'); // agent write wins over a dirty buffer
  await fs.writeTextFile(path, 'agent content\n');
  assert.equal(document.getText(), 'agent content\n');
  assert.equal(document.isModified(), false);
  assert.equal(Fs.readFileSync(path, 'utf8'), 'agent content\n');
  registry.release(document);
});

test('sliceLines implements the 1-based line/limit read window', () => {
  const text = 'l1\nl2\nl3\nl4';
  assert.equal(sliceLines(text), text); // no window → whole file
  assert.equal(sliceLines(text, 2), 'l2\nl3\nl4');
  assert.equal(sliceLines(text, 2, 2), 'l2\nl3');
  assert.equal(sliceLines(text, null, 1), 'l1');
  assert.equal(sliceLines(text, 99, 5), ''); // start past EOF
  assert.equal(sliceLines(text, 1, 0), '');
});
