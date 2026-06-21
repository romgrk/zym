/*
 * HeaderBands — the filename "header" shown above each excerpt in a multibuffer, as a
 * real Gtk widget (icon + dimmed directory + bold basename) rather than a row of buffer text.
 * `SearchResultsView` anchors one above each excerpt's first row via `BlockDecorations` (a
 * reserved band, zero buffer footprint), so the filename isn't navigable/selectable text and
 * doesn't occupy a buffer line. Clicking it jumps to the file (the role Enter-on-the-header
 * row used to play).
 */
import * as Path from 'node:path';
import { Gtk, Pango } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { fileIconGlyph } from './fileIcons.ts';
import { escapeMarkup } from './proseMarkup.ts';

addStyles(`
  .mb-header {
    padding: 2px 8px 2px 6px;
    background-color: var(--t-ui-surface-selected);
  }
  .mb-header-icon { color: var(--t-ui-text-muted); }
  .mb-header-label { color: var(--t-ui-editor-foreground); }
  .mb-gap { color: var(--t-ui-text-muted); padding: 1px 8px 1px 6px; }
  /* The standalone fold-marker band gets a grey fill (distinct from the header's color); the
     leading-gap line inside the header keeps the header background (only the muted text color). */
  .mb-gap-band { background-color: rgba(128, 128, 128, 0.15); }
  .mb-gap-clickable:hover { color: var(--t-ui-text-accent); }
`);

/** The header widget for one excerpt: `label` is the display path (dir dimmed, basename bold),
 *  `path` selects the file-type icon, `onActivate` fires on click (jump to the file). `subtitle`
 *  (a diff's leading `⋯` gap) renders a dim line beneath the filename. */
export function buildHeaderWidget(
  label: string,
  path: string,
  onActivate: () => void,
  subtitle?: string,
): InstanceType<typeof Gtk.Widget> {
  const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  outer.addCssClass('mb-header');

  const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
  const icon = new Gtk.Label({ label: fileIconGlyph(Path.basename(path), false) });
  const attrs = Pango.AttrList.new();
  attrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));
  icon.setAttributes(attrs);
  icon.addCssClass('mb-header-icon');
  row.append(icon);

  const name = new Gtk.Label({ xalign: 0, hexpand: true });
  const dir = Path.dirname(label);
  const base = Path.basename(label);
  const dirMarkup = dir && dir !== '.' ? `<span alpha="55%">${escapeMarkup(dir)}/</span>` : '';
  name.setMarkup(`${dirMarkup}<b>${escapeMarkup(base)}</b>`);
  name.addCssClass('mb-header-label');
  row.append(name);
  outer.append(row);

  if (subtitle) {
    const sub = new Gtk.Label({ label: subtitle, xalign: 0 });
    sub.addCssClass('mb-gap'); // same muted color as the trailing/between gap bands
    outer.append(sub);
  }

  const click = new Gtk.GestureClick();
  click.on('released', () => onActivate());
  outer.addController(click);
  return outer;
}

/** A `⋯ N unchanged lines` gap band — a dim label (not a navigable buffer row), anchored between
 *  two diff windows via `BlockDecorations`. `onActivate` (click) expands more context. */
export function buildGapWidget(label: string, onActivate?: () => void): InstanceType<typeof Gtk.Widget> {
  const widget = new Gtk.Label({ label, xalign: 0 });
  widget.addCssClass('mb-gap');
  widget.addCssClass('mb-gap-band'); // grey fill (the standalone band, vs the in-header subtitle)
  if (onActivate) {
    widget.addCssClass('mb-gap-clickable');
    const click = new Gtk.GestureClick();
    click.on('released', () => onActivate());
    widget.addController(click);
  }
  return widget;
}
