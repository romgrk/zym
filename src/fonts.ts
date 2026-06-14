/*
 * Font helpers: bridge the GNOME/Pango font world to GTK CSS.
 *
 * GSettings stores fonts as Pango font-description strings (e.g.
 * "JetBrainsMono Nerd Font Light 11"), where the trailing tokens are the weight
 * and point size, not part of the family name. Dropping them naively leaves an
 * invalid CSS family, so we parse with Pango and emit each property explicitly.
 */
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gio, Pango, PangoCairo } from './gi.ts';

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
      console.warn(`quilx: failed to load bundled font ${file}`);
  }
}

export interface FontCss {
  family: string;       // CSS-quoted family, e.g. '"JetBrainsMono Nerd Font"'
  weight: number;       // CSS numeric weight (Pango weights are already 100–1000)
  style: string;        // 'normal' | 'italic' | 'oblique'
  sizePt: number | null; // point size, or null when unspecified
  /** The above as a CSS declaration block (no selector). */
  declarations: string;
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

  const decls = [
    `font-family: "${family}";`,
    `font-weight: ${weight};`,
    `font-style: ${style};`,
  ];
  if (sizePt) decls.push(`font-size: ${sizePt}pt;`);

  return { family: `"${family}"`, weight, style, sizePt, declarations: decls.join(' ') };
}

/** The OS monospace font-description string (org.gnome.desktop.interface monospace-font-name). */
function monospaceFontName(): string {
  const settings = new Gio.Settings({ schemaId: 'org.gnome.desktop.interface' });
  return (settings as any).getString('monospace-font-name');
}

/** The OS monospace font as CSS. */
export function monospaceFontCss(): FontCss {
  return fontDescriptionToCss(monospaceFontName());
}

/** The OS monospace font as a Pango.FontDescription, for widgets (e.g. VTE) that
 *  take a font description rather than CSS. */
export function monospaceFontDescription(): InstanceType<typeof Pango.FontDescription> {
  return Pango.FontDescription.fromString(monospaceFontName());
}
