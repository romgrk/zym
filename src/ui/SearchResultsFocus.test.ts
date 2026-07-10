/*
 * SearchResultsView.focusFirstMatch — the caret lands on the first file's first search hit (used by
 * project search's `space s w` auto-run and the search box's Enter). See docs/text-editor/
 * project-search.md "Focus flow".
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import Gtk from 'gi:Gtk-4.0';
import { tmpDir as makeTmpDir } from '../util/testTmp.ts';
import { zym } from '../zym.ts';
import { plugins, registerBuiltinPlugins } from '../plugin/index.ts';
import { preloadGrammars } from '../syntax/grammar.ts';
import { SearchResultsView } from './SearchResultsView.ts';

Gtk.init();
zym.lsp.configure({ enable: false });

before(async () => {
  try { registerBuiltinPlugins(); } catch { /* already registered */ }
  await plugins.activateAll();
  await preloadGrammars();
});

function tmpFile(name: string, content: string): string {
  const dir = makeTmpDir('mbfocus');
  const p = Path.join(dir, name);
  Fs.writeFileSync(p, content);
  return p;
}

test("focusFirstMatch lands the caret on the first file's first match", () => {
  const a = tmpFile('a.ts', 'alpha\nbeta\ngamma\n');
  const b = tmpFile('b.ts', 'one\ntwo\nthree\n');
  // View: 0:alpha 1:beta 2:gamma 3:one 4:two 5:three. a.ts's match is on gamma (source row 2),
  // b.ts's on one (row 0) — the first hit is a.ts's, so the caret must land on view row 2.
  const mbv = new SearchResultsView({
    excerpts: [
      { path: a, regions: [{ startRow: 0, endRow: 2 }], matches: [{ row: 2, startCol: 0, endCol: 5 }] },
      { path: b, regions: [{ startRow: 0, endRow: 2 }], matches: [{ row: 0, startCol: 0, endCol: 3 }] },
    ],
  });
  assert.equal(mbv.editor.model.getCursorBufferPosition().row, 0, 'construction parks the caret at the top');
  assert.equal(mbv.focusFirstMatch(), true, 'there is a match to land on');
  assert.equal(mbv.editor.model.getCursorBufferPosition().row, 2, "caret on a.ts's gamma, not b.ts and not {0,0}");
  mbv.dispose();
});

test('focusFirstMatch skips files with no matches and reports none to land on', () => {
  const a = tmpFile('a.ts', 'alpha\nbeta\n');
  const mbv = new SearchResultsView({
    excerpts: [{ path: a, regions: [{ startRow: 0, endRow: 1 }] }], // regions but no match spans
  });
  assert.equal(mbv.focusFirstMatch(), false, 'no matches → nothing to focus');
  mbv.dispose();
});
