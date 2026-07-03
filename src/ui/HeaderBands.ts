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
  .mb-header {
    padding: var(--t-spacing) calc(2 * var(--t-spacing));
    /* The libadwaita "card" surface, so it tracks the OS light/dark theme. --card-bg-color is
       translucent in dark, and this band must stay opaque to occlude the diff scrolling under it,
       so it's painted over an opaque --window-bg-color base — exactly how a card sits on the window.
       Replaces the old hard-coded editor-bg + 16% white overlay, which read too bright. */
    background-color: var(--window-bg-color);
    background-image: linear-gradient(var(--card-bg-color), var(--card-bg-color));
    border-radius: 5px;
  }
  .mb-header-icon { color: var(--t-ui-text-muted); }
  .mb-header-label { color: var(--t-ui-editor-foreground); }
  .mb-header-add { color: var(--t-ui-status-success); }
  .mb-header-del { color: var(--t-ui-status-error); }
  /* An unsaved (modified) diff file: warning-coloured path led by a warning dot. */
  .mb-header-modified { color: var(--t-ui-status-warning); }
  /* The header whose (read-only) line the caret sits on (sticky-diff navigation) reads as SELECTED,
     using the shared list-selection idiom (docs/styling.md → --selection-bg): a NEUTRAL wash of the
     band's own foreground when the diff is unfocused — promoted to an ACCENT tint + accent outline
     only while the diff editor holds keyboard focus (:focus-within on its .zym-editor source view,
     the header's overlay ancestor). The wash replaces the card overlay (still over the opaque
     --window-bg-color base, so the band never turns translucent). The class lands on the .mb-header
     element itself (the widget IS the row). */
  .mb-header.mb-header-focused {
    background-image: linear-gradient(var(--selection-bg), var(--selection-bg));
  }
  .zym-editor:focus-within .mb-header.mb-header-focused {
    background-image: linear-gradient(var(--selection-bg-focus), var(--selection-bg-focus));
    outline: 1px solid var(--accent-color);
    outline-offset: -1px;
  }
  /* Fold markers (the elided-gap bands): an OPAQUE band that must occlude the diff scrolling under
     it (never transparent, so the rows behind it can't show through). Shares the file header's card
     surface (--card-bg-color over an opaque --window-bg-color base) so the two chrome bands read as
     one family (and track the OS theme together). No padding: a single compact line with the marker
     text flush to the code column. */
  .mb-gap {
    background-color: var(--window-bg-color);
    background-image: linear-gradient(var(--card-bg-color), var(--card-bg-color));
  }
  /* The marker TEXT reads as the editor foreground dimmed via Adwaita's --dim-opacity (the muted
     idiom — dim the real foreground, not a grey). It lives on a child label so the dim never touches
     the band's opaque background. */
  .mb-gap-text { color: var(--t-ui-editor-foreground); opacity: var(--dim-opacity); }
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
  row.addCssClass('mb-header');
  // Collapse chevron (diff surface): chevron-down when the file is expanded, chevron-right when
  // collapsed (the same fold idiom as the syntax gutter; see gutterRenderers.ts). It carries the
  // SAME colour class as the path label below, so it tracks the filename's colour (incl. the
  // warning hue on a modified file).
  if (options.collapsed !== undefined) {
    const chevron = iconLabel(options.collapsed ? NERDFONT.NAV.CHEVRON_RIGHT : NERDFONT.NAV.CHEVRON_DOWN);
    chevron.addCssClass(options.modified ? 'mb-header-modified' : 'mb-header-label');
    row.append(chevron);
  }
  // A modified file is flagged by a warning dot; otherwise the file-type glyph leads the name
  // (the diff header opts out of the glyph entirely).
  if (options.modified) {
    const dot = iconLabel(Icons.modified);
    dot.addCssClass('mb-header-modified');
    row.append(dot);
  } else if (options.icon !== false) {
    const icon = iconLabel(fileIconGlyph(Path.basename(path), false));
    icon.addCssClass('mb-header-icon');
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
  name.addCssClass(options.modified ? 'mb-header-modified' : 'mb-header-label');
  row.append(name);

  // Change stats (diff surface): `+N` added (green), `−M` removed (red).
  if (options.added || options.removed) {
    if (options.added) {
      const add = new Gtk.Label({ label: `+${options.added}` });
      add.addCssClass('mb-header-add');
      row.append(add);
    }
    if (options.removed) {
      const del = new Gtk.Label({ label: `−${options.removed}` });
      del.addCssClass('mb-header-del');
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
 *  marker text (the diff passes a git-patch `@@ … @@` hunk header, search a bare `⋯`). `onActivate`
 *  (click) expands more context. The band is an OPAQUE box wrapping the text label so the text's
 *  `--dim-opacity` never makes the band's background transparent (it must always cover the rows
 *  behind it). */
export function buildGapWidget(
  scope: CompositeDisposable,
  label: string,
  onActivate?: () => void,
): InstanceType<typeof Gtk.Widget> {
  const band = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
  band.addCssClass('mb-gap'); // opaque grey fill + padding (the fold-marker band)
  const text = new Gtk.Label({ label, xalign: 0, hexpand: true });
  text.addCssClass('mb-gap-text'); // the dimmed marker text (dim lives here, not on the band)
  band.append(text);
  if (onActivate) {
    const click = new Gtk.GestureClick();
    click.on('released', () => onActivate());
    scope.addController(band, click); // severed when this band's widget is dropped (rule 9)
  }
  return band;
}
