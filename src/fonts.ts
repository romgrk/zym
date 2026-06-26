/*
 * Font helpers: bridge the GNOME/Pango font world to GTK CSS.
 *
 * GSettings stores fonts as Pango font-description strings (e.g.
 * "JetBrainsMono Nerd Font Light 11"), where the trailing tokens are the weight
 * and point size, not part of the family name. Dropping them naively leaves an
 * invalid CSS family, so we parse with Pango and emit each property explicitly.
 *
 * The single source of truth is the `fonts` store (bottom of this file): it owns
 * the app's monospace/UI fonts — the `core.monospaceFont` / `core.uiFont` config
 * value when set, else the live GNOME interface font. It publishes them three ways,
 * one per consumer kind:
 *   - **CSS** — reactive custom properties on `.AppWindow` (`--t-font-ui-family`,
 *     `--t-font-monospace`, …; see `themeFontCssVariables`-style block in `css()`).
 *     A root `font-family: var(--t-font-ui-family)` baseline makes every widget
 *     follow the UI font by inheritance; monospace surfaces opt in with
 *     `font: var(--t-font-monospace)` (or `font-family: var(--t-font-monospace-family)`).
 *   - **Pango markup** — read the live family (`fonts.monospaceFamily` /
 *     `fonts.uiFamily`) at render time; markup can't read CSS variables.
 *   - **Font-description consumers** (e.g. VTE) — `fonts.monospaceDescription()` plus
 *     `fonts.onChange(...)` to re-apply on change.
 * Change the font in one place and everything re-applies. The bare functions below
 * are its primitives.
 */
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gio, Pango, PangoCairo } from './gi.ts';
import { zym } from './zym.ts';
import { styles } from './styles.ts';

/** Pango family name of the bundled icon font (see assets/fonts). */
export const ICON_FONT_FAMILY = 'Symbols Nerd Font Mono';

const BUNDLED_FONTS = ['SymbolsNerdFontMono-Regular.ttf'];

/**
 * Register the fonts bundled under assets/fonts with GTK's default fontmap, so
 * the file-tree glyph icons render regardless of what's installed system-wide.
 * Must run after GTK is initialized (i.e. inside app startup/activate).
 */
export function registerBundledFonts(): void {
  const dir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');
  const fontMap = PangoCairo.FontMap.getDefault();
  for (const file of BUNDLED_FONTS) {
    if (!fontMap.addFontFile(Path.join(dir, file)))
      console.warn(`zym: failed to load bundled font ${file}`);
  }
}

export interface FontCss {
  family: string;       // CSS-quoted family, e.g. '"JetBrainsMono Nerd Font"'
  weight: number;       // CSS numeric weight (Pango weights are already 100–1000)
  style: string;        // 'normal' | 'italic' | 'oblique'
  sizePt: number | null; // point size, or null when unspecified
}

/** Parse a Pango font-description string into CSS font properties. */
export function fontDescriptionToCss(description: string): FontCss {
  const desc = Pango.FontDescription.fromString(description);

  const family = desc.getFamily() || 'monospace';
  const weight = desc.getWeight(); // Pango.Weight values equal CSS numeric weights
  const pangoStyle = desc.getStyle();
  const style =
    pangoStyle === Pango.Style.ITALIC ? 'italic' :
    pangoStyle === Pango.Style.OBLIQUE ? 'oblique' : 'normal';

  // getSize() is in Pango units (PANGO_SCALE per point) unless absolute (device
  // pixels), which we don't translate to CSS pt; skip the size in that case.
  const sizePt = desc.getSizeIsAbsolute() ? null : desc.getSize() / Pango.SCALE;

  return { family: `"${family}"`, weight, style, sizePt };
}

function familyOf(description: string, fallback: string): string {
  return Pango.FontDescription.fromString(description).getFamily() || fallback;
}

/**
 * The size scale: the picked font supplies the **medium** point size; `small` and
 * `large` are derived as a multiplicative modular scale around it, rounded to the
 * nearest half-point so the steps stay proportional at any base size.
 */
const FONT_SIZE_SCALE = { small: 0.85, large: 1.2 } as const;

/**
 * Point size used when a font description carries no size of its own (an
 * absolute/device-pixel description). Keeps the size variables always published so
 * consumers like `var(--t-font-ui-size-small)` never resolve to nothing. Roughly
 * the GNOME interface default.
 */
const DEFAULT_FONT_SIZE_PT = 10;

const roundHalf = (pt: number): number => Math.round(pt * 2) / 2;

/**
 * The application font store — the single place the app's monospace/UI fonts are
 * defined and kept in sync. It publishes them as reactive CSS variables on the root
 * `.AppWindow` (plus a UI-font baseline), and exposes live family names + a
 * font-description for the consumers that can't read CSS:
 *
 *  - **CSS** — read `var(--t-font-monospace)` / `var(--t-font-monospace-family)` /
 *    `var(--t-font-ui-family)` (full list below) in a component's own stylesheet.
 *    Don't inline a family literal. The root `.AppWindow` baseline applies the UI
 *    font to everything by inheritance, so only monospace surfaces need a rule.
 *  - **Pango markup** — read `fonts.monospaceFamily` / `fonts.uiFamily` at render
 *    time, so `face="…"`/`font_family="…"` reflect the current font.
 *  - **Font-description consumers** (e.g. VTE) — `fonts.monospaceDescription()` plus
 *    `fonts.onChange(...)` to re-apply when the font changes.
 *
 * Published CSS variables (on `.AppWindow`, re-set on every change) — the same full
 * set for each role (`ui`, `monospace`):
 *  - `--t-font-<role>-family`, `--t-font-<role>-weight`, `--t-font-<role>-style`
 *  - three sizes — `--t-font-<role>-size-small`, `--t-font-<role>-size` (medium),
 *    `--t-font-<role>-size-large` — and the matching `font` shorthands
 *    `--t-font-<role>-small`, `--t-font-<role>` (medium), `--t-font-<role>-large`.
 * The picked font supplies the medium size; small/large are derived (see
 * `FONT_SIZE_SCALE`). A description with no point size of its own (an absolute/
 * device-pixel description) falls back to `DEFAULT_FONT_SIZE_PT`, so the size vars
 * and shorthands are always published.
 *
 * The picked font is the `core.uiFont` / `core.monospaceFont` config value when set,
 * else the live GNOME interface font; the store follows both, so changing either
 * re-applies everything. See docs/styling.md → Fonts.
 */
class FontStore {
  private readonly settings = new Gio.Settings({ schemaId: 'org.gnome.desktop.interface' });
  private readonly listeners = new Set<() => void>();
  private ready = false; // the display (and so `styles.set`) isn't available until init

  private _monoCss!: FontCss;
  private _uiCss!: FontCss;
  private _monoFamily!: string;
  private _uiFamily!: string;

  constructor() {
    // Bootstrap from the system fonts only. The config isn't safe to read here:
    // fonts.ts ⇄ zym.ts form an import cycle (zym → Workspace → … → fonts),
    // so during module load `zym` may still be in its TDZ. init()/reload() fold
    // in the core.uiFont / core.monospaceFont overrides once the app is running.
    this.compute(this.systemMonoName(), this.systemUiName());
  }

  /** The monospace family name (unquoted), for Pango `face=`/`font_family=`. */
  get monospaceFamily(): string {
    return this._monoFamily;
  }
  /** The UI (proportional) family name (unquoted), for Pango markup. */
  get uiFamily(): string {
    return this._uiFamily;
  }
  /** The monospace font as a Pango.FontDescription (e.g. for VTE). */
  monospaceDescription(): InstanceType<typeof Pango.FontDescription> {
    return Pango.FontDescription.fromString(this.monoName());
  }

  /** Subscribe to font changes (system or, later, user config). Returns unsubscribe. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Install the central font stylesheet and follow system changes. Call once
   *  after `installStyles()` (when the display exists). */
  init(): void {
    this.ready = true;
    this.reload(); // now safe to read config — re-applies with any overrides folded in
    this.settings.on('changed', (key: string) => {
      if (key === 'monospace-font-name' || key === 'font-name') this.reload();
    });
    // Follow the user font config too (it overrides the system font when non-empty);
    // it's applied after this runs, so reload on change rather than read once.
    zym.config.onDidChange('core.uiFont', () => this.reload());
    zym.config.onDidChange('core.monospaceFont', () => this.reload());
  }

  /** Recompute the fonts (config override or system), re-apply the sheet, and
   *  notify subscribers. */
  reload(): void {
    this.compute(this.monoName(), this.uiName());
    this.apply();
    for (const cb of [...this.listeners]) cb();
  }

  /** Cache the CSS/family forms of the given monospace + UI descriptions. */
  private compute(mono: string, ui: string): void {
    this._monoCss = fontDescriptionToCss(mono);
    this._uiCss = fontDescriptionToCss(ui);
    this._monoFamily = familyOf(mono, 'monospace');
    this._uiFamily = familyOf(ui, 'sans-serif');
  }

  private apply(): void {
    if (!this.ready) return; // changes before init() are flushed by init()
    styles.set(this.css(), { key: 'app-fonts' });
  }

  /** The reactive font sheet: the `--t-font-*` variables + the UI-font baseline,
   *  both on `.AppWindow` so every descendant inherits the UI font. */
  private css(): string {
    return `.AppWindow {\n${this.variables()}\n  font-family: var(--t-font-ui-family);\n}`;
  }

  private variables(): string {
    return [...this.fontVars('ui', this._uiCss), ...this.fontVars('monospace', this._monoCss)]
      .map((l) => `  ${l}`)
      .join('\n');
  }

  /** The full set of `--t-font-<role>-*` declarations for one font: the shared
   *  family/weight/style, plus the three sizes (`small`/medium/`large`, medium being
   *  the picked size) as both a `*-size`/`*-size-{small,large}` and the matching
   *  `font` shorthand (`--t-font-<role>` / `--t-font-<role>-{small,large}`). An
   *  absolute (device-pixel) description carries no point size, so it falls back to
   *  `DEFAULT_FONT_SIZE_PT` — the size vars are always emitted. */
  private fontVars(role: 'ui' | 'monospace', f: FontCss): string[] {
    const lines = [
      `--t-font-${role}-family: ${f.family};`,
      `--t-font-${role}-weight: ${f.weight};`,
      `--t-font-${role}-style: ${f.style};`,
    ];
    // Fall back to a default when the description carries no point size, so the
    // size vars/shorthands are always emitted (see DEFAULT_FONT_SIZE_PT).
    const basePt = f.sizePt ?? DEFAULT_FONT_SIZE_PT;
    const sizes = {
      small: roundHalf(basePt * FONT_SIZE_SCALE.small),
      medium: basePt,
      large: roundHalf(basePt * FONT_SIZE_SCALE.large),
    };
    for (const [name, sizePt] of Object.entries(sizes)) {
      const suffix = name === 'medium' ? '' : `-${name}`;
      lines.push(`--t-font-${role}-size${suffix}: ${sizePt}pt;`);
      lines.push(`--t-font-${role}${suffix}: ${f.style} ${f.weight} ${sizePt}pt ${f.family};`);
    }
    return lines;
  }

  /** The monospace font description: the `core.monospaceFont` config override when
   *  set, else the system monospace font. */
  private monoName(): string {
    return this.configFont('core.monospaceFont') ?? this.systemMonoName();
  }
  /** The UI font description: the `core.uiFont` config override when set, else the
   *  system UI font. */
  private uiName(): string {
    return this.configFont('core.uiFont') ?? this.systemUiName();
  }

  private systemMonoName(): string {
    return this.settings.getString('monospace-font-name') as string;
  }
  private systemUiName(): string {
    return this.settings.getString('font-name') as string;
  }

  /** A non-empty string config override for `key`, or null to fall back to the
   *  system font. Safe only at runtime (post-init), never during module load —
   *  see the constructor on the fonts ⇄ zym import cycle. */
  private configFont(key: string): string | null {
    const value = zym.config.get(key);
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }
}

/** The application's single font store. */
export const fonts = new FontStore();
