/*
 * Theme — loads themes authored in Zed's theme format and adapts them to the
 * small internal shape the editor consumes (UI chrome colors + a flat syntax
 * capture → color map). Themes live as JSON next to this module (e.g.
 * quilx.json) and are loaded through `loadTheme`; the active theme is exported
 * as `theme`.
 *
 * On disk a file is a Zed *theme family*: `{ name, author, themes: [...] }`
 * where each entry is a light/dark variant with a flat `style` object (dotted
 * keys like `editor.foreground`) and a nested `style.syntax` map. We pick a
 * variant and normalize it: `editor.*` → `ui`, and each `style.syntax[cap].color`
 * → `syntax[cap]`. Keeping the consumed shape minimal means the rest of the app
 * is unaffected by Zed's much larger key set (workspace chrome, terminal ANSI …).
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';

// --- Internal (consumed) shape ---------------------------------------------

/** UI / editor chrome colors. */
export interface UiColors {
  /** Default editor text foreground. */
  fg: string;
  /**
   * Editor background. When set, the theme owns the full GtkSourceView style
   * scheme (background + line numbers, which GtkSourceView reads only from the
   * scheme); when omitted, the editor follows the system light/dark Adwaita
   * scheme. See createSourceScheme / TextEditor.followSystemColorScheme.
   */
  bg?: string;
  /** Line-number gutter foreground. */
  lineNumber: string;
  /** Separator/border color for chrome (e.g. the header bar's bottom edge). */
  border: string;
  /** Background of elevated surfaces: pickers, popovers, autocomplete, menus. */
  popoverBg: string;
  /** Background of a selected entry (file tree row, picker result, list item). */
  selectedBg: string;
  /** De-emphasized text (secondary labels, subtitles). */
  textMuted: string;
  /**
   * Accent foreground for emphasized text — used for the matched-character
   * highlight in pickers (the role Zed's `text.accent` plays in its fuzzy finders).
   */
  textAccent: string;
  /**
   * Background tint for editor search matches: every match (`searchMatch`) and
   * the current one (`searchMatchCurrent`). `#rrggbbaa` so it composes over the
   * syntax-colored text — kept dim on purpose so the text stays readable. From
   * Zed's `search.match_background` (current adds our `…background.current`).
   */
  searchMatch: string;
  searchMatchCurrent: string;
  /** Semantic text colors for status/feedback (Zed's status keys). */
  success: string;
  warning: string;
  error: string;
  info: string;
  hint: string;
  /** Drop-shadow color for floating surfaces (popovers, toasts, cards). */
  shadow: string;
  /** Brief flash tint over an operated/yanked range (vim). `#rrggbbaa`. */
  flash: string;
  /** Diff line/word background tints (`#rrggbbaa`, compose over syntax colors). */
  diffAddedBg: string;
  diffRemovedBg: string;
  diffAddedWordBg: string;
  diffRemovedWordBg: string;
  diffFillerBg: string;
  diffFoldBg: string;
  /** GitHub pull-request state colors (open / merged / closed). */
  prOpen: string;
  prMerged: string;
  prClosed: string;
}

/*
 * Syntax colors: capture name → foreground color, keyed by the tree-sitter
 * capture names Zed's queries emit (see syntax/grammar.ts). Dotted captures
 * resolve by longest-prefix fallback in the highlighter (syntax-controller's
 * resolveTag): e.g. @keyword.control reuses `keyword`; @type.builtin reuses
 * `type`. Only list a dotted key to give it a *distinct* color.
 *
 * KEY ORDER MATTERS: one GtkTextTag is created per entry in `style.syntax`'s
 * JSON order, and tag priority follows creation order (later = higher). A node
 * can match several patterns at once, and all matching tags apply — priority
 * decides the winner. So more-specific / should-win categories come LAST:
 * escapes after `string`; `tag` before `type`; `property` before `function`.
 */
export type SyntaxColors = Record<string, string>;

/**
 * Per-capture font *style* (beyond foreground color): the attributes a GtkTextTag
 * can carry that make markup look like markup — bold/italic/strikethrough/underline,
 * a relative font `scale` (bigger headings), and a `background` (code). Sparse and
 * keyed by capture name like `syntax`, with the same longest-prefix fallback. Comes
 * from the Zed theme's `font_weight`/`font_style` plus built-in `markup.*` defaults.
 */
export interface SyntaxStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** Relative font size (1 = normal); e.g. 1.1 for headings. */
  scale?: number;
  /** Text-only background (inline code). */
  background?: string;
  /** Full-line (paragraph) background — block code. */
  lineBackground?: string;
}

export type SyntaxStyles = Record<string, SyntaxStyle>;

export interface Theme {
  name: string;
  appearance: 'light' | 'dark';
  ui: UiColors;
  syntax: SyntaxColors;
  /** Per-capture font styling (bold/italic/scale/background/…). */
  syntaxStyle: SyntaxStyles;
}

// --- Zed theme format (on disk) --------------------------------------------

interface ZedSyntaxStyle {
  color?: string;
  font_style?: string;
  font_weight?: number;
}

interface ZedTheme {
  name: string;
  appearance: 'light' | 'dark';
  /** Flat dotted color keys plus the nested `syntax` map. */
  style: Record<string, unknown> & { syntax?: Record<string, ZedSyntaxStyle> };
}

interface ZedThemeFamily {
  name: string;
  author?: string;
  themes: ZedTheme[];
}

/*
 * Resolved fallbacks for every UI color, applied at load time so the rest of the
 * app never needs an inline color literal — the theme module is the single source
 * of color. A theme's own values (from its Zed JSON) always win; these fill only
 * what it omits. `fg` defaults to white. (`bg` has no default: its absence is the
 * signal to follow the system light/dark scheme — see UiColors.bg.)
 */
const DEFAULT_UI = {
  fg: '#ffffff',
  lineNumber: '#888888',
  border: 'rgba(0, 0, 0, 0.3)',
  popoverBg: '#1e1e1e',
  selectedBg: 'rgba(127, 127, 127, 0.25)',
  textMuted: '#9a9996',
  textAccent: '#c678dd',
  searchMatch: '#e5a50a26',
  searchMatchCurrent: '#e5a50a59',
  success: '#2ec27e',
  warning: '#e5a50a',
  error: '#e01b24',
  info: '#3584e4',
  hint: '#33d17a',
  shadow: 'rgba(0, 0, 0, 0.3)',
  flash: '#f5c21188',
  diffAddedBg: '#2ec27e26',
  diffRemovedBg: '#e01b2426',
  diffAddedWordBg: '#2ec27e66',
  diffRemovedWordBg: '#e01b2466',
  diffFillerBg: '#88888820',
  diffFoldBg: '#8888882e',
  prOpen: '#3fb950',
  prMerged: '#a371f7',
  prClosed: '#f85149',
} as const;

/**
 * Load a theme from `<name>.json` (a Zed theme family). `variant` selects a
 * theme by its name; the first variant is used by default.
 */
export function loadTheme(name: string, variant?: string): Theme {
  const file = Path.join(import.meta.dirname, `${name}.json`);
  const family = JSON.parse(Fs.readFileSync(file, 'utf8')) as ZedThemeFamily;

  const zed = variant
    ? family.themes.find((t) => t.name === variant)
    : family.themes[0];
  if (!zed) throw new Error(`theme "${name}" has no variant ${variant ? `"${variant}"` : ''}`);

  return adaptZedTheme(zed);
}

function adaptZedTheme(zed: ZedTheme): Theme {
  const style = zed.style;
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = style[key];
      if (typeof value === 'string') return value;
    }
    return undefined;
  };

  // Preserve `style.syntax` key order — it drives tag priority (see SyntaxColors).
  const syntax: SyntaxColors = {};
  const syntaxStyle: SyntaxStyles = {};
  for (const [capture, token] of Object.entries(style.syntax ?? {})) {
    if (token && typeof token.color === 'string') syntax[capture] = token.color;
    // Carry the theme's own per-capture bold/italic (Zed drops nothing now).
    const s: SyntaxStyle = {};
    if (typeof token?.font_weight === 'number' && token.font_weight >= 700) s.bold = true;
    if (token?.font_style === 'italic') s.italic = true;
    if (s.bold || s.italic) syntaxStyle[capture] = s;
  }

  const ui: UiColors = {
    fg: pick('editor.foreground', 'foreground') ?? DEFAULT_UI.fg,
    bg: pick('editor.background', 'background'), // optional: absent ⇒ follow system scheme
    lineNumber: pick('editor.line_number', 'editor.gutter.foreground') ?? DEFAULT_UI.lineNumber,
    border: pick('border', 'border.variant') ?? DEFAULT_UI.border,
    popoverBg: pick('elevated_surface.background', 'surface.background', 'background') ?? DEFAULT_UI.popoverBg,
    selectedBg: pick('element.selected', 'ghost_element.selected') ?? DEFAULT_UI.selectedBg,
    textMuted: pick('text.muted') ?? DEFAULT_UI.textMuted,
    textAccent: pick('text.accent', 'text.accent.emphasis', 'accent') ?? DEFAULT_UI.textAccent,
    searchMatch: pick('search.match_background') ?? DEFAULT_UI.searchMatch,
    searchMatchCurrent:
      pick('search.match_background.current', 'search.match_background') ?? DEFAULT_UI.searchMatchCurrent,
    success: pick('success') ?? DEFAULT_UI.success,
    warning: pick('warning') ?? DEFAULT_UI.warning,
    error: pick('error') ?? DEFAULT_UI.error,
    info: pick('info') ?? DEFAULT_UI.info,
    hint: pick('hint') ?? DEFAULT_UI.hint,
    shadow: pick('shadow') ?? DEFAULT_UI.shadow,
    flash: pick('editor.flash') ?? DEFAULT_UI.flash,
    diffAddedBg: pick('diff.added_background') ?? DEFAULT_UI.diffAddedBg,
    diffRemovedBg: pick('diff.removed_background') ?? DEFAULT_UI.diffRemovedBg,
    diffAddedWordBg: pick('diff.added_word_background') ?? DEFAULT_UI.diffAddedWordBg,
    diffRemovedWordBg: pick('diff.removed_word_background') ?? DEFAULT_UI.diffRemovedWordBg,
    diffFillerBg: pick('diff.filler_background') ?? DEFAULT_UI.diffFillerBg,
    diffFoldBg: pick('diff.fold_background') ?? DEFAULT_UI.diffFoldBg,
    prOpen: pick('vcs.pr.open') ?? DEFAULT_UI.prOpen,
    prMerged: pick('vcs.pr.merged') ?? DEFAULT_UI.prMerged,
    prClosed: pick('vcs.pr.closed') ?? DEFAULT_UI.prClosed,
  };

  applyMarkupDefaults(syntax, syntaxStyle, ui);
  return { name: zed.name, appearance: zed.appearance, ui, syntax, syntaxStyle };
}

/**
 * Fill in defaults for the `markup.*` captures (Markdown headings/emphasis/code/…)
 * that text-mostly themes like Zed's don't define. Colors reuse the loaded palette
 * so they stay theme-consistent; styles give markup its visual hallmarks. Existing
 * theme entries always win (we only set what's missing).
 */
function applyMarkupDefaults(syntax: SyntaxColors, syntaxStyle: SyntaxStyles, ui: UiColors): void {
  const colorDefaults: SyntaxColors = {
    'markup.heading': syntax.function ?? syntax.keyword ?? ui.fg,
    'markup.link': syntax.function ?? ui.textAccent ?? ui.fg,
    'markup.link.url': syntax.string ?? syntax.comment ?? ui.fg,
    'markup.raw': syntax.string ?? ui.fg,
    'markup.list': syntax.punctuation ?? syntax.operator ?? ui.fg,
    'markup.quote': syntax.comment ?? ui.textMuted ?? ui.fg,
  };
  for (const [cap, color] of Object.entries(colorDefaults)) {
    if (color && syntax[cap] === undefined) syntax[cap] = color;
  }

  const styleDefaults: SyntaxStyles = {
    // Headings are bold and larger, scaled per level (h1 biggest). `scale` changes
    // the line's height, which is safe for vim display-line motion (j/k, gj/gk):
    // `displayLineMove` moves by display row via the view's layout, so a normal
    // glyph (the unscaled `##` markers) on a taller heading line still steps off it.
    // Colors inherit `markup.heading` via prefix fallback (resolveSyntaxColor).
    'markup.heading': { bold: true, scale: 1.2 }, // setext / generic fallback
    'markup.heading.1': { bold: true, scale: 1.5 },
    'markup.heading.2': { bold: true, scale: 1.2 },
    'markup.heading.3': { bold: true, scale: 1.1 },
    'markup.heading.4': { bold: true, scale: 1.1 },
    'markup.heading.5': { bold: true, scale: 1.1 },
    'markup.heading.6': { bold: true, scale: 1.1 },
    'markup.strong': { bold: true },
    'markup.emphasis': { italic: true },
    'markup.strikethrough': { strikethrough: true },
    'markup.link': { underline: true },
    'markup.quote': { italic: true },
    // Inline code → text-only background; block code (fences) → full-line background.
    ...(ui.popoverBg ? {
      'markup.raw': { background: ui.popoverBg },
      'markup.raw.block': { lineBackground: ui.popoverBg },
    } : {}),
  };
  for (const [cap, style] of Object.entries(styleDefaults)) {
    syntaxStyle[cap] = { ...style, ...syntaxStyle[cap] };
  }
}

/** The active theme. */
export const theme = loadTheme('quilx');

/**
 * Resolve a tree-sitter capture name against `lookup` by longest-prefix fallback:
 * try the full dotted name, then progressively drop the trailing `.segment` (so
 * `markup.heading.1` falls back to `markup.heading`, then `markup`). Returns the
 * first defined hit, else undefined. The shared primitive behind the capture →
 * color / style / tag resolutions (resolveSyntaxColor, resolveSyntaxStyle, and
 * the highlighter's per-capture tag lookup).
 */
export function resolveByCaptureName<T>(name: string, lookup: (key: string) => T | undefined): T | undefined {
  let key: string | undefined = name;
  while (key) {
    const hit = lookup(key);
    if (hit !== undefined) return hit;
    const dot = key.lastIndexOf('.');
    key = dot === -1 ? undefined : key.slice(0, dot);
  }
  return undefined;
}

/** A capture's foreground color in the active theme, by longest-prefix fallback
 *  (e.g. `markup.heading.1` inherits `markup.heading`'s color). */
export function resolveSyntaxColor(name: string): string | undefined {
  return resolveByCaptureName(name, (key) => theme.syntax[key]);
}

/** A capture's font style in the active theme, by longest-prefix fallback (like
 *  resolveSyntaxColor). */
export function resolveSyntaxStyle(name: string): SyntaxStyle | undefined {
  return resolveByCaptureName(name, (key) => theme.syntaxStyle[key]);
}
