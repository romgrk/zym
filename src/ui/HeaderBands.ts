/*
 * HeaderBands — the filename "header" shown above each excerpt in a multibuffer, as a
 * real Gtk widget rather than a row of buffer text. Two looks share one builder:
 * `SearchResultsView` shows a file-type icon + dimmed directory + bold basename; `DiffView`
 * drops the icon and bolds the whole path uniformly, turning it warning-coloured with a
 * leading dot when the file has unsaved edits, and adds a collapse chevron + `+N −M` stats
 * (`HeaderWidgetOptions`). The widget isn't navigable/selectable buffer text; the diff places
 * it OVER a read-only header row (sticky), search anchors it above the first row. The builder
 * reports the click's press count to the surface (see `onActivate`): search jumps to the file on
 * a click, the diff ignores a single click and toggles the file's fold on a double-click.
 */
import * as Path from 'node:path';
import Gtk from 'gi:Gtk-4.0';
import type { CompositeDisposable } from '../util/eventKit.ts';
import { addStyles } from '../styles.ts';
import { fileIconGlyph } from './fileIcons.ts';
import { Icons, iconLabel } from './icons.ts';
import { NERDFONT } from './nerdfont.ts';
import { escapeMarkup } from './proseMarkup.ts';

addStyles(/* css */`
  .MultiBufferHeader {
    --bg-color: var(--sidebar-bg-color);
    padding: calc(1.5 * var(--t-spacing)) calc(2 * var(--t-spacing));
    background-color: var(--bg-color);
    border: 1px solid var(--border-color);
    // border-radius: 5px;
  }
  .MultiBufferHeader .icon { color: var(--t-ui-text-muted); }
  .MultiBufferHeader .label { color: var(--t-ui-editor-foreground); }
  .MultiBufferHeader .add { color: var(--t-ui-status-success); }
  .MultiBufferHeader .del { color: var(--t-ui-status-error); }
  .MultiBufferHeader.is-modified .label { color: var(--t-ui-status-warning); }

  .MultiBufferHeader.is-focused {}
  .zym-editor:focus-within .MultiBufferHeader.is-focused {
    background-color: mix(var(--bg-color), var(--accent-color), 0.1);
  }

  /* Fold markers  */
  .MultiBufferGap {
    background-color: var(--secondary-sidebar-bg-color);
    padding: 0.5em calc(2 * var(--t-spacing));
  }
  .MultiBufferGap .text {
    color: var(--view-fg-color);
    opacity: var(--dim-opacity);
  }
`);

/** Per-header look. The defaults reproduce `SearchResultsView`'s header (file-type icon, dimmed
 *  directory, bold basename); `DiffView` overrides them and adds the collapse chevron + stats. */
export interface HeaderWidgetOptions {
  /** Lead the filename with its file-type glyph (default true); the diff header opts out. */
  icon?: boolean;
  /** Bold the whole path uniformly instead of dimming the directory and bolding only the
   *  basename (default false). */
  boldPath?: boolean;
  /** A modified (unsaved) file: the path turns warning-coloured and is led by a warning dot,
   *  replacing the file-type glyph (default false). */
  modified?: boolean;
  /** Diff: a leading collapse chevron (chevron-down expanded / chevron-right collapsed). Omit for
   *  none (search). */
  collapsed?: boolean;
  /** Diff: the file was deleted in this change — append a dimmed `(deleted)` after the path. */
  deleted?: boolean;
  /** Diff: the file's `+N` added / `−M` removed change stats (omit / 0 = none). */
  added?: number;
  removed?: number;
}

/** The header widget for one excerpt: `label` is the display path, `path` selects the file-type
 *  icon, `onActivate` fires on click with the press count (1 = single, 2 = double), so a surface can
 *  distinguish a single- from a double-click (search jumps on either; the diff toggles the fold on a
 *  double-click and ignores a single one), `options` picks the look (see `HeaderWidgetOptions`). A
 *  leading `⋯` gap is a SEPARATE gap band (`buildGapWidget`), not part of the header. The header row
 *  IS the returned widget. */
export function buildHeaderWidget(
  scope: CompositeDisposable,
  label: string,
  path: string,
  onActivate: (nPress: number) => void,
  options: HeaderWidgetOptions = {},
): InstanceType<typeof Gtk.Widget> {
  const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
  row.addCssClass('MultiBufferHeader');
  // A modified (unsaved) file: the `.is-modified` state on the root turns the path labels warning-
  // coloured (see the stylesheet). Toggled here, read by every `.label` below.
  if (options.modified) row.addCssClass('is-modified');
  // Collapse chevron (diff surface): chevron-down when the file is expanded, chevron-right when
  // collapsed (the same fold idiom as the syntax gutter; see gutterRenderers.ts). It's a `.label`
  // like the path, so it tracks the filename's colour (incl. the warning hue via `.is-modified`).
  if (options.collapsed !== undefined) {
    const chevron = iconLabel(options.collapsed ? NERDFONT.NAV.CHEVRON_RIGHT : NERDFONT.NAV.CHEVRON_DOWN);
    chevron.addCssClass('label');
    row.append(chevron);
  }
  // A modified file is flagged by a warning dot; otherwise the file-type glyph leads the name
  // (the diff header opts out of the glyph entirely).
  if (options.modified) {
    const dot = iconLabel(Icons.modified);
    dot.addCssClass('label');
    row.append(dot);
  } else if (options.icon !== false) {
    const icon = iconLabel(fileIconGlyph(Path.basename(path), false));
    icon.addCssClass('icon');
    row.append(icon);
  }

  const name = new Gtk.Label({ xalign: 0, hexpand: true });
  // A deleted file gets a dimmed `(deleted)` tag after the path (diff surface).
  const deleted = options.deleted ? ` <span alpha="55%">(deleted)</span>` : '';
  if (options.boldPath) {
    name.setMarkup(`<b>${escapeMarkup(label)}</b>${deleted}`); // whole path, one uniform highlight
  } else {
    const dir = Path.dirname(label);
    const base = Path.basename(label);
    const dirMarkup = dir && dir !== '.' ? `<span alpha="55%">${escapeMarkup(dir)}/</span>` : '';
    name.setMarkup(`${dirMarkup}<b>${escapeMarkup(base)}</b>${deleted}`);
  }
  name.addCssClass('label');
  row.append(name);

  // Change stats (diff surface): `+N` added (green), `−M` removed (red).
  if (options.added || options.removed) {
    if (options.added) {
      const add = new Gtk.Label({ label: `+${options.added}` });
      add.addCssClass('add');
      row.append(add);
    }
    if (options.removed) {
      const del = new Gtk.Label({ label: `−${options.removed}` });
      del.addCssClass('del');
      row.append(del);
    }
  }

  // Click the header → hand the press count to the surface (single vs double).
  const click = new Gtk.GestureClick();
  click.on('released', (nPress: number) => onActivate(nPress));
  scope.addController(row, click); // severed when this band's widget is dropped (rule 9)
  return row;
}

/** A gap band — a fold marker (not a navigable buffer row), anchored between two diff windows (or
 *  above a file's first content row for the elided head) via `BlockDecorations`. `label` is the
 *  marker text, git-patch style (the diff passes a `@@ … @@` hunk header, search just the enclosing
 *  section — see `enclosingSection`; both fall back to `⋯`). `onActivate`
 *  (click) expands more context. The band is an OPAQUE box wrapping the text label so the text's
 *  `--dim-opacity` never makes the band's background transparent (it must always cover the rows
 *  behind it). */
export function buildGapWidget(
  scope: CompositeDisposable,
  label: string,
  onActivate?: () => void,
): InstanceType<typeof Gtk.Widget> {
  const band = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
  band.addCssClass('MultiBufferGap'); // opaque grey fill + padding (the fold-marker band)
  const text = new Gtk.Label({ label, xalign: 0, hexpand: true });
  text.addCssClass('text'); // the dimmed marker text (dim lives here, not on the band)
  band.append(text);
  if (onActivate) {
    const click = new Gtk.GestureClick();
    click.on('released', () => onActivate());
    scope.addController(band, click); // severed when this band's widget is dropped (rule 9)
  }
  return band;
}
