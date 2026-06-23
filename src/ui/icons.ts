/*
 * icons.ts — Nerd Font icon glyphs and a helper to render them.
 *
 * Project convention: all UI icons are Nerd Font glyphs from the bundled
 * "Symbols Nerd Font Mono" (see fonts.ts), rendered as text so they are
 * monochrome, follow the theme foreground via CSS `color`, and don't depend on
 * the system icon theme. Prefer this over `Gio.ThemedIcon` / `Gtk.Image(iconName)`.
 * Even Adw tab icons use a glyph embedded in the tab title (the bundled font is
 * in the default fontmap, so Pango resolves the glyph via substitution).
 *
 * Glyphs are FontAwesome/Octicon codepoints (present in the Nerd Font); file-type
 * icons live separately in fileIcons.ts.
 */
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gio, Gtk, Pango } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { NERDFONT } from './nerdfont.ts';

// Directory holding the few bundled SVG assets (vs. the Nerd Font glyphs above).
const ASSETS_DIR = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');

/**
 * Build a `Gtk.Image` from a bundled symbolic SVG (a file under assets/ whose name
 * ends in `-symbolic.svg`). Loaded as a `GtkIconPaintable`, GTK treats it as a
 * symbolic icon and recolors it to the widget's `color` — so it follows the theme
 * (and the empty-state active/idle color) like any symbolic icon, despite not
 * living in an icon theme. Unlike the rest of our icons (Nerd Font glyphs; see the
 * note above), this is a real symbolic SVG.
 */
export function symbolicImage(filename: string, pixelSize: number): InstanceType<typeof Gtk.Image> {
  const file = Gio.File.newForPath(Path.join(ASSETS_DIR, filename));
  const paintable = Gtk.IconPaintable.newForFile(file, pixelSize, 1);
  const image = Gtk.Image.newFromPaintable(paintable);
  image.setPixelSize(pixelSize);
  return image;
}

// Named UI roles mapped onto the NERDFONT catalog glyphs.
export const Icons = {
  info: NERDFONT.STATUS.INFO,
  success: NERDFONT.STATUS.SUCCESS,
  warning: NERDFONT.STATUS.WARNING,
  error: NERDFONT.STATUS.ERROR,
  fatal: NERDFONT.STATUS.FATAL,
  trace: NERDFONT.STATUS.BUG,
  close: NERDFONT.ACTION.CLOSE,
  git: NERDFONT.GIT.BRANCH, // matches the header GitBranchButton
  gitCommit: NERDFONT.GIT.COMMIT, // single-commit diff view
  gitPullRequest: NERDFONT.GIT.PULL_REQUEST, // branch-vs-base (PR-style) diff view
  gitMerge: NERDFONT.GIT.MERGE,
  github: NERDFONT.SOCIAL.GITHUB,
  modified: NERDFONT.STATUS.DOT, // unsaved/modified marker
  comment: NERDFONT.EDITOR.COMMENT, // review/comment count (continuous diff tab)
  trash: NERDFONT.ACTION.TRASH,
  pencil: NERDFONT.ACTION.EDIT, // rename/edit
  stash: NERDFONT.GIT.STASH,
  search: NERDFONT.EDITOR.SEARCH,
  folder: NERDFONT.EDITOR.FOLDER, // matches the file tree's folder glyph
  terminal: NERDFONT.EDITOR.TERMINAL, // shell / run a script
  symbol: NERDFONT.EDITOR.SYMBOL, // "{}" go-to-symbol
  server: NERDFONT.EDITOR.SERVER, // language-server status
  sidebar: NERDFONT.NAV.SIDEBAR, // sidebar toggle
  newAgent: NERDFONT.SOCIAL.USER, // "Send to new agent" picker entry
} as const;

// One shared, immutable attribute list applying the icon font (built lazily so it
// isn't created at import time, before fonts are registered).
let iconAttrs: InstanceType<typeof Pango.AttrList> | null = null;
function attrs(): InstanceType<typeof Pango.AttrList> {
  if (!iconAttrs) {
    iconAttrs = Pango.AttrList.new();
    iconAttrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));
  }
  return iconAttrs;
}

/** A Gtk.Label rendering `glyph` in the bundled Nerd Font. */
export function iconLabel(glyph: string): InstanceType<typeof Gtk.Label> {
  const label = new Gtk.Label({ label: glyph });
  label.setAttributes(attrs());
  return label;
}

/** A Pango-markup span rendering `glyph` in the icon font, optionally coloured —
 *  for inline use inside a larger markup label (vs. `iconLabel`, a standalone
 *  widget). Pass `dim` (and no `color`) for muted glyphs: dims the inherited
 *  foreground (Adwaita's muted idiom) rather than picking a grey. */
export function iconSpan(glyph: string, color?: string, dim?: boolean): string {
  const attr = color ? ` foreground="${color}"` : dim ? ` alpha="55%"` : '';
  return `<span font_family="${ICON_FONT_FAMILY}"${attr}>${glyph}</span>`;
}

// Completion-item kind → Codicon glyph (nf-cod-symbol_*), keyed by the framework's
// CompletionItem.kind strings (see createLspCompletionSource's KIND_NAMES). These
// are the same glyphs VSCode shows in its completion list.
const COMPLETION_KIND_CODEPOINTS: Record<string, number> = {
  text: 0xea93,
  method: 0xea8c,
  function: 0xea8c,
  constructor: 0xea8c,
  field: 0xeb5f,
  variable: 0xea88,
  class: 0xeb5b,
  interface: 0xeb61,
  module: 0xea8b,
  property: 0xeb65,
  unit: 0xea96,
  value: 0xea95,
  enum: 0xea95,
  keyword: 0xeb62,
  snippet: 0xeb66,
  color: 0xeb5c,
  file: 0xeb60,
  reference: 0xea94,
  folder: 0xea83,
  'enum-member': 0xeb5e,
  constant: 0xeb5d,
  struct: 0xea91,
  event: 0xea86,
  operator: 0xeb64,
  'type-parameter': 0xea92,
};
const DEFAULT_KIND_CODEPOINT = 0xea93; // symbol-misc / text as a neutral fallback

/** Nerd Font glyph for a completion item's `kind` (see `Icons`/`iconLabel`). */
export function completionKindGlyph(kind: string | undefined): string {
  return String.fromCodePoint((kind && COMPLETION_KIND_CODEPOINTS[kind]) || DEFAULT_KIND_CODEPOINT);
}

// LSP `SymbolKind` (1-based) → the kind names `completionKindGlyph` maps, so the
// workspace-symbol picker reuses the same Codicon glyphs the completion list shows.
const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: 'file', 2: 'module', 3: 'module', 4: 'module', 5: 'class', 6: 'method',
  7: 'property', 8: 'field', 9: 'constructor', 10: 'enum', 11: 'interface',
  12: 'function', 13: 'variable', 14: 'constant', 15: 'value', 16: 'value',
  17: 'value', 18: 'value', 19: 'value', 20: 'value', 21: 'value',
  22: 'enum-member', 23: 'struct', 24: 'event', 25: 'operator', 26: 'type-parameter',
};

/** Nerd Font glyph for an LSP `SymbolKind` (the workspace-symbol picker rows). */
export function symbolKindGlyph(kind: number): string {
  return completionKindGlyph(SYMBOL_KIND_NAMES[kind]);
}
