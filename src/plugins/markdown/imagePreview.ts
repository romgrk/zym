/*
 * Markdown inline image preview — render `![alt](src)` images directly below the
 * line that references them, as real widgets in a reserved gap (zero buffer
 * footprint) via the editor's `BlockDecorations`.
 *
 * Scope (v1): **local** images — paths relative to the document, absolute paths,
 * and `file://` URLs. Remote (`http(s)://`, `data:`) sources are skipped (loading
 * them means async network under the GLib loop — a later addition). The block is
 * non-interactive (the `add_overlay` path), which is all an image needs.
 *
 * Like the color-preview plugin, this is a consumer of `observeTextEditors`: per
 * markdown editor it owns a set of image blocks and reconciles them (add new /
 * remove gone, keep + let the rest track edits via their anchor mark) on a
 * debounced rescan. The pure path-resolution logic is exported for unit tests.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gdk, GdkPixbuf, Gtk } from '../../gi.ts';
import { quilx } from '../../quilx.ts';
import { Disposable } from '../../util/eventKit.ts';
import type { PluginContext } from '../../plugin/types.ts';
import type { TextEditor } from '../../ui/TextEditor/index.ts';
import type { ScanMatchResult } from '../../ui/TextEditor/EditorModel.ts';
import type { BlockDecorationSpec } from '../../ui/TextEditor/BlockDecorationSet.ts';

// Coalesce rapid edits before re-scanning. Loading images is heavier than the
// color-preview regex pass, so a slightly longer idle than that plugin's.
const DEBOUNCE_MS = 200;

// Cap the rendered size; the image is scaled down preserving aspect to fit within
// this box (never scaled up — small images show at natural size).
const MAX_WIDTH = 600;
const MAX_HEIGHT = 360;

// Markdown image: `![alt](src)` with an optional title and optional <>-wrapped src.
// Group 1 is the src (the title, if any, is left out of the capture). Global: the
// editor's `scan` steps it across the buffer.
export const IMAGE_RE = /!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*"|\s+'[^']*'|\s+\([^)]*\))?\s*\)/g;

/**
 * Resolve a markdown image `src` to an absolute local filesystem path, or `null`
 * if it isn't a local image we can load (remote scheme, `data:`, or relative with
 * no known document directory). Pure — unit-tested.
 */
export function resolveImagePath(rawSrc: string, docPath: string | null): string | null {
  let src = rawSrc.trim();
  if (src.startsWith('<') && src.endsWith('>')) src = src.slice(1, -1);
  if (src === '') return null;
  // Percent-decode (e.g. `%20` → space) so the path hits the filesystem correctly.
  try { src = decodeURI(src); } catch { /* malformed escape — keep raw */ }

  if (src.startsWith('file://')) {
    try { return fileURLToPath(src); } catch { return null; }
  }
  // Any other explicit scheme (http/https/data/…) is remote/unsupported in v1.
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;

  if (Path.isAbsolute(src)) return src;
  if (!docPath) return null;
  return Path.resolve(Path.dirname(docPath), src);
}

interface CachedTexture {
  texture: InstanceType<typeof Gdk.Texture>;
  width: number;
  height: number;
  mtimeMs: number;
}

/** Load (and downscale) an image into a cached GdkTexture, keyed by path+mtime so
 *  an unchanged file is loaded once. Returns null if the file is missing/unreadable
 *  or not a decodable image. */
function loadTexture(absPath: string, cache: Map<string, CachedTexture>): CachedTexture | null {
  let mtimeMs: number;
  try {
    mtimeMs = Fs.statSync(absPath).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(absPath);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  try {
    // newFromFileAtScale downscales preserving aspect ratio in one decode.
    const pixbuf = (GdkPixbuf.Pixbuf as any).newFromFileAtScale(absPath, MAX_WIDTH, MAX_HEIGHT, true);
    const entry: CachedTexture = {
      texture: (Gdk.Texture as any).newForPixbuf(pixbuf),
      width: pixbuf.getWidth(),
      height: pixbuf.getHeight(),
      mtimeMs,
    };
    cache.set(absPath, entry);
    return entry;
  } catch {
    return null;
  }
}

/** A fresh Picture for `entry` (the texture/paintable is shared across blocks, but
 *  a widget has a single parent, so each block needs its own Picture). */
function buildPicture(entry: CachedTexture): InstanceType<typeof Gtk.Widget> {
  const picture = (Gtk.Picture as any).newForPaintable(entry.texture);
  picture.setSizeRequest(entry.width, entry.height);
  picture.setHalign(Gtk.Align.START);
  picture.setMarginStart(8);
  picture.setMarginTop(2);
  picture.setMarginBottom(6);
  return picture;
}

/** Wire markdown image preview into every markdown editor. */
export function activateImagePreview(ctx: PluginContext, markdownFileTypes: readonly string[]): void {
  const exts = new Set(markdownFileTypes.map((t) => `.${t.toLowerCase()}`));
  const isMarkdown = (path: string | null): boolean =>
    path != null && exts.has(Path.extname(path).toLowerCase());

  ctx.observeTextEditors((editor: TextEditor) => {
    if (!isMarkdown(editor.currentFile)) return;
    const docPath = editor.currentFile;

    // Image bands keyed by `${absPath}#${ordinal}` — a stable identity per distinct image
    // occurrence, so a band survives edits that merely shift its line. Declared as SOURCE-anchored
    // block decorations (single file → no sourceKey); positions ride their marks between re-scans.
    const bands = editor.blockDecorations();
    const cache = new Map<string, CachedTexture>();
    let timer: NodeJS.Timeout | null = null;

    const refresh = (): void => {
      const enabled = quilx.config.get('markdown.imagePreview') !== false;
      const specs: BlockDecorationSpec[] = [];
      if (enabled) {
        const ordinals = new Map<string, number>();
        editor.model.scan(IMAGE_RE, ({ match, range }: ScanMatchResult) => {
          const absPath = resolveImagePath(match[1] ?? '', docPath);
          if (!absPath) return;
          const ordinal = ordinals.get(absPath) ?? 0;
          ordinals.set(absPath, ordinal + 1);
          const entry = loadTexture(absPath, cache);
          if (!entry) return;
          const id = `${absPath}#${ordinal}`;
          specs.push({ id, key: id, anchor: { row: range.start.row }, placement: 'below', build: () => buildPicture(entry) });
        });
      }
      bands.set(specs);
    };

    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, DEBOUNCE_MS);
    };

    const sub = editor.model.onDidChangeText(schedule);
    const configSub = quilx.config.observe('markdown.imagePreview', () => refresh());
    refresh(); // initial paint of the loaded content

    return new Disposable(() => {
      if (timer) clearTimeout(timer);
      sub.dispose();
      configSub.dispose();
      bands.clear();
      cache.clear();
    });
  });
}
