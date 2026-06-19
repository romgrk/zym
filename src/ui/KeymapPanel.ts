/*
 * KeymapPanel — a reference table of every registered keybinding. One row per
 * binding with columns: keys · command · description · selector · source. The
 * source is the registration origin (built-in `default`, the user's
 * `keymap.json`, the `vim-mode-plus` layer, …). Bindings shadowed by a
 * higher-priority one for the same selector + keystroke (e.g. a user override of
 * a default) are dimmed.
 *
 * It reads `quilx.keymaps.getAllBindings()` and refreshes on
 * `onBindingsChanged`, so a live `keymap.json` edit updates it. Built on a
 * `Gtk.Grid` so the columns align; the scrollable table is exposed via `root`.
 */
import { Gtk } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { fonts } from '../fonts.ts';
import { theme } from '../theme/theme.ts';
import { quilx } from '../quilx.ts';
import { Key } from '../keymap/Key.ts';
import type { BindingInfo } from '../KeymapManager.ts';

const KEY_COLOR = theme.ui.text.accent;

// Friendlier names for the known registration sources; others show verbatim.
const SOURCE_LABELS: Record<string, string> = {
  'default-keymap': 'default',
  'user-keymap': 'user',
};
// Row sort order by source; unknown sources sort after these, alphabetically.
const SOURCE_ORDER = ['default-keymap', 'user-keymap'];

const COLUMNS = ['Keys', 'Command', 'Selector', 'Source'];

addStyles(`
  #KeymapPanel .keymap-th {
    font-weight: bold;
    opacity: 0.5;
    padding-bottom: 0.3em;
  }
  #KeymapPanel .keymap-muted { opacity: 0.55; }
`);

function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Whether `keystroke` (a space-separated sequence like "space l d") begins with
// the in-progress `queue` of keys. Empty queue matches everything.
function matchesQueue(keystroke: string, queue: Key[]): boolean {
  if (queue.length === 0) return true;
  const tokens = keystroke.split(/\s+/);
  if (tokens.length < queue.length) return false;
  for (let i = 0; i < queue.length; i++) {
    const k = Key.fromDescription(tokens[i]);
    if (!k || !queue[i].equals(k)) return false;
  }
  return true;
}

export class KeymapPanel {
  readonly root: InstanceType<typeof Gtk.ScrolledWindow>;

  private readonly grid: InstanceType<typeof Gtk.Grid>;
  private readonly subscriptions: Array<{ dispose(): void }> = [];

  constructor() {
    this.grid = new Gtk.Grid();
    this.grid.setColumnSpacing(20);
    this.grid.setRowSpacing(3);
    this.grid.setMarginTop(8);
    this.grid.setMarginBottom(8);
    this.grid.setMarginStart(12);
    this.grid.setMarginEnd(12);

    this.root = new Gtk.ScrolledWindow();
    this.root.setName('KeymapPanel'); // selector identity for keymap + CSS
    this.root.setChild(this.grid);
    this.root.setVexpand(true);

    this.refresh();
    // Live-refresh on registration changes (e.g. a user keymap.json edit).
    this.subscriptions.push(quilx.keymaps.onBindingsChanged(() => this.refresh()));
    // While a multi-key sequence is in progress, narrow the table to the
    // bindings whose keystroke extends the queued prefix (and back to all when
    // the queue clears). Mirrors the which-key hint, but over the full table.
    // Only when the panel is actually on screen: rebuilding the whole grid is
    // expensive, this fires on every queued key, and there is one of these
    // panels per workbench — refreshing hidden ones would stall typing.
    this.subscriptions.push(
      quilx.keymaps.onPendingChanged(() => {
        if (this.root.getMapped()) this.refresh();
      }),
    );
    // Catch up to the current bindings when the panel becomes visible, since
    // pending-change refreshes are skipped while it is hidden.
    this.root.on('map', () => this.refresh());
  }

  /** Move keyboard focus into the table. */
  focus(): void {
    this.grid.grabFocus();
  }

  dispose(): void {
    for (const sub of this.subscriptions) sub.dispose();
  }

  private refresh(): void {
    let child = this.grid.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.grid.remove(child);
      child = next;
    }

    COLUMNS.forEach((title, col) => {
      const label = new Gtk.Label({ xalign: 0, label: title });
      label.addCssClass('keymap-th');
      this.grid.attach(label, col, 0, 1, 1);
    });

    const queue = quilx.keymaps.queuedKeystrokes;
    const bindings = this.sorted(
      quilx.keymaps.getAllBindings().filter((b) => matchesQueue(b.keystroke, queue)),
    );

    // Highest priority wins per (selector, keystroke); lower ones are shadowed.
    const winningPriority = new Map<string, number>();
    for (const b of bindings) {
      const k = `${b.selector} ${b.keystroke}`;
      winningPriority.set(k, Math.max(winningPriority.get(k) ?? -Infinity, b.priority));
    }

    bindings.forEach((b, i) => {
      const overridden = b.priority < (winningPriority.get(`${b.selector} ${b.keystroke}`) ?? b.priority);
      this.addRow(b, i + 1, overridden);
    });
  }

  private sorted(bindings: BindingInfo[]): BindingInfo[] {
    const rank = (source: string) => {
      const i = SOURCE_ORDER.indexOf(source);
      return i === -1 ? SOURCE_ORDER.length : i;
    };
    return [...bindings].sort(
      (a, b) =>
        rank(a.source) - rank(b.source) ||
        a.source.localeCompare(b.source) ||
        a.selector.localeCompare(b.selector) ||
        a.keystroke.localeCompare(b.keystroke),
    );
  }

  private addRow(binding: BindingInfo, row: number, overridden: boolean): void {
    const description = quilx.commands.descriptionFor(binding.command) ?? '';
    const source = SOURCE_LABELS[binding.source] ?? binding.source;

    const mono = fonts.monospaceFamily;
    const cells = [
      // keys — accent, bold, monospace
      this.markupCell(
        `<span foreground="${KEY_COLOR}" weight="bold" font_family="${mono}">${escapeMarkup(binding.keystroke)}</span>`,
      ),
      // command — monospace
      this.markupCell(`<span font_family="${mono}">${escapeMarkup(binding.command || '—')}</span>`),
      // selector — monospace, muted
      this.markupCell(`<span font_family="${mono}">${escapeMarkup(binding.selector)}</span>`, true),
      // source — muted
      this.textCell(source, true),
    ];

    // The command description is a hover hint on the whole row, not a column.
    const tip = [description, overridden ? 'Overridden by a higher-priority binding' : '']
      .filter(Boolean)
      .join('\n');

    cells.forEach((cell, col) => {
      if (overridden) cell.setOpacity(0.4);
      if (tip) cell.setTooltipText(tip);
      this.grid.attach(cell, col, row, 1, 1);
    });
  }

  private markupCell(markup: string, muted = false): InstanceType<typeof Gtk.Label> {
    const label = new Gtk.Label({ xalign: 0, useMarkup: true });
    label.setMarkup(markup);
    if (muted) label.addCssClass('keymap-muted');
    return label;
  }

  private textCell(text: string, muted = false): InstanceType<typeof Gtk.Label> {
    const label = new Gtk.Label({ xalign: 0, label: text });
    if (muted) label.addCssClass('keymap-muted');
    return label;
  }
}
