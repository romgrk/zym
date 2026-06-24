/*
 * icons.ts — bundled SVG image icons.
 *
 * `ImageIcons` is the typed catalog of the SVGs under `assets/icons/`, keyed by
 * the constant names the pre-processor derives from each filename (e.g.
 * `cat-sleeping.svg` → `ImageIcons.CAT_SLEEPING`). The name→path map is generated
 * by `scripts/generate-icons.ts` into `icons.generated.ts`; this module turns each
 * entry into a builder that renders the SVG into a sized `Gtk.Image`:
 *
 *   const cat = ImageIcons.CAT_SLEEPING(52);
 *
 * These are symbolic SVGs (named `*-symbolic.svg`): loaded through
 * `Gtk.IconPaintable`, GTK treats the `-symbolic` suffix as a recolor hint and
 * tints them to the widget's `color` — so they follow the theme foreground like
 * the Nerd Font glyphs in `ui/icons.ts`, despite not living in an icon theme. The
 * suffix is load-bearing: drop it and GTK renders the SVG's authored colors
 * instead. The paintable also rasterizes the vector crisply at the requested
 * pixel size rather than scaling an intrinsic bitmap.
 */
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gio, Gtk } from './gi.ts';
import { ICON_FILES } from './icons.generated.ts';

type Image = InstanceType<typeof Gtk.Image>;

// Generated paths are repo-root-relative; this module lives in `src/`.
const ROOT_DIR = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..');

/** Render a bundled SVG (repo-root-relative `path`) into a `Gtk.Image` sized to
 *  `pixelSize`. The paintable rasterizes the vector at that size, so it stays
 *  crisp at any scale. */
function loadImage(path: string, pixelSize: number): Image {
  const file = Gio.File.newForPath(Path.join(ROOT_DIR, path));
  const paintable = Gtk.IconPaintable.newForFile(file, pixelSize, 1);
  const image = Gtk.Image.newFromPaintable(paintable);
  image.setPixelSize(pixelSize);
  return image;
}

/** Build a `Gtk.Image` for the named icon at `pixelSize`. */
type IconBuilder = (pixelSize: number) => Image;

/** The bundled icon catalog: `ImageIcons.CAT_SLEEPING(52)` → a sized `Gtk.Image`. */
export const ImageIcons = Object.fromEntries(
  Object.entries(ICON_FILES).map(([key, path]) => [key, (pixelSize: number) => loadImage(path, pixelSize)]),
) as Record<keyof typeof ICON_FILES, IconBuilder>;
