/*
 * WhichKey — a transient hint showing the continuations available after a
 * keymap prefix (e.g. the keys you can press after `Space`). It subscribes to
 * `quilx.keymaps.onPendingChanged`: when a prefix is queued it shows, after a
 * short delay, a card listing each remaining key and the command it runs; when
 * the sequence completes or breaks it hides.
 *
 * The delay keeps quick full sequences (`space w`) from flashing the hint. The
 * card floats at the bottom-centre of the supplied overlay, styled like the
 * picker.
 */
import { GLib, Gtk } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { monospaceFontFamily } from '../fonts.ts';
import { theme } from '../theme/theme.ts';
import { quilx } from '../quilx.ts';
import type { PendingBinding } from '../KeymapManager.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

const SHOW_DELAY_MS = 350;
const MAX_ROWS = 8; // entries per column before spilling into the next
const KEY_COLOR = theme.ui.textAccent ?? '#a9a1e1';
const MONO = monospaceFontFamily(); // keybindings render in the monospace font

addStyles(`
  #WhichKey {
    background-color: var(--popover-bg-color);
    border: 1px solid var(--border-color);
    border-radius: var(--popover-radius);
    box-shadow: 0px 10px 33px 28px rgba(0,0,0,0.15);
    padding: 0.5em 0.75em;
    margin-bottom: 12px;
  }
`);

function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class WhichKey {
  private readonly host: Overlay;
  private panel: InstanceType<typeof Gtk.Widget> | null = null;
  private timer = 0;

  constructor(host: Overlay) {
    this.host = host;
    // which-key interface is disabled for now — don't subscribe to pending
    // prefix changes so the hint card never shows.
    // quilx.keymaps.onPendingChanged((pending) => this.update(pending));
  }

  private update(pending: PendingBinding[] | null): void {
    this.cancelTimer();
    if (!pending || pending.length === 0) {
      this.hide();
      return;
    }
    // Show after a delay so a quickly-completed sequence never flashes.
    this.timer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, SHOW_DELAY_MS, () => {
      this.timer = 0;
      this.show(pending);
      return false; // one-shot
    });
  }

  private show(pending: PendingBinding[]): void {
    this.hide();
    const grid = new Gtk.Grid({ columnSpacing: 24, rowSpacing: 2 });
    grid.setName('WhichKey');
    grid.setHalign(Gtk.Align.CENTER);
    grid.setValign(Gtk.Align.END);

    pending.forEach((binding, i) => {
      grid.attach(this.entry(binding), Math.floor(i / MAX_ROWS), i % MAX_ROWS, 1, 1);
    });

    this.host.addOverlay(grid);
    this.panel = grid;
  }

  // One `key  description` cell: the key in the accent color, the command's
  // description (or its name) muted beside it.
  private entry(binding: PendingBinding): InstanceType<typeof Gtk.Widget> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });

    const key = new Gtk.Label({ xalign: 0, useMarkup: true });
    key.setMarkup(
      `<span foreground="${KEY_COLOR}" weight="bold" font_family="${MONO}">` +
        `${escapeMarkup(prettyKeys(binding.keys))}</span>`,
    );
    box.append(key);

    const label = quilx.commands.descriptions[binding.command] ?? binding.command;
    const cmd = new Gtk.Label({ xalign: 0, useMarkup: true });
    cmd.setMarkup(`<span alpha="65%">${escapeMarkup(label)}</span>`);
    box.append(cmd);

    return box;
  }

  private hide(): void {
    if (this.panel) {
      this.host.removeOverlay(this.panel);
      this.panel = null;
    }
  }

  private cancelTimer(): void {
    if (this.timer) {
      GLib.sourceRemove(this.timer);
      this.timer = 0;
    }
  }
}

// `g l` → `g l`, `ctrl-w` → `ctrl+w` (continuation keys; left lowercase since
// they're literal next presses).
function prettyKeys(keys: string): string {
  return keys
    .split(/\s+/)
    .map((seq) => seq.split('-').join('+'))
    .join(' ');
}
