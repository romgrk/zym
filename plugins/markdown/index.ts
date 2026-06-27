/*
 * The Markdown plugin — zym's second plugin, and the proof that adding a
 * language is a small, isolated drop-in. Where the TypeScript plugin exercises
 * the grammar/LSP surface, this one adds detection and a config-schema
 * contribution (`markdown.*`) — the `registerConfig` surface TypeScript didn't
 * touch.
 *
 * The plugin ships no language server; Markdown features come from detection,
 * the authoring config above, and the vendored tree-sitter grammars — registered
 * below only when their wasm/query assets exist (see
 * docs/text-editor/syntax-injection.md), so a missing asset degrades to plain
 * text rather than crashing the plugin.
 */
import * as Fs from 'node:fs';
import type { Plugin, PluginContext } from '../../src/plugin/types.ts';
import type { ConfigSchema } from '../../src/util/Config.ts';
import { activateImagePreview } from './imagePreview.ts';

// File extensions detected as Markdown (drives detection + the image-preview gate).
export const MARKDOWN_FILE_TYPES = ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn', 'ronn', 'workbook'];

// Tree-sitter Markdown is a split grammar: a block grammar (document structure)
// plus an inline grammar (emphasis, links, code spans) injected into the block
// grammar's `inline` nodes, and fenced code blocks inject the fence language's
// grammar. These node types fold when multi-line.
export const MD_FOLD_TYPES = ['section', 'fenced_code_block', 'list', 'block_quote', 'pipe_table'];

// Injections for the block grammar: every `inline` span re-highlit by the inline
// grammar (static guest), and every fenced block's content re-highlit by the
// grammar its info string names (dynamic guest, resolved through the registry —
// so ```ts uses the TypeScript plugin's grammar; unknown fences stay plain).
export const MD_INJECTIONS = [
  { query: '((inline) @content)', language: 'markdown-inline' },
  { query: '(fenced_code_block (info_string (language) @language) (code_fence_content) @content)' },
  // YAML front matter (`--- … ---`). A no-op until a `yaml` grammar is registered
  // (a future YAML plugin) — the Markdown plugin deliberately doesn't own YAML.
  { query: '((minus_metadata) @content)', language: 'yaml' },
];

// Declared Markdown authoring preferences. They surface in the settings UI (which
// enumerates the config schema) and give a future Markdown formatter / editing
// command a place to read from; mirror the names markdownlint/prettier use.
const CONFIG: Record<string, ConfigSchema> = {
  'markdown.preferredHeadingStyle': {
    type: 'string',
    default: 'atx',
    enum: ['atx', 'setext'],
    description: 'Heading style to prefer: `atx` (`# Heading`) or `setext` (underlined).',
  },
  'markdown.preferredBulletMarker': {
    type: 'string',
    default: '-',
    enum: ['-', '*', '+'],
    description: 'Unordered-list bullet marker to prefer.',
  },
  'markdown.preferredEmphasisMarker': {
    type: 'string',
    default: '*',
    enum: ['*', '_'],
    description: 'Emphasis (italic) marker to prefer.',
  },
  'markdown.imagePreview': {
    type: 'boolean',
    default: true,
    description: 'Render local `![alt](src)` images inline below their line.',
  },
};

export const markdownPlugin: Plugin = {
  id: 'markdown',
  name: 'Markdown',
  description: 'Markdown: file detection, authoring preferences, and inline image preview.',

  activate(ctx: PluginContext) {
    ctx.languages.registerLanguage({
      id: 'markdown',
      fileTypes: MARKDOWN_FILE_TYPES,
      // `markdown` is already a valid LSP languageId, so no `lspId` override.
    });
    ctx.registerConfig(CONFIG);

    // Inline image preview: render `![alt](src)` images below their line.
    activateImagePreview(ctx, MARKDOWN_FILE_TYPES);

    // Tree-sitter highlighting lights up the moment the grammar assets are
    // vendored (see docs/text-editor/syntax-injection.md). Until then we
    // register no grammar, so Markdown falls back cleanly to no tree-sitter
    // highlighting — registering a grammar whose wasm is missing would throw and
    // roll back the whole plugin (losing detection + the server too).
    const block = ctx.resolve('grammars/tree-sitter-markdown.wasm');
    const inline = ctx.resolve('grammars/tree-sitter-markdown-inline.wasm');
    const blockQuery = ctx.resolve('queries/markdown/highlights.scm');
    const inlineQuery = ctx.resolve('queries/markdown-inline/highlights.scm');
    if ([block, inline, blockQuery, inlineQuery].every((p) => Fs.existsSync(p))) {
      ctx.languages.registerGrammar('markdown', {
        wasm: block,
        highlightsPath: blockQuery,
        foldTypes: MD_FOLD_TYPES,
        injections: MD_INJECTIONS,
      });
      // Injection-only grammar: no `registerLanguage` (you never open a
      // `.markdown-inline` file); the block grammar injects it by id.
      ctx.languages.registerGrammar('markdown-inline', {
        wasm: inline,
        highlightsPath: inlineQuery,
        foldTypes: [],
      });
    }
  },
};
