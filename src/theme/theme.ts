/*
 * Theme — loads a theme authored in *our own* format (a format we own; see
 * theme.schema.json) and normalizes it into the shape the editor consumes (nested
 * UI chrome colors + a flat syntax capture → color map). Themes live as JSON next
 * to this module (e.g. quilx.json), are loaded through `loadTheme`, and the active
 * theme is exported as `theme`. See tasks/theming.md.
 *
 * On disk a theme is one file: `{ name, appearance, ui, syntax }`, and the
 * consumed `Theme.ui` mirrors the file's `ui` shape 1:1 — concern-grouped nested
 * objects, so a theme JSON's `ui.editor.background` is read in code as exactly
 * `theme.ui.editor.background`. `syntax` maps a tree-sitter capture name → a color
 * + optional font style. `loadTheme` deep-merges the file's `ui` over `DEFAULT_THEME_UI`
 * (the built-in fallback theme), derives the diff tints, and splits the syntax
 * tokens into the color + style maps.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { alpha as withAlpha, darken, formatHEXA, lighten, parse } from 'color-bits';

// --- Internal (consumed) shape ---------------------------------------------

/**
 * UI / editor chrome colors, grouped by concern to mirror the theme JSON's `ui`
 * object 1:1 (read in code as `theme.ui.editor.background`, `theme.ui.status.error`,
 * `theme.ui.diff.addedWord`, …). Every field is filled at load from the theme file
 * over `DEFAULT_THEME_UI`, so consumers never see `undefined` — except `editor.background`.
 */
export interface ThemeUi {
  editor: {
    /** Default editor text foreground. */
    foreground: string;
    /**
     * Editor background. When set, the theme owns the full GtkSourceView style
     * scheme (background + line numbers, which GtkSourceView reads only from the
     * scheme); when omitted, the editor follows the system light/dark Adwaita
     * scheme. See createSourceScheme / TextEditor.followSystemColorScheme.
     */
    background?: string;
    /** Line-number gutter foreground. */
    lineNumber: string;
  };
  text: {
    /** De-emphasized text (secondary labels, subtitles). */
    muted: string;
    /** Accent foreground for emphasized text — the matched-character highlight in pickers. */
    accent: string;
  };
  /** Separator/border color for chrome (e.g. the header bar's bottom edge). */
  border: string;
  /** Drop-shadow color for floating surfaces (popovers, toasts, cards). */
  shadow: string;
  surface: {
    /** Background of elevated surfaces: pickers, popovers, autocomplete, menus. */
    popover: string;
    /** Background of a selected entry (file tree row, picker result, list item). */
    selected: string;
  };
  /** Semantic text colors for status/feedback. */
  status: {
    success: string;
    warning: string;
    error: string;
    info: string;
    hint: string;
  };
  /**
   * Background tint for editor search matches: every match (`match`) and the
   * current one (`matchCurrent`, which falls back to `match`). `#rrggbbaa` so it
   * composes over the syntax-colored text — kept dim so the text stays readable.
   */
  search: {
    match: string;
    matchCurrent: string;
  };
  /**
   * Diff line/word background tints (`#rrggbbaa`, compose over syntax colors). The
   * `added`/`removed` (line) + `addedWord`/`removedWord` tints are derived from
   * `status.success`/`status.error` per appearance unless the theme sets them; the
   * word tints fall back to their line tint. `filler`/`fold` are neutral.
   */
  diff: {
    added: string;
    addedWord: string;
    removed: string;
    removedWord: string;
    filler: string;
    fold: string;
  };
  /** Brief flash tint over an operated/yanked range (vim). `#rrggbbaa`. */
  flash: string;
  /** GitHub pull-request state colors. */
  pr: {
    open: string;
    merged: string;
    closed: string;
  };
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
  ui: ThemeUi;
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
 * The on-disk theme — a format we own (see theme.schema.json). Mirrors the consumed
 * `Theme` shape, but `ui` is a deep-partial of `ThemeUi` (every field optional): the
 * loader deep-merges it over `DEFAULT_THEME_UI`. `syntax` key order drives tag
 * priority (see SyntaxColors).
 */
interface ThemeFromFile {
  name: string;
  appearance: 'light' | 'dark';
  ui?: ThemeFromFileUi;
  syntax?: Record<string, ThemeSyntaxToken>;
}

/** A theme file's `ui`: the same concern groups as `ThemeUi`, each field optional. */
interface ThemeFromFileUi {
  editor?: Partial<ThemeUi['editor']>;
  text?: Partial<ThemeUi['text']>;
  border?: string;
  shadow?: string;
  surface?: Partial<ThemeUi['surface']>;
  status?: Partial<ThemeUi['status']>;
  search?: Partial<ThemeUi['search']>;
  diff?: Partial<ThemeUi['diff']>;
  flash?: string;
  pr?: Partial<ThemeUi['pr']>;
}

/*
 * The built-in fallback theme — a complete dark `ThemeUi`, structured exactly like
 * a theme file's `ui` so the rest of the app never needs an inline color literal
 * (the theme module is the single source of color). The loader deep-merges a theme
 * file's `ui` over this; a theme's own values always win. `editor.background` is the
 * one field with no default — its absence is the signal to follow the system
 * light/dark scheme (see ThemeUi.editor.background). The `diff.added`/`removed`
 * (line + word) tints are DERIVED from `status` per appearance (see diffTones); here
 * they're the dark derivation of the default status colors.
 */
const DEFAULT_THEME_UI: ThemeUi = {
  editor: { foreground: '#ffffff', lineNumber: '#888888' },
  text: { muted: '#9a9996', accent: '#c678dd' },
  border: 'rgba(0, 0, 0, 0.3)',
  shadow: 'rgba(0, 0, 0, 0.3)',
  surface: { popover: '#1e1e1e', selected: 'rgba(127, 127, 127, 0.25)' },
  status: { success: '#2ec27e', warning: '#e5a50a', error: '#e01b24', info: '#3584e4', hint: '#33d17a' },
  search: { match: '#e5a50a26', matchCurrent: '#e5a50a59' },
  diff: { ...diffTones('#2ec27e', '#e01b24', 'dark'), filler: '#88888820', fold: '#8888882e' },
  flash: '#f5c21188',
  pr: { open: '#3fb950', merged: '#a371f7', closed: '#f85149' },
};

/** Load the owned theme `<name>.json` from next to this module. */
export function loadTheme(name: string): Theme {
  const file = Path.join(import.meta.dirname, `${name}.json`);
  return adaptTheme(JSON.parse(Fs.readFileSync(file, 'utf8')) as ThemeFromFile);
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
): Pick<ThemeUi['diff'], 'added' | 'addedWord' | 'removed' | 'removedWord'> {
  const mute = appearance === 'dark' ? darken : lighten;
  const line = (c: string): string => formatHEXA(withAlpha(mute(parse(c), 0.25), 0.18));
  const word = (c: string): string => formatHEXA(withAlpha(mute(parse(c), 0.2), 0.3));
  return {
    added: line(success),
    addedWord: word(success),
    removed: line(error),
    removedWord: word(error),
  };
}

/**
 * Normalize an on-disk `ThemeFromFile` into the internal `Theme` the app consumes:
 * deep-merge the file's `ui` over `DEFAULT_THEME_UI` (concern by concern), derive the
 * diff tints, and split each `syntax` token into the color + style maps. Exported
 * for tests.
 */
export function adaptTheme(file: ThemeFromFile): Theme {
  if (file.appearance !== 'light' && file.appearance !== 'dark') {
    throw new Error(`theme "${file.name ?? '?'}": appearance must be "light" or "dark"`);
  }

  const f = file.ui ?? {};

  // status drives the diff tints, so resolve it first; the diff.* keys still win
  // where the theme sets them, and the word tints fall back to their line tint.
  const status = { ...DEFAULT_THEME_UI.status, ...f.status };
  const derived = diffTones(status.success, status.error, file.appearance);
  const diff: ThemeUi['diff'] = {
    added: f.diff?.added ?? derived.added,
    addedWord: f.diff?.addedWord ?? f.diff?.added ?? derived.addedWord,
    removed: f.diff?.removed ?? derived.removed,
    removedWord: f.diff?.removedWord ?? f.diff?.removed ?? derived.removedWord,
    filler: f.diff?.filler ?? DEFAULT_THEME_UI.diff.filler,
    fold: f.diff?.fold ?? DEFAULT_THEME_UI.diff.fold,
  };

  const ui: ThemeUi = {
    editor: { ...DEFAULT_THEME_UI.editor, ...f.editor }, // editor.background absent ⇒ follow system scheme
    text: { ...DEFAULT_THEME_UI.text, ...f.text },
    border: f.border ?? DEFAULT_THEME_UI.border,
    shadow: f.shadow ?? DEFAULT_THEME_UI.shadow,
    surface: { ...DEFAULT_THEME_UI.surface, ...f.surface },
    status,
    search: {
      match: f.search?.match ?? DEFAULT_THEME_UI.search.match,
      matchCurrent: f.search?.matchCurrent ?? f.search?.match ?? DEFAULT_THEME_UI.search.matchCurrent,
    },
    diff,
    flash: f.flash ?? DEFAULT_THEME_UI.flash,
    pr: { ...DEFAULT_THEME_UI.pr, ...f.pr },
  };

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

  applyMarkupDefaults(syntax, syntaxStyle, ui);
  return { name: file.name, appearance: file.appearance, ui, syntax, syntaxStyle };
}

/**
 * Fill in defaults for the `markup.*` captures (Markdown headings/emphasis/code/…)
 * that text-mostly themes don't define. Colors reuse the loaded palette so they
 * stay theme-consistent; styles give markup its visual hallmarks. Existing theme
 * entries always win (we only set what's missing).
 */
function applyMarkupDefaults(syntax: SyntaxColors, syntaxStyle: SyntaxStyles, ui: ThemeUi): void {
  const fg = ui.editor.foreground;
  const colorDefaults: SyntaxColors = {
    'markup.heading': syntax.function ?? syntax.keyword ?? fg,
    'markup.link': syntax.function ?? ui.text.accent ?? fg,
    'markup.link.url': syntax.string ?? syntax.comment ?? fg,
    'markup.raw': syntax.string ?? fg,
    'markup.list': syntax.punctuation ?? syntax.operator ?? fg,
    'markup.quote': syntax.comment ?? ui.text.muted ?? fg,
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
    ...(ui.surface.popover ? {
      'markup.raw': { background: ui.surface.popover },
      'markup.raw.block': { lineBackground: ui.surface.popover },
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
