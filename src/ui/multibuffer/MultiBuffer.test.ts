/*
 * Multibuffer Phase 1a integration: prove the painter (SyntaxController), driven through an
 * ExcerptSyntaxProjection, paints each excerpt from ITS OWN grammar at the right (translated)
 * view rows — one painter on one buffer, many source parses. This is the place a
 * stitched-coordinate or shared-parse bug surfaces in isolation (docs/.../multibuffer.md).
 * The full SearchResultsView (a TextEditor wrapper) is exercised by the runtime smoke, which
 * needs the app's singletons. Grammars come from bundled plugins; gated if not vendored.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk, GtkSource } from '../../gi.ts';
import { plugins, registerBuiltinPlugins } from '../../plugin/index.ts';
import { preloadGrammars, getGrammar, langIdForPath } from '../../syntax/grammar.ts';
import { DocumentSyntax } from '../../syntax/DocumentSyntax.ts';
import { SyntaxController } from '../../syntax/SyntaxController.ts';
import { excerptsToItems, type Excerpt, type Segment } from './MultiBufferModel.ts';
import { CoordinatesMap } from '../TextEditor/CoordinatesMap.ts';
import { Screen } from '../TextEditor/Screen.ts';
import { buildDiffMultiBuffer } from './diffMultiBuffer.ts';
import { ExcerptSyntaxProjection } from './ExcerptSyntaxProjection.ts';

Gtk.init();

let hasJs = false;
let hasJson = false;
before(async () => {
  try { registerBuiltinPlugins(); } catch { /* already registered */ }
  await plugins.activateAll();
  await preloadGrammars();
  hasJs = !!getGrammar(langIdForPath('/x.ts') ?? '');
  hasJson = !!getGrammar(langIdForPath('/x.json') ?? '');
});

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);
const seg = (documentKey: string, startRow: number, endRow: number): Segment =>
  ({ documentKey, startRow, endRow, editable: false, kind: 'real' });

/** A parsed source over a bare buffer (the read-only-snapshot shape SearchResultsView uses). */
function source(text: string, path: string): DocumentSyntax {
  const buffer = new GtkSource.Buffer();
  buffer.setText(text, -1);
  const ds = new DocumentSyntax(buffer);
  ds.setLanguageForPath(path);
  return ds;
}

/** Build the multibuffer buffer + paint it through a projection-mode SyntaxController. */
function paintMultibuffer(excerpts: Excerpt[], lines: Record<string, string[]>, sources: Map<string, DocumentSyntax>) {
  const projection = CoordinatesMap.build(excerptsToItems(excerpts), (s) => lines[s.documentKey].slice(s.startRow, s.endRow + 1));
  const buffer = new GtkSource.Buffer();
  buffer.setText(projection.screenText, -1);
  const view = new GtkSource.View({ buffer });
  const syntax = new SyntaxController(view, buffer, {
    folding: false,
    projection: new ExcerptSyntaxProjection(() => projection, sources),
  });
  syntax.paint();
  return { buffer: buffer, projection, syntax };
}

/** Whether `token` on view row `viewRow` carries `tagName` (checked mid-token). */
function tokenHasTag(buffer: any, viewRow: number, token: string, tagName: string): boolean {
  const tag = buffer.getTagTable().lookup(tagName);
  if (!tag) return false;
  const start = asIter(buffer.getIterAtLine(viewRow));
  const end = start.copy();
  if (!end.endsLine()) end.forwardToLineEnd();
  const lineText = buffer.getText(start, end, true) as string;
  const col = lineText.indexOf(token);
  if (col < 0) return false;
  return asIter(buffer.getIterAtLineOffset(viewRow, col + 1)).hasTag(tag);
}

test('the painter paints each excerpt at its translated view rows from its own parse', () => {
  if (!hasJs) return;
  const a = source('// a\nconst aaa = 1;\nfunction fa() {}\n', '/a.ts');
  const b = source('const bbb = 2;\nlet ccc = 3;\n', '/b.ts');
  const lines: Record<string, string[]> = {
    '/a.ts': ['// a', 'const aaa = 1;', 'function fa() {}', ''],
    '/b.ts': ['const bbb = 2;', 'let ccc = 3;', ''],
  };
  const excerpts: Excerpt[] = [
    { header: 'a.ts', segments: [seg('/a.ts', 1, 2)] }, // skip the leading comment
    { header: 'b.ts', segments: [seg('/b.ts', 0, 1)] },
  ];
  const { buffer, projection } = paintMultibuffer(excerpts, lines, new Map([['/a.ts', a], ['/b.ts', b]]));
  // 0:a.ts 1:const aaa 2:function fa 3:<blank> 4:b.ts 5:const bbb 6:let ccc
  assert.equal(projection.screenText, 'a.ts\nconst aaa = 1;\nfunction fa() {}\n\nb.ts\nconst bbb = 2;\nlet ccc = 3;');

  assert.ok(tokenHasTag(buffer, 1, 'const', 'ts:keyword'), 'A: const highlighted (source row 1 → view row 1)');
  assert.ok(tokenHasTag(buffer, 2, 'function', 'ts:keyword'), 'A: function (source row 2 → view row 2)');
  // The B excerpt's source rows 0,1 are translated to view rows 5,6 — the coordinate map at work.
  assert.ok(tokenHasTag(buffer, 5, 'const', 'ts:keyword'), 'B: const (source row 0 → view row 5)');
  assert.ok(tokenHasTag(buffer, 6, 'let', 'ts:keyword'), 'B: let (source row 1 → view row 6)');
  assert.ok(tokenHasTag(buffer, 0, 'a.ts', 'mb:header'), 'header row 0 styled by the projection');
  assert.ok(tokenHasTag(buffer, 4, 'b.ts', 'mb:header'), 'header row 4 styled');
  a.dispose();
  b.dispose();
});

test('each excerpt uses its own grammar (ts keyword vs json string)', () => {
  if (!hasJs || !hasJson) return;
  const ts = source('const x = 1;\n', '/a.ts');
  const json = source('{ "const": 1 }\n', '/b.json');
  const lines: Record<string, string[]> = { '/a.ts': ['const x = 1;', ''], '/b.json': ['{ "const": 1 }', ''] };
  const excerpts: Excerpt[] = [
    { header: 'a.ts', segments: [seg('/a.ts', 0, 0)] },
    { header: 'b.json', segments: [seg('/b.json', 0, 0)] },
  ];
  const { buffer } = paintMultibuffer(excerpts, lines, new Map([['/a.ts', ts], ['/b.json', json]]));
  // 0:a.ts 1:const x = 1; 2:<blank> 3:b.json 4:{ "const": 1 }
  assert.ok(tokenHasTag(buffer, 1, 'const', 'ts:keyword'), 'ts `const` is a keyword');
  assert.ok(!tokenHasTag(buffer, 4, 'const', 'ts:keyword'), 'json `"const"` is NOT a ts keyword — own grammar');
  ts.dispose();
  json.dispose();
});

test('a Screen-backed multibuffer (the SearchResultsView path) materializes + paints', () => {
  if (!hasJs) return;
  // Mirrors SearchResultsView: a Screen over the source BUFFERS materializes the view
  // buffer; the painter highlights it through an ExcerptSyntaxProjection over the PV's map.
  const aBuf = new GtkSource.Buffer(); aBuf.setText('// a\nconst aaa = 1;\nfunction fa() {}\n', -1);
  const bBuf = new GtkSource.Buffer(); bBuf.setText('const bbb = 2;\nlet ccc = 3;\n', -1);
  const aSyn = new DocumentSyntax(aBuf); aSyn.setLanguageForPath('/a.ts');
  const bSyn = new DocumentSyntax(bBuf); bSyn.setLanguageForPath('/b.ts');
  const excerpts: Excerpt[] = [
    { header: 'a.ts', segments: [seg('/a.ts', 1, 2)] },
    { header: 'b.ts', segments: [seg('/b.ts', 0, 1)] },
  ];
  const pv = new Screen(excerptsToItems(excerpts), new Map([['/a.ts', aBuf], ['/b.ts', bBuf]]));
  const buffer = pv.buffer;
  assert.equal(
    buffer.getText(buffer.getStartIter(), buffer.getEndIter(), true),
    'a.ts\nconst aaa = 1;\nfunction fa() {}\n\nb.ts\nconst bbb = 2;\nlet ccc = 3;',
    'the PV materialized the stitched text',
  );
  const view = new GtkSource.View({ buffer: pv.buffer });
  const syntax = new SyntaxController(view, pv.buffer, {
    folding: false,
    projection: new ExcerptSyntaxProjection(() => pv.view, new Map([['/a.ts', aSyn], ['/b.ts', bSyn]])),
  });
  syntax.paint();
  assert.ok(tokenHasTag(buffer, 1, 'const', 'ts:keyword'), 'a.ts excerpt painted from its own parse');
  assert.ok(tokenHasTag(buffer, 5, 'const', 'ts:keyword'), 'b.ts excerpt painted at its translated rows');
  assert.deepEqual(pv.view.documentRowAtScreenRow(2), { documentKey: '/a.ts', documentRow: 2 }, 'navigation resolves');
  pv.dispose();
  aSyn.dispose();
  bSyn.dispose();
});

test('a multi-row capture in one excerpt does not bleed its tag into another', () => {
  if (!hasJs) return;
  // A block comment spans source rows 0..4; the first excerpt shows only rows 2..3 (inside
  // it), the second shows code rows 5..6. The comment node extends beyond the first excerpt;
  // without clamping, applying its tag across the stitched buffer would color the code
  // excerpt too (the comment-colored-constructor bug).
  const text = '/* c0\nc1\nc2\nc3\nc4 */\nconst x = 1;\nconst y = 2;\n';
  const a = source(text, '/a.ts');
  const lines: Record<string, string[]> = { '/a.ts': text.split('\n') };
  const excerpts: Excerpt[] = [{ header: 'a.ts', segments: [seg('/a.ts', 2, 3), seg('/a.ts', 5, 6)] }];
  // view: 0:a.ts 1:c2 2:c3 3:⋯ 4:const x 5:const y
  const { buffer } = paintMultibuffer(excerpts, lines, new Map([['/a.ts', a]]));
  assert.ok(tokenHasTag(buffer, 1, 'c2', 'ts:comment'), 'the comment excerpt is still comment-highlighted');
  assert.ok(!tokenHasTag(buffer, 4, 'const', 'ts:comment'), 'comment does NOT bleed into the code excerpt');
  assert.ok(tokenHasTag(buffer, 4, 'const', 'ts:keyword'), 'the code excerpt is highlighted normally');
  a.dispose();
});

test('the diff multibuffer highlights both the new (context/added) and old (removed) sides', () => {
  if (!hasJs) return;
  const oldText = 'const a = 1;\nconst removed = 2;\nconst c = 3;\n';
  const newText = 'const a = 1;\nconst added = 9;\nconst c = 3;\n';
  const dmb = buildDiffMultiBuffer([{ path: '/x.ts', oldText, newText }]);
  const newSyn = source(newText, '/x.ts');
  const oldSyn = source(oldText, '/x.ts');
  const pv = new Screen(
    dmb.items,
    new Map([['new:/x.ts', newSyn.sourceBuffer], ['old:/x.ts', oldSyn.sourceBuffer]]),
  );
  const view = new GtkSource.View({ buffer: pv.buffer });
  const syntax = new SyntaxController(view, pv.buffer, {
    folding: false,
    projection: new ExcerptSyntaxProjection(() => pv.view, new Map([['new:/x.ts', newSyn], ['old:/x.ts', oldSyn]])),
  });
  syntax.paint();
  // rows: 0 x.ts 1 const a(ctx,new) 2 const removed(removed,old) 3 const added(added,new) 4 const c(ctx,new)
  assert.ok(tokenHasTag(pv.buffer, 1, 'const', 'ts:keyword'), 'new-side context line highlighted');
  assert.ok(tokenHasTag(pv.buffer, 2, 'const', 'ts:keyword'), 'old-side removed line highlighted');
  assert.ok(tokenHasTag(pv.buffer, 3, 'const', 'ts:keyword'), 'new-side added line highlighted');
  newSyn.dispose();
  oldSyn.dispose();
});

test('the coordinate map resolves cursor rows back to source locations', () => {
  if (!hasJs) return;
  const a = source('const x = 1;\nconst y = 2;\n', '/a.ts');
  const lines: Record<string, string[]> = { '/a.ts': ['const x = 1;', 'const y = 2;', ''] };
  const excerpts: Excerpt[] = [{ header: 'a.ts', segments: [seg('/a.ts', 0, 1)] }];
  const { projection } = paintMultibuffer(excerpts, lines, new Map([['/a.ts', a]]));
  assert.equal(projection.screenToDocument(0, 0).kind, 'block', 'header row is not a source location');
  assert.deepEqual(projection.documentRowAtScreenRow(1), { documentKey: '/a.ts', documentRow: 0 }, 'first body row → source row 0');
  assert.deepEqual(projection.documentRowAtScreenRow(2), { documentKey: '/a.ts', documentRow: 1 }, 'second body row → source row 1');
  a.dispose();
});
