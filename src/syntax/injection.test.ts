/*
 * End-to-end test of language injection through the real SyntaxController: a
 * Markdown buffer whose fenced ```ts block must be painted with the *injected*
 * TypeScript grammar's tags (and inline `code` with the inline grammar's). This
 * exercises the whole path — plugin activation → grammar preload → detection →
 * collectCaptures (base + injected) → paintCaptures — against the vendored wasms.
 *
 * Headless: SyntaxController.setLanguageForPath runs one synchronous refresh, so
 * no main loop is needed. Skips if the Markdown grammar isn't vendored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gtk, GtkSource, Pango } from '../gi.ts';
import { plugins, registerBuiltinPlugins } from '../plugin/index.ts';
import { preloadGrammars } from './grammar.ts';
import { SyntaxController } from './SyntaxController.ts';

Gtk.init();

const HERE = Path.dirname(fileURLToPath(import.meta.url));
const hasMarkdownWasm = Fs.existsSync(
  Path.resolve(HERE, '../plugins/markdown/grammars/tree-sitter-markdown.wasm'));

function asIter(r: any): any {
  return Array.isArray(r) ? r[r.length - 1] : r;
}

test('injection: a fenced ```ts block in Markdown is painted by the TypeScript grammar',
  { skip: !hasMarkdownWasm && 'Markdown grammar not vendored' },
  async () => {
    registerBuiltinPlugins();
    await plugins.activateAll(); // contributes the markdown + typescript grammars
    await preloadGrammars();

    const md = '# Title\n\nSome **bold** and `code`.\n\n```ts\nconst answer = 42\n```\n';
    const tmp = Path.join(Os.tmpdir(), `zym-inj-${process.pid}.md`);
    Fs.writeFileSync(tmp, md);

    const buffer = new GtkSource.Buffer();
    buffer.setText(md, -1);
    const view = new GtkSource.View({ buffer });
    const syntax = new SyntaxController(view, buffer, { folding: false });

    // setLanguageForPath runs one synchronous refresh (parse + inject + paint).
    assert.equal(syntax.setLanguageForPath(tmp), true);

    const tagTable = buffer.getTagTable();
    const keywordTag = tagTable.lookup('ts:keyword');
    assert.ok(keywordTag, 'the keyword tag should exist');

    // `const` inside the fence must carry the keyword tag — only the injected
    // TypeScript grammar produces it; the Markdown grammar never would.
    const at = md.indexOf('const') + 2; // mid-token, away from the boundary
    const iter = asIter(buffer.getIterAtOffset(at));
    assert.ok(iter.hasTag(keywordTag), 'injected TypeScript keyword tag should paint `const`');

    // Styled tags (not just color): `**bold**` (via the inline grammar injection)
    // must carry the shared bold decoration tag, which is genuinely bold weight.
    const boldTag = tagTable.lookup('ts*bold');
    assert.ok(boldTag, 'the bold decoration tag should exist');
    assert.equal(boldTag.weight, Pango.Weight.BOLD, 'the bold tag should be bold weight');
    const boldAt = md.indexOf('bold') + 1;
    const boldIter = asIter(buffer.getIterAtOffset(boldAt));
    assert.ok(boldIter.hasTag(boldTag), 'bold text should carry the bold decoration tag');

    // Fenced code gets a full-line (paragraph) background that layers *under* the
    // injected token colors: the `const` position carries both a paragraph-bg tag
    // and the keyword color, while a heading line outside the fence carries none.
    const hasParagraphBg = (it: any): boolean =>
      (it.getTags() as any[]).some((t) => t.paragraphBackgroundSet === true);
    assert.ok(hasParagraphBg(iter), 'fenced code should have a full-line background');
    const headingIter = asIter(buffer.getIterAtOffset(md.indexOf('Title')));
    assert.ok(!hasParagraphBg(headingIter), 'a non-code line should have no line background');

    Fs.unlinkSync(tmp);
  });

// Regression: the vendored Markdown grammar wasm imports libc symbols (towlower,
// strcmp, __assert_fail) that the pinned web-tree-sitter runtime doesn't provide.
// `initTreeSitter` shims them; without the shims, the external scanner's
// `parse_html_block` calls an undefined import the moment markdown contains an
// HTML block (`<...>`), throwing "Cannot read properties of undefined (reading
// 'apply')" out of `parse` → the file opens with no highlighting at all (and a
// later incremental edit faults the wasm with "memory access out of bounds").
test('injection: HTML-block markdown highlights (grammar libc shims present)',
  { skip: !hasMarkdownWasm && 'Markdown grammar not vendored' },
  async () => {
    try { registerBuiltinPlugins(); } catch { /* already registered by an earlier test in this file */ }
    await plugins.activateAll();
    await preloadGrammars();

    // `<span>` / autolink `<https://…>` drive the scanner's parse_html_block, which
    // lowercases tag-name chars via towlower — the missing import that used to crash.
    const md = [
      '# Styling',
      '',
      'Inline `<span ...>` runs and an autolink <https://example.com> here.',
      '',
      '<div class="note">a raw HTML block</div>',
      '',
      'A **bold** word after the block.',
    ].join('\n') + '\n';
    const tmp = Path.join(Os.tmpdir(), `zym-htmlblock-${process.pid}.md`);
    Fs.writeFileSync(tmp, md);

    const buffer = new GtkSource.Buffer();
    buffer.setText(md, -1);
    const view = new GtkSource.View({ buffer });
    const syntax = new SyntaxController(view, buffer, { folding: false });

    // The whole load+parse+paint runs here; before the shims this threw.
    assert.equal(syntax.setLanguageForPath(tmp), true, 'tree-sitter should handle the file');

    // It actually produced captures (the heading at least) — i.e. the parse survived
    // parse_html_block rather than aborting with an undefined-import crash.
    const counts = syntax.captureCounts();
    assert.ok((counts['markup.heading.1'] ?? 0) >= 1, 'heading should be captured');

    // And the `**bold**` after the HTML block is still reached by the inline injection.
    const boldTag = buffer.getTagTable().lookup('ts*bold');
    const boldIter = asIter(buffer.getIterAtOffset(md.indexOf('bold') + 1));
    assert.ok(boldIter.hasTag(boldTag), 'bold past the HTML block should be highlighted');

    Fs.unlinkSync(tmp);
  });
