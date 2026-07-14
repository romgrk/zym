import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import Gtk from 'gi:Gtk-4.0';
import { zym } from '../../zym.ts';
import { Document } from './Document.ts';

// Document wraps GtkSource buffers, so GTK must be initialized (idempotent).
Gtk.init();
// No language servers in this headless test.
zym.lsp.configure({ enable: false });

function tempFile(contents: string): string {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'zym-diskwatch-'));
  const file = Path.join(dir, 'target.ts');
  Fs.writeFileSync(file, contents);
  return file;
}
const viewText = (v: any): string => v.buffer.getText(v.buffer.getStartIter(), v.buffer.getEndIter(), true);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The disk watch (chokidar) must catch an agent's "delete then rewrite the file", which a bare
// `Gio.FileMonitor` bound to the file's inode drops once the inode is gone. This runs under
// `node --test`, which never pumps the GLib main loop — chokidar rides Node's own event loop, so it
// still fires here, whereas a `Gio.FileMonitor` would not: the test pins the chokidar behavior.
test('a delete+recreate on disk reloads the buffer', async () => {
  const file = tempFile('export const x = 1\n');
  const doc = new Document();
  doc.loadFile(file);
  const view = doc.createView();
  assert.equal(doc.getText(), 'export const x = 1\n');
  await sleep(400); // let chokidar establish its watch

  // The agent's "delete then set content": two syscalls (chokidar reports it as one `change`).
  Fs.unlinkSync(file);
  Fs.writeFileSync(file, 'export const x = 2\n');

  await sleep(1200);
  assert.equal(doc.getText(), 'export const x = 2\n', 'model reloaded from disk');
  assert.equal(viewText(view), 'export const x = 2\n', 'view mirrored the reload');
  assert.equal(doc.hasDiskChange(), false, 'disk state settled back to synced');

  doc.dispose();
  Fs.rmSync(Path.dirname(file), { recursive: true, force: true });
});

// An unsaved edit must NOT be silently overwritten by the backstop — it flags the conflict instead.
test('the backstop flags a conflict (no clobber) when the buffer is modified', async () => {
  const file = tempFile('original\n');
  const doc = new Document();
  doc.loadFile(file);
  doc.createView();
  await sleep(400); // let chokidar establish its watch
  doc.transact(() => {
    const b = doc.modelBuffer;
    b.insert(b.getStartIter(), 'LOCAL ', -1); // unsaved local edit → modified
  });
  assert.equal(doc.isModified(), true);

  Fs.writeFileSync(file, 'changed-on-disk\n');
  await sleep(1200);

  assert.ok(doc.getText().startsWith('LOCAL'), 'local edit preserved (not clobbered)');
  assert.equal(doc.hasDiskChange(), true, 'external change surfaced as a conflict');

  doc.dispose();
  Fs.rmSync(Path.dirname(file), { recursive: true, force: true });
});
