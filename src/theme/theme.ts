/*
 * Theme — loads a theme authored in *our own* format (a format we own; see
 * theme.schema.json) and normalizes it into the small internal shape the editor
 * consumes (UI chrome colors + a flat syntax capture → color map). Themes live as
 * JSON next to this module (e.g. quilx.json), are loaded through `loadTheme`, and
 * the active theme is exported as `theme`. See tasks/theming.md.
 *
 * On disk a theme is one file: `{ name, appearance, ui, syntax }`. `ui` is a flat
 * map of CONCERN-first dotted keys (`status.error`, `search.match`,
 * `diff.added.word`) → color, resolved by longest-prefix fallback (the same
 * `resolveByCaptureName` the syntax map uses) so a key falls back within its
 * concern; `syntax` maps a tree-sitter capture name → a color + optional font
 * style. `loadTheme` resolves each `UiColors` field (filling gaps from
 * `DEFAULT_UI`), derives the diff tints, and splits the syntax tokens.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { alpha as withAlpha, darken, formatHEXA, lighten, parse } from 'color-bits';

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
   * highlight in pickers (theme key `text.accent`).
   */
  textAccent: string;
  /**
   * Background tint for editor search matches: every match (`searchMatch`) and
   * the current one (`searchMatchCurrent`). `#rrggbbaa` so it composes over the
   * syntax-colored text — kept dim on purpose so the text stays readable. Theme
   * keys `search.match` and `search.match.current` (current falls back to match).
   */
  searchMatch: string;
  searchMatchCurrent: string;
  /** Semantic text colors for status/feedback (theme `status.*` keys). */
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
 * capture names the highlight queries emit (see syntax/grammar.ts). Dotted
 * captures resolve by longest-prefix fallback in the highlighter
 * (syntax-controller's resolveTag): e.g. @keyword.control reuses `keyword`;
 * @type.builtin reuses `type`. Only list a dotted key to give it a *distinct* color.
 *
 * KEY ORDER MATTERS: one GtkTextTag is created per entry in the theme's `syntax`
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
 * from each theme `syntax` token's style fields plus built-in `markup.*` defaults.
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

// --- Theme file (on disk) --------------------------------------------------

/**
 * One `syntax` entry: a foreground `color` plus optional per-capture font style.
 * The loader splits these into the internal `SyntaxColors` + `SyntaxStyles` maps.
 */
interface ThemeSyntaxToken {
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  /** Relative font size (1 = normal); e.g. 1.5 for an h1 heading. */
  scale?: number;
  /** Text-only background (inline code). */
  background?: string;
  /** Full-line (paragraph) background — block code. */
  lineBackground?: string;
}

/**
 * The on-disk theme — a format we own (see theme.schema.json). `ui` is a flat map
 * of concern-first dotted keys → color, resolved by longest-prefix fallback so an
 * unset key falls back within its concern (`search.match.current` → `search.match`,
 * `diff.added.word` → `diff.added`) and finally to `DEFAULT_UI` — never across to a
 * wrong primitive. `syntax` key order drives tag priority (see SyntaxColors).
 */
interface ThemeFile {
  name: string;
  appearance: 'light' | 'dark';
  ui?: Record<string, string>;
  syntax?: Record<string, ThemeSyntaxToken>;
}

/*
 * Resolved fallbacks for every UI color, applied at load time so the rest of the
 * app never needs an inline color literal — the theme module is the single source
 * of color. A theme's own values always win; these fill only what it omits. `fg`
 * defaults to white. (`bg` has no default: its absence is the
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
  // diffAdded/Removed (line + word) backgrounds are not listed here: they're
  // DERIVED from success/error per appearance at load time (see diffTones). Only
  // the neutral (hue-less) diff tints have fixed fallbacks.
  diffFillerBg: '#88888820',
  diffFoldBg: '#8888882e',
  prOpen: '#3fb950',
  prMerged: '#a371f7',
  prClosed: '#f85149',
} as const;

/** Load the owned theme `<name>.json` from next to this module. */
export function loadTheme(name: string): Theme {
  const file = Path.join(import.meta.dirname, `${name}.json`);
  return adaptTheme(JSON.parse(Fs.readFileSync(file, 'utf8')) as ThemeFile);
}

/**
 * Derive the diff line/word background tints from the theme's success/error
 * accents, toned by `appearance`: a dark theme DARKENS the accent into a recessed
 * band that reads on a dark editor; a light theme LIGHTENS it into a pale band on
 * a light editor. Line tints are more muted and more translucent; word tints share
 * the hue but are stronger, so changed words stand out within the line. All are
 * `#rrggbbaa` so they compose over syntax colors (see TextDecorations).
 */
function diffTones(
  success: string,
  error: string,
  appearance: 'light' | 'dark',
): Pick<UiColors, 'diffAddedBg' | 'diffRemovedBg' | 'diffAddedWordBg' | 'diffRemovedWordBg'> {
  const mute = appearance === 'dark' ? darken : lighten;
  const line = (c: string): string => formatHEXA(withAlpha(mute(parse(c), 0.25), 0.18));
  const word = (c: string): string => formatHEXA(withAlpha(mute(parse(c), 0.2), 0.3));
  return {
    diffAddedBg: line(success),
    diffRemovedBg: line(error),
    diffAddedWordBg: word(success),
    diffRemovedWordBg: word(error),
  };
}

/**
 * Normalize an on-disk `ThemeFile` into the internal `Theme` the app consumes:
 * resolve every `UiColors` field from the concern-first `ui` map (longest-prefix
 * fallback, then `DEFAULT_UI`), derive the diff tints, and split each `syntax`
 * token into the color + style maps. Exported for tests.
 */
export function adaptTheme(file: ThemeFile): Theme {
  if (file.appearance !== 'light' && file.appearance !== 'dark') {
    throw new Error(`theme "${file.name ?? '?'}": appearance must be "light" or "dark"`);
  }

  // Resolve a concern-first UI key by longest-prefix fallback within its concern
  // (e.g. `search.match.current` → `search.match` → `search`). Undefined when even
  // the concern root is unset, so the caller falls back to DEFAULT_UI.
  const uiMap = file.ui ?? {};
  const get = (key: string): string | undefined => resolveByCaptureName(key, (k) => uiMap[k]);

  // success/error drive the diff tints, so resolve them (with their fallbacks)
  // before building `ui`; the diff.* keys still win where a theme sets them.
  const success = get('status.success') ?? DEFAULT_UI.success;
  const error = get('status.error') ?? DEFAULT_UI.error;
  const diff = diffTones(success, error, file.appearance);

  // Preserve `syntax` key order — it drives tag priority (see SyntaxColors).
  const syntax: SyntaxColors = {};
  const syntaxStyle: SyntaxStyles = {};
  for (const [capture, token] of Object.entries(file.syntax ?? {})) {
    if (token && typeof token.color === 'string') syntax[capture] = token.color;
    const s: SyntaxStyle = {};
    if (token?.bold) s.bold = true;
    if (token?.italic) s.italic = true;
    if (token?.underline) s.underline = true;
    if (token?.strikethrough) s.strikethrough = true;
    if (typeof token?.scale === 'number') s.scale = token.scale;
    if (typeof token?.background === 'string') s.background = token.background;
    if (typeof token?.lineBackground === 'string') s.lineBackground = token.lineBackground;
    if (Object.keys(s).length > 0) syntaxStyle[capture] = s;
  }

  const ui: UiColors = {
    fg: get('editor.foreground') ?? DEFAULT_UI.fg,
    bg: get('editor.background'), // optional: absent ⇒ follow system scheme
    lineNumber: get('editor.lineNumber') ?? DEFAULT_UI.lineNumber,
    border: get('border') ?? DEFAULT_UI.border,
    popoverBg: get('surface.popover') ?? DEFAULT_UI.popoverBg,
    selectedBg: get('surface.selected') ?? DEFAULT_UI.selectedBg,
    textMuted: get('text.muted') ?? DEFAULT_UI.textMuted,
    textAccent: get('text.accent') ?? DEFAULT_UI.textAccent,
    searchMatch: get('search.match') ?? DEFAULT_UI.searchMatch,
    searchMatchCurrent: get('search.match.current') ?? DEFAULT_UI.searchMatchCurrent,
    success,
    warning: get('status.warning') ?? DEFAULT_UI.warning,
    error,
    info: get('status.info') ?? DEFAULT_UI.info,
    hint: get('status.hint') ?? DEFAULT_UI.hint,
    shadow: get('shadow') ?? DEFAULT_UI.shadow,
    flash: get('flash') ?? DEFAULT_UI.flash,
    diffAddedBg: get('diff.added') ?? diff.diffAddedBg,
    diffRemovedBg: get('diff.removed') ?? diff.diffRemovedBg,
    diffAddedWordBg: get('diff.added.word') ?? diff.diffAddedWordBg,
    diffRemovedWordBg: get('diff.removed.word') ?? diff.diffRemovedWordBg,
    diffFillerBg: get('diff.filler') ?? DEFAULT_UI.diffFillerBg,
    diffFoldBg: get('diff.fold') ?? DEFAULT_UI.diffFoldBg,
    prOpen: get('pr.open') ?? DEFAULT_UI.prOpen,
    prMerged: get('pr.merged') ?? DEFAULT_UI.prMerged,
    prClosed: get('pr.closed') ?? DEFAULT_UI.prClosed,
  };

  applyMarkupDefaults(syntax, syntaxStyle, ui);
  return { name: file.name, appearance: file.appearance, ui, syntax, syntaxStyle };
}

/**
 * Fill in defaults for the `markup.*` captures (Markdown headings/emphasis/code/…)
 * that text-mostly themes don't define. Colors reuse the loaded palette so they
 * stay theme-consistent; styles give markup its visual hallmarks. Existing theme
 * entries always win (we only set what's missing).
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
