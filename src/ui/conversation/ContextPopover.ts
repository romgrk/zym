/*
 * ContextPopover — the detailed breakdown shown when the footer's context gauge is
 * clicked. A `Gtk.Popover` managed by the footer `Gtk.MenuButton` (the same path the
 * mode `Gtk.DropDown` uses in this footer), holding a
 * two-column grid: the window total broken into input / cache-read / cache-write,
 * then model · cost · this-turn output.
 *
 * Values are formatted with thousands separators and right-aligned with tabular
 * figures so the digits line up. `update()` only rewrites label text — the rows are
 * built once.
 */
import { Gtk, Pango } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import type { ContextUsage } from '../../agents/claude-sdk/SdkSession.ts';

export interface ContextDetail extends ContextUsage {
  model: string | null;
  window: number;
  costUsd: number | null;
}

const n = (v: number): string => v.toLocaleString('en-US');

addStyles(`
  /* The detail popover: a compact two-column key/value grid. */
  .ContextPopover grid { padding: 6px 4px; }
  .ContextPopover .context-popover-title { font-weight: bold; margin-bottom: 2px; }
  .ContextPopover .context-popover-caption { color: var(--t-ui-text-muted); }
`);

export class ContextPopover {
  readonly widget: InstanceType<typeof Gtk.Popover>;

  private readonly values = new Map<string, InstanceType<typeof Gtk.Label>>();
  private row = 0;

  constructor() {
    const grid = new Gtk.Grid({ columnSpacing: 18, rowSpacing: 4 });

    this.heading(grid, 'Context window');
    this.field(grid, 'input', 'Input');
    this.field(grid, 'cacheRead', 'Cache read');
    this.field(grid, 'cacheCreation', 'Cache write');
    this.divider(grid);
    this.field(grid, 'total', 'Total');
    this.field(grid, 'used', 'Used');
    this.divider(grid);
    this.field(grid, 'model', 'Model');
    this.field(grid, 'output', 'Output (turn)');
    this.field(grid, 'cost', 'Cost');

    this.widget = new Gtk.Popover();
    this.widget.addCssClass('ContextPopover');
    this.widget.setChild(grid);
  }

  update(d: ContextDetail): void {
    const pct = d.window > 0 ? Math.round((d.tokens / d.window) * 100) : 0;
    this.set('input', n(d.input));
    this.set('cacheRead', n(d.cacheRead));
    this.set('cacheCreation', n(d.cacheCreation));
    this.set('total', `${n(d.tokens)} / ${n(d.window)}`);
    this.set('used', `${pct}%`);
    this.set('model', d.model ? d.model.replace(/^claude-/, '') : '—');
    this.set('output', n(d.output));
    this.set('cost', d.costUsd != null ? `$${d.costUsd.toFixed(2)}` : '—');
  }

  private set(key: string, text: string): void {
    this.values.get(key)?.setText(text);
  }

  private heading(grid: InstanceType<typeof Gtk.Grid>, text: string): void {
    const label = new Gtk.Label({ label: text, xalign: 0 });
    label.addCssClass('context-popover-title');
    grid.attach(label, 0, this.row++, 2, 1);
  }

  private field(grid: InstanceType<typeof Gtk.Grid>, key: string, name: string): void {
    const caption = new Gtk.Label({ label: name, xalign: 0 });
    caption.addCssClass('context-popover-caption');
    const value = new Gtk.Label({ label: '—', xalign: 1, hexpand: true });
    value.setAttributes(tnum());
    grid.attach(caption, 0, this.row, 1, 1);
    grid.attach(value, 1, this.row, 1, 1);
    this.values.set(key, value);
    this.row++;
  }

  private divider(grid: InstanceType<typeof Gtk.Grid>): void {
    const sep = new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL });
    grid.attach(sep, 0, this.row++, 2, 1);
  }
}

/** Tabular figures so the value column's digits align. */
function tnum(): InstanceType<typeof Pango.AttrList> {
  const list = Pango.AttrList.new();
  list.insert(Pango.attrFontFeaturesNew('tnum=1'));
  return list;
}
