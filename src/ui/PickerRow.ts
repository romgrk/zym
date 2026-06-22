/*
 * PickerRow — the row layout primitives a Picker caller chooses between. The
 * Picker itself is layout-agnostic: it computes fuzzy matches and hands each
 * (item, positions) pair to the caller's `renderRow`, which builds the widget —
 * usually by computing the markup for each piece (with the helpers in
 * pickerHighlight) and passing it to one of the renderers here.
 *
 * `renderRowSingleLine` is the default: a main label, optionally with a leading
 * icon and a right-aligned muted detail. `renderRowStacked` puts a muted detail
 * on a second line below the main label (e.g. the file picker's filename over
 * its directory). Both take already-built Pango markup so the caller controls
 * highlighting, prose vs. plain text, and emphasis.
 */
import { Gtk, Pango } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { iconSpan } from './icons.ts';

addStyles(/* css */`
  /* Right-aligned muted detail column (single-line rows). Highlights still show
     through the dimming. */
  #PickerRow > .picker-detail {
    margin-left: 1em;
    opacity: 0.5;
  }
  /* Second line of a stacked row (e.g. the file picker's directory): muted and a
     touch smaller, sitting tight under the main label. */
  #PickerRow > .picker-detail-line {
    opacity: 0.5;
    font-size: 0.9em;
  }
`);

/**
 * The pieces of a row, as already-built Pango markup. The caller computes these
 * from its item (highlighting matched positions via `highlightMarkup` /
 * `highlightSegment`) and hands them to a renderer.
 */
export interface RowParts {
  /** Leading icon glyph (Nerd Font), rendered before the main markup. */
  icon?: string;
  /** Colour for `icon` (e.g. a CI/PR state colour); default follows the text. */
  iconColor?: string;
  /** The row's main label, as Pango markup. */
  main: string;
  /** Optional secondary text, as Pango markup (right of `main`, or below it). */
  detail?: string;
  /**
   * Whether the detail is dimmed (the muted `.picker-detail` look). Default true;
   * set false when the caller controls emphasis in the markup itself (e.g. the
   * command palette's bold keybinding column). Single-line only.
   */
  detailMuted?: boolean;
  /** Dim the whole row (e.g. a command shown but not currently applicable). */
  dim?: boolean;
  /**
   * Make the detail the column that crops, not the main. Ellipsizes the detail
   * from the *start* (keeping a path's `filename:line` tail visible) so the main
   * keeps priority on the row's width. Single-line only.
   */
  cropDetail?: boolean;
}

/** Prepend the optional leading icon (in the icon font) to the main markup. */
function withIcon(parts: RowParts): string {
  return parts.icon ? `${iconSpan(parts.icon, parts.iconColor)} ${parts.main}` : parts.main;
}

/**
 * A single-line row: a main label that crops to the card width, optionally with a
 * leading icon and a right-aligned muted detail that keeps its natural width.
 */
export function renderRowSingleLine(parts: RowParts): InstanceType<typeof Gtk.Widget> {
  const mainMarkup = withIcon(parts);

  if (parts.detail === undefined) {
    const label = new Gtk.Label({ xalign: 0, useMarkup: true });
    label.setMarkup(mainMarkup);
    label.setName('PickerRow');
    // Crop a long label to the card width rather than widening the row.
    label.setHexpand(true);
    label.setEllipsize(Pango.EllipsizeMode.END);
    if (parts.dim) label.setOpacity(0.4);
    return label;
  }

  // Main label on the left, a right-aligned muted detail on the right. The main
  // label expands and ellipsizes so a long label crops to the picker width rather
  // than pushing the detail off the edge; the detail keeps its natural width so it
  // always shows in full (unless `cropDetail`).
  const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
  box.setName('PickerRow');
  const main = new Gtk.Label({ xalign: 0, useMarkup: true });
  main.setMarkup(mainMarkup);
  main.setHexpand(true);
  main.setEllipsize(Pango.EllipsizeMode.END);
  box.append(main);
  const detail = new Gtk.Label({ xalign: 1, useMarkup: true });
  detail.setMarkup(parts.detail);
  if (parts.cropDetail) {
    // Let the detail shrink so it — not the main — yields when the row is tight:
    // ellipsizing from the start keeps the path's `filename:line` tail visible.
    detail.setEllipsize(Pango.EllipsizeMode.START);
  }
  // Dimmed by default; an un-muted detail keeps the spacing but not the opacity
  // (the caller's markup sets its own emphasis).
  if (parts.detailMuted === false) detail.setMarginStart(16);
  else detail.addCssClass('picker-detail');
  box.append(detail);
  if (parts.dim) box.setOpacity(0.4);
  return box;
}

/**
 * A two-line row: the main label on top, a muted detail on a second line below
 * (e.g. a filename over its directory). Both lines crop to the card width.
 */
export function renderRowStacked(parts: RowParts): InstanceType<typeof Gtk.Widget> {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
  box.setName('PickerRow');
  box.addCssClass('picker-row-stacked');

  const main = new Gtk.Label({ xalign: 0, useMarkup: true });
  main.setMarkup(withIcon(parts));
  main.setHexpand(true);
  main.setEllipsize(Pango.EllipsizeMode.END);
  box.append(main);

  if (parts.detail) {
    const detail = new Gtk.Label({ xalign: 0, useMarkup: true });
    detail.setMarkup(parts.detail);
    detail.setHexpand(true);
    detail.setEllipsize(Pango.EllipsizeMode.END);
    detail.addCssClass('picker-detail-line');
    box.append(detail);
  }

  if (parts.dim) box.setOpacity(0.4);
  return box;
}
