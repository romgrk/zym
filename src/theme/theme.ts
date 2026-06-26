/*
 * Theme — loads a theme authored in *our own* format (a format we own; see
 * theme.schema.json) and normalizes it into the shape the editor consumes (nested
 * UI chrome colors + a flat syntax capture → color map). Themes live as JSON next
 * to this module (e.g. zym.json), are loaded through `loadTheme`, and the active
 * theme is exported as `theme`. See docs/theming.md.
 *
 * On disk a theme is one file: `{ name, appearance, ui, syntax }`, and the
 * consumed `Theme.ui` mirrors the file's `ui` shape 1:1 — concern-grouped nested
 * objects, so a theme JSON's `ui.editor.background` is read in code as exactly
 * `theme.ui.editor.background`. `syntax` maps a tree-sitter capture name → a color
 * + optional font style. `loadTheme` deep-merges the file's `ui` over `DEFAULT_THEME.ui`
 * (the built-in fallback theme), derives the diff tints, and splits the syntax
 * tokens into the color + style maps. Every `theme.ui.*` field is guaranteed filled.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { alpha as withAlpha, darken, formatHEXA, lighten, parse } from 'color-bits';
import { lookupCSSColor } from './cssColor.ts';
import type { Scheme } from './adwaitaColors.ts';

// --- Internal (consumed) shape ---------------------------------------------

/**
 * UI / editor chrome colors, grouped by concern to mirror the theme JSON's `ui`
 * object 1:1 (read in code as `theme.ui.editor.background`, `theme.ui.status.error`,
 * `theme.ui.diff.addedWord`, …). Every field is filled at load from the theme file
 * over `DEFAULT_THEME.ui`, so consumers never see `undefined` — read any of them directly.
 */
export interface ThemeUi {
  editor: {
    /** Default editor text foreground. */
    foreground: string;
    /**
     * Editor background — always filled (the theme's value, else `surface.popover`).
     * Whether the editor uses this via a theme-owned GtkSourceView scheme, or instead
     * follows the system light/dark Adwaita scheme, is decided by
     * `Theme.followSystemScheme` (set when the theme file omits this field) — not by
     * this value. See createSourceScheme / TextEditor.followSystemColorScheme.
     */
    background: string;
    /** Line-number gutter foreground. */
    lineNumber: string;
  };

  // --- libadwaita-backed surfaces -------------------------------------------
  // The next four concerns (view / card / sidebar / secondarySidebar) alias onto
  // libadwaita CSS variables — see `ADWAITA_ALIASES`. Each leaf is emitted under its
  // `--…-color` name, but ONLY when the theme file sets it; an unset one is omitted so
  // libadwaita's own variable stands and keeps following the OS scheme. Everything
  // OUTSIDE this block is a custom token, emitted as `--t-ui-<path>` unconditionally.
  // This is the transitioning-to-Adwaita-variables side of the split.
  /**
   * The base libadwaita "view" surface colors — the fg/bg of content areas (text views,
   * lists). Defaults point at the Adwaita CSS variables (`--view-fg-color` /
   * `--view-bg-color`) and are resolved to concrete RGB at load (see adaptTheme /
   * resolveCssVarsInPlace), so consumers always read a literal color.
   */
  view: {
    /** View foreground (`--view-fg-color`). */
    fg: string;
    /** View background (`--view-bg-color`). */
    bg: string;
  };
  /**
   * The libadwaita "card" surface colors — the fg/bg of boxed/elevated content (cards,
   * boxed lists). Like `view`, the defaults point at the Adwaita CSS variables
   * (`--card-fg-color` / `--card-bg-color`) and are resolved to concrete RGB at load
   * (see adaptTheme / resolveCssVarsInPlace), so consumers always read a literal color.
   */
  card: {
    /** Card foreground (`--card-fg-color`). */
    fg: string;
    /** Card background (`--card-bg-color`). */
    bg: string;
  };
  /**
   * The libadwaita "sidebar" surface colors — the chrome of navigation/utility panes
   * that flank the content (file tree, agent list). Like `view`/`card`, the defaults
   * point at the Adwaita CSS variables (`--sidebar-*-color`) and are resolved to concrete
   * RGB at load (see adaptTheme / resolveCssVarsInPlace), so consumers always read a
   * literal color. The dimmer companion surface for a second, nested pane is the sibling
   * `secondarySidebar` concern.
   */
  sidebar: {
    /** Sidebar foreground (`--sidebar-fg-color`). */
    fg: string;
    /** Sidebar background (`--sidebar-bg-color`). */
    bg: string;
    /** Sidebar background when the window is unfocused (`--sidebar-backdrop-color`). */
    backdrop: string;
    /** Sidebar edge border toward the content (`--sidebar-border-color`). */
    border: string;
    /** Sidebar shade for scroll-under / elevation (`--sidebar-shade-color`). */
    shade: string;
  };
  /**
   * The libadwaita "secondary sidebar" surface colors — the dimmer companion surface for a
   * second, nested pane beside `sidebar`. Same shape and defaulting as `sidebar`, pointing
   * at the Adwaita `--secondary-sidebar-*` variables (resolved to RGB at load).
   */
  secondarySidebar: {
    /** Secondary-sidebar foreground (`--secondary-sidebar-fg-color`). */
    fg: string;
    /** Secondary-sidebar background (`--secondary-sidebar-bg-color`). */
    bg: string;
    /** Secondary-sidebar background when the window is unfocused (`--secondary-sidebar-backdrop-color`). */
    backdrop: string;
    /** Secondary-sidebar edge border (`--secondary-sidebar-border-color`). */
    border: string;
    /** Secondary-sidebar shade (`--secondary-sidebar-shade-color`). */
    shade: string;
  };
  // --- end libadwaita-backed surfaces; everything below is a custom token ----

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
    /** Armed-occurrence tint — visually distinct from the navigation match colour. */
    occurrence: string;
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
 * (SyntaxController's resolveTag): e.g. @keyword.control reuses `keyword`;
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
  /**
   * True when the theme file omitted `ui.editor.background`: the editor follows the
   * system light/dark Adwaita scheme instead of a theme-owned GtkSourceView scheme
   * (see TextEditor.followSystemColorScheme / createSourceScheme). `ui.editor.background`
   * is still filled (with `surface.popover`) so color consumers always have a value.
   */
  followSystemScheme: boolean;
  /** Base spacing unit in px (margins / gaps between content chrome); `--t-spacing`. */
  spacing: number;
  ui: ThemeUi;
  /**
   * The dotted `ui` leaf paths the theme FILE explicitly set (e.g. `sidebar.bg`,
   * `status.error`) — not the filled-in defaults. The emission gate for the
   * libadwaita-aliased tokens reads this: an aliased token is written as a `--…-color`
   * override only when its path is in here (otherwise libadwaita's own variable stands).
   * See `themeUiCssVariables` / `ADWAITA_ALIASES`.
   */
  definedPaths: ReadonlySet<string>;
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
 * loader deep-merges it over `DEFAULT_THEME.ui`. `syntax` key order drives tag
 * priority (see SyntaxColors).
 */
interface ThemeFromFile {
  name: string;
  appearance: 'light' | 'dark';
  spacing?: number;
  ui?: ThemeFromFileUi;
  syntax?: Record<string, ThemeSyntaxToken>;
}

/** A theme file's `ui`: the same concern groups as `ThemeUi`, each field optional. */
interface ThemeFromFileUi {
  editor?: Partial<ThemeUi['editor']>;
  view?: Partial<ThemeUi['view']>;
  card?: Partial<ThemeUi['card']>;
  sidebar?: Partial<ThemeUi['sidebar']>;
  secondarySidebar?: Partial<ThemeUi['secondarySidebar']>;
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
 * The built-in default theme — a complete dark `Theme` of concrete RGB colors, the
 * exceptions being `view.{fg,bg}` / `card.{fg,bg}` / `sidebar.*`, which point at the
 * Adwaita `--view-*-color` / `--card-*-color` / `--sidebar-*-color` variables the loader
 * resolves to RGB (see resolveCssVarsInPlace). Resolved values are safe to
 * interpolate into Pango markup as well as CSS. It
 * is the single source of color defaults: `loadTheme` deep-merges a theme file's `ui`
 * over `DEFAULT_THEME.ui` (a theme's own values always win), so every `theme.ui.*`
 * field is guaranteed filled and the rest of the app never needs an inline color
 * literal. Also exported as a ready-to-use last-resort theme. The `diff.added`/`removed`
 * (line + word) tints are DERIVED from `status` per appearance (see diffTones); here
 * they're the dark derivation of the default status colors. `syntax`/`syntaxStyle` are
 * empty — syntax coloring is sparse and per-theme; the loader fills `markup.*` defaults
 * via applyMarkupDefaults.
 */
export const DEFAULT_THEME: Theme = {
  name: 'default',
  appearance: 'dark',
  followSystemScheme: false,
  spacing: 8,
  // Built-in defaults are not "file-defined", so the aliased surfaces (view/card/
  // sidebar) emit nothing and pass through to libadwaita's own variables.
  definedPaths: new Set<string>(),
  ui: {
    editor: { foreground: '#ffffff', background: '#1e1e1e', lineNumber: '#888888' },
    view: { fg: '--view-fg-color', bg: '--view-bg-color' },
    card: { fg: '--card-fg-color', bg: '--card-bg-color' },
    sidebar: {
      fg: '--sidebar-fg-color',
      bg: '--sidebar-bg-color',
      backdrop: '--sidebar-backdrop-color',
      border: '--sidebar-border-color',
      shade: '--sidebar-shade-color',
    },
    secondarySidebar: {
      fg: '--secondary-sidebar-fg-color',
      bg: '--secondary-sidebar-bg-color',
      backdrop: '--secondary-sidebar-backdrop-color',
      border: '--secondary-sidebar-border-color',
      shade: '--secondary-sidebar-shade-color',
    },
    text: { muted: '#9a9996', accent: '#c678dd' },
    border: 'rgba(0, 0, 0, 0.3)',
    shadow: 'rgba(0, 0, 0, 0.3)',
    surface: { popover: '#1e1e1e', selected: 'rgba(127, 127, 127, 0.25)' },
    status: { success: '#2ec27e', warning: '#e5a50a', error: '#e01b24', info: '#3584e4', hint: '#33d17a' },
    search: { match: '#e5a50a26', matchCurrent: '#e5a50a59', occurrence: '#a371f73d' },
    diff: { ...diffTones('#2ec27e', '#e01b24', 'dark'), filler: '#88888820', fold: '#8888882e' },
    flash: '#f5c21188',
    pr: { open: '#3fb950', merged: '#a371f7', closed: '#f85149' },
  },
  syntax: {},
  syntaxStyle: {},
};

// --- Adwaita design-language colors ----------------------------------------
//
// The concrete color knowledge for the layers that can't read CSS lives in
// `adwaitaColors.ts` (kept apart so `theme.ts` and `cssColor.ts` can both read it
// without an import cycle). Re-exported here so `theme.ts` stays the public entry point
// for these tokens.
export { APP_COLORS, FALLBACK_COLORS, appColorVariables } from './adwaitaColors.ts';
export type { Scheme } from './adwaitaColors.ts';

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
 * deep-merge the file's `ui` over `DEFAULT_THEME.ui` (concern by concern), fill +
 * flag `editor.background` (see followSystemScheme), derive the diff tints, resolve any
 * Adwaita CSS-variable-valued field to concrete RGB (see resolveCssVarsInPlace), and
 * split each `syntax` token into the color + style maps. Exported for tests.
 */
export function adaptTheme(file: ThemeFromFile): Theme {
  if (file.appearance !== 'light' && file.appearance !== 'dark') {
    throw new Error(`theme "${file.name ?? '?'}": appearance must be "light" or "dark"`);
  }

  const f = file.ui ?? {};
  const D = DEFAULT_THEME.ui;

  // Record the leaf paths the FILE set (before any default-filling), so the emission
  // gate knows which libadwaita-aliased tokens to override vs. leave to libadwaita.
  const definedPaths = new Set<string>();
  collectDefinedPaths(f as Record<string, unknown>, [], definedPaths);

  // status drives the diff tints, so resolve it first; the diff.* keys still win
  // where the theme sets them, and the word tints fall back to their line tint.
  const status = { ...D.status, ...f.status };
  const derived = diffTones(status.success, status.error, file.appearance);
  const diff: ThemeUi['diff'] = {
    added: f.diff?.added ?? derived.added,
    addedWord: f.diff?.addedWord ?? f.diff?.added ?? derived.addedWord,
    removed: f.diff?.removed ?? derived.removed,
    removedWord: f.diff?.removedWord ?? f.diff?.removed ?? derived.removedWord,
    filler: f.diff?.filler ?? D.diff.filler,
    fold: f.diff?.fold ?? D.diff.fold,
  };

  const surface = { ...D.surface, ...f.surface };

  // editor.background is the one field a theme may omit; its absence means "follow the
  // system light/dark scheme" (recorded as followSystemScheme). We still FILL the field
  // — with the popover surface — so every color consumer reads a concrete value.
  const followSystemScheme = f.editor?.background === undefined;

  const ui: ThemeUi = {
    editor: { ...D.editor, ...f.editor, background: f.editor?.background ?? surface.popover },
    view: { ...D.view, ...f.view },
    card: { ...D.card, ...f.card },
    sidebar: { ...D.sidebar, ...f.sidebar },
    secondarySidebar: { ...D.secondarySidebar, ...f.secondarySidebar },
    text: { ...D.text, ...f.text },
    border: f.border ?? D.border,
    shadow: f.shadow ?? D.shadow,
    surface,
    status,
    search: {
      match: f.search?.match ?? D.search.match,
      matchCurrent: f.search?.matchCurrent ?? f.search?.match ?? D.search.matchCurrent,
      occurrence: f.search?.occurrence ?? D.search.occurrence,
    },
    diff,
    flash: f.flash ?? D.flash,
    pr: { ...D.pr, ...f.pr },
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

  // Fill any field still pointing at an Adwaita CSS variable (e.g. the `view.{fg,bg}`
  // defaults → `--view-{fg,bg}-color`) with a concrete RGB color, before markup defaults
  // read the palette.
  resolveCssVarsInPlace(ui as unknown as Record<string, unknown>, file.appearance);

  applyMarkupDefaults(syntax, syntaxStyle, ui);
  return { name: file.name, appearance: file.appearance, followSystemScheme, spacing: file.spacing ?? DEFAULT_THEME.spacing, ui, definedPaths, syntax, syntaxStyle };
}

/** Collect the dotted paths of every string leaf in a theme file's `ui` (recursively),
 *  into `out` — the set of fields the file explicitly set (the emission gate). */
function collectDefinedPaths(node: Record<string, unknown>, path: string[], out: Set<string>): void {
  for (const [key, value] of Object.entries(node)) {
    const next = [...path, key];
    if (typeof value === 'string') out.add(next.join('.'));
    else if (value && typeof value === 'object') collectDefinedPaths(value as Record<string, unknown>, next, out);
  }
}

/**
 * Resolve any UI field whose value is an Adwaita CSS-variable reference (`--name`) to a
 * concrete `#rrggbb[aa]` string via the bridge (`lookupCSSColor`), recursively and in
 * place. A theme — or our own defaults, e.g. `view.bg` → `--view-bg-color` — may point a
 * chrome field at a libadwaita variable; non-CSS consumers (Pango markup, GtkTextTag,
 * scheme XML) need a literal color, so the loader fills it. With no display this resolves
 * to the static fallback (FALLBACK_COLORS); a post-display refill would re-resolve against
 * the live Adwaita scheme. Concrete values (`#…`, `rgba(…)`) are left untouched.
 */
function resolveCssVarsInPlace(node: Record<string, unknown>, scheme: Scheme): void {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (value.startsWith('--')) node[key] = lookupCSSColor(scheme, value);
    } else if (value && typeof value === 'object') {
      resolveCssVarsInPlace(value as Record<string, unknown>, scheme);
    }
  }
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
    'markup.link': syntax.function ?? ui.text.accent,
    'markup.link.url': syntax.string ?? syntax.comment ?? fg,
    'markup.raw': syntax.string ?? fg,
    'markup.list': syntax.punctuation ?? syntax.operator ?? fg,
    'markup.quote': syntax.comment ?? ui.text.muted,
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
    'markup.heading': { bold: true, scale: 1 }, // setext / generic fallback
    'markup.heading.1': { bold: true, scale: 2.4},
    'markup.heading.2': { bold: true, scale: 1.5 },
    'markup.heading.3': { bold: true, scale: 1.1 },
    'markup.heading.4': { bold: true, scale: 1 },
    'markup.heading.5': { bold: true, scale: 1 },
    'markup.heading.6': { bold: true, scale: 1 },
    'markup.strong': { bold: true },
    'markup.emphasis': { italic: true },
    'markup.strikethrough': { strikethrough: true },
    'markup.link': { underline: true },
    'markup.quote': { italic: true },
    // Inline code → text-only background; block code (fences) → full-line background.
    'markup.raw': { background: ui.surface.popover },
    'markup.raw.block': { lineBackground: ui.surface.popover },
  };
  for (const [cap, style] of Object.entries(styleDefaults)) {
    syntaxStyle[cap] = { ...style, ...syntaxStyle[cap] };
  }
}

/** The name loaded when no override is set — see `activeThemeName`. */
export const DEFAULT_THEME_NAME = 'zym';

/** The themes shippable by name: every `<name>.json` next to this module (minus the
 *  JSON Schema). Used by the theme picker and as the `theme.active` config enum. */
export function availableThemes(): string[] {
  return Fs.readdirSync(import.meta.dirname)
    .filter((f) => f.endsWith('.json') && f !== 'theme.schema.json')
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

// Read `theme.active` straight from the user config file, WITHOUT importing the
// config/zym modules — `theme.ts` is loaded very early (its `theme` const evaluates
// on first import) and pulling in `zym.ts` here would be a cycle. We replicate the
// tiny XDG path calc from config/load.ts. Returns undefined on any problem.
function configThemeName(): string | undefined {
  try {
    const configHome = process.env.XDG_CONFIG_HOME || Path.join(Os.homedir(), '.config');
    const parsed = JSON.parse(Fs.readFileSync(Path.join(configHome, 'zym', 'config.json'), 'utf8')) as Record<string, unknown>;
    const name = parsed['theme.active'];
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The theme name to load at startup, by precedence: the `ZYM_THEME` env var (for
 * testing a theme without touching config) → the `theme.active` user setting →
 * `DEFAULT_THEME_NAME`. Each candidate must name an existing theme file or it's
 * skipped (an unknown `ZYM_THEME` is warned about, since it's set deliberately).
 */
export function activeThemeName(): string {
  const available = new Set(availableThemes());
  const env = process.env.ZYM_THEME;
  if (env) {
    if (available.has(env)) return env;
    console.warn(`[theme] ZYM_THEME="${env}" is not an available theme (${[...available].join(', ')}); ignoring`);
  }
  const fromConfig = configThemeName();
  if (fromConfig && available.has(fromConfig)) return fromConfig;
  return DEFAULT_THEME_NAME;
}

/** The active theme. */
export const theme = loadTheme(activeThemeName());

/**
 * The single source of the "transitioning to libadwaita variables vs. our custom tokens"
 * split: the `ui` leaf paths that ALIAS onto a libadwaita CSS variable, mapped to its name.
 * An aliased token is emitted under this name — and only when the theme file sets it (see
 * `themeUiCssVariables`), so an unset one is omitted and libadwaita's own variable stands
 * (and keeps following the OS scheme). Every `ui` leaf NOT listed here is a custom token,
 * emitted as `--t-ui-<path>` unconditionally. Start small (the surface families); migrate
 * more concerns deliberately (e.g. `border` → `--border-color`, whose `currentColor` idiom
 * needs thought first).
 */
export const ADWAITA_ALIASES: Record<string, string> = {
  'view.fg': '--view-fg-color',
  'view.bg': '--view-bg-color',
  'card.fg': '--card-fg-color',
  'card.bg': '--card-bg-color',
  'sidebar.fg': '--sidebar-fg-color',
  'sidebar.bg': '--sidebar-bg-color',
  'sidebar.backdrop': '--sidebar-backdrop-color',
  'sidebar.border': '--sidebar-border-color',
  'sidebar.shade': '--sidebar-shade-color',
  'secondarySidebar.fg': '--secondary-sidebar-fg-color',
  'secondarySidebar.bg': '--secondary-sidebar-bg-color',
  'secondarySidebar.backdrop': '--secondary-sidebar-backdrop-color',
  'secondarySidebar.border': '--secondary-sidebar-border-color',
  'secondarySidebar.shade': '--secondary-sidebar-shade-color',
};

/**
 * The theme's `ui.*` color tokens as CSS custom-property declarations, split by
 * `ADWAITA_ALIASES`:
 *
 * - An **aliased** leaf (`view`/`card`/`sidebar`/`secondarySidebar`) is emitted under its
 *   libadwaita name (`view.bg` → `--view-bg-color`) **only when the theme file set it**
 *   (`t.definedPaths`); an unset one is omitted so libadwaita's own variable stands and
 *   keeps following the OS scheme. It gets no `--t-ui-*` twin (which would be a stale
 *   snapshot that doesn't track the OS).
 * - A **custom** leaf (everything else) is always emitted as `--t-ui-<dashed-path>`
 *   (`search.matchCurrent` → `--t-ui-search-match-current`).
 *
 * Installed on the `window` selector (see src/styles.ts) so the libadwaita overrides
 * retrofit stock chrome (and separate windows) while the `--t-ui-*` tokens stay available
 * to our own widgets. Pango markup / GtkTextTag consumers can't read CSS variables and
 * still read `theme.ui.*` directly (always a resolved literal). Newline-joined.
 */
export function themeUiCssVariables(t: Theme): string {
  const dash = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const lines: string[] = [];
  const walk = (node: Record<string, unknown>, path: string[]): void => {
    for (const [key, value] of Object.entries(node)) {
      const next = [...path, key];
      if (typeof value === 'string') {
        const dotted = next.join('.');
        const alias = ADWAITA_ALIASES[dotted];
        if (alias) {
          // Aliased: emit the libadwaita name, gated on the theme having set it.
          if (t.definedPaths.has(dotted)) lines.push(`${alias}: ${value};`);
        } else {
          // Custom: always emit as --t-ui-<dashed-path>.
          lines.push(`--t-ui-${next.map(dash).join('-')}: ${value};`);
        }
      } else if (value && typeof value === 'object') {
        walk(value as Record<string, unknown>, next);
      }
    }
  };
  walk(t.ui as unknown as Record<string, unknown>, []);
  return lines.join('\n');
}

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
