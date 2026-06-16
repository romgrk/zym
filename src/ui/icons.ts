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
import { Gtk, Pango } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';

export const Icons = {
  info: String.fromCodePoint(0xf05a), // info-circle
  success: String.fromCodePoint(0xf058), // check-circle
  warning: String.fromCodePoint(0xf071), // exclamation-triangle
  error: String.fromCodePoint(0xf06a), // exclamation-circle
  fatal: String.fromCodePoint(0xf057), // times-circle
  trace: String.fromCodePoint(0xf188), // bug
  close: String.fromCodePoint(0xf00d), // times
  git: String.fromCodePoint(0xf418), // git-branch (matches the header GitBranchButton)
  gitMerge: String.fromCodePoint(0xf419), // git-merge
  github: String.fromCodePoint(0xf09b), // nf-fa-github — the GitHub mark
  modified: String.fromCodePoint(0xf444), // dot-fill — unsaved/modified marker
  trash: String.fromCodePoint(0xf1f8), // nf-fa-trash — delete
  pencil: String.fromCodePoint(0xf040), // nf-fa-pencil — rename/edit
  stash: String.fromCodePoint(0xf187), // nf-fa-archive — git stash
  search: String.fromCodePoint(0xf002), // nf-fa-search — magnifying glass
  symbol: String.fromCodePoint(0xea8b), // nf-cod-symbol_namespace — "{}" go-to-symbol
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
