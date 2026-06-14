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
  /** Line-number gutter foreground. Defaults to `fg` when omitted. */
  lineNumber?: string;
  /** Separator/border color for chrome (e.g. the header bar's bottom edge). */
  border?: string;
  /** De-emphasized text (secondary labels, subtitles). */
  textMuted?: string;
  /** Semantic text colors for status/feedback (Zed's status keys). */
  success?: string;
  warning?: string;
  error?: string;
  info?: string;
  hint?: string;
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

export interface Theme {
  name: string;
  appearance: 'light' | 'dark';
  ui: UiColors;
  syntax: SyntaxColors;
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

  const fg = pick('editor.foreground', 'foreground');
  if (!fg) throw new Error(`theme "${zed.name}" defines no editor/foreground color`);

  // Preserve `style.syntax` key order — it drives tag priority (see SyntaxColors).
  const syntax: SyntaxColors = {};
  for (const [capture, token] of Object.entries(style.syntax ?? {})) {
    if (token && typeof token.color === 'string') syntax[capture] = token.color;
  }

  return {
    name: zed.name,
    appearance: zed.appearance,
    ui: {
      fg,
      bg: pick('editor.background', 'background'),
      lineNumber: pick('editor.line_number', 'editor.gutter.foreground'),
      border: pick('border', 'border.variant'),
      textMuted: pick('text.muted'),
      success: pick('success'),
      warning: pick('warning'),
      error: pick('error'),
      info: pick('info'),
      hint: pick('hint'),
    },
    syntax,
  };
}

/** The active theme. */
export const theme = loadTheme('quilx');
