/*
 * KeybindingHints — a muted strip of `[keycap] action` hints (e.g. the Source Control
 * list / commit box). Each binding is a `Keycap` chip (canonical keystroke) next to its
 * action word, paired in a unit that stays together; the units sit in an `Adw.WrapBox`
 * so they wrap onto more lines when the column is narrow. The strip is gated on the
 * `help.showKeybindings` config and tracks it **reactively** (observe): toggling the
 * setting shows/hides it live, with no relayout cost when hidden (GTK drops an invisible
 * child from layout). Dispose to drop the config subscription.
 */
import Adw from 'gi:Adw-1';
import Gtk from 'gi:Gtk-4.0';
import { zym } from '../zym.ts';
import { addStyles } from '../styles.ts';
import { keycap } from './Keycap.ts';

addStyles(/* css */`
  .KeybindingHints {
    color: var(--t-ui-text-muted);
    font-size: var(--t-font-ui-size-small);
    padding: 6px 8px;
  }
  .KeybindingHints .keybinding-action { font-family: var(--t-font-ui-family); }
`);

/** One hint: the canonical keystroke (as written in the keymap) and its action label. */
export type Hint = [keys: string, action: string];

export class KeybindingHints {
  readonly root: InstanceType<typeof Adw.WrapBox>;
  private readonly sub: { dispose(): void };
  private disposed = false;

  constructor(hints: Hint[]) {
    // A WrapBox (not a Box) so the chips wrap onto more lines in a narrow column instead of
    // forcing it wider; `align: 0` left-packs each line. It fills its parent's width (the
    // default halign) — that's what gives it room to wrap.
    this.root = new Adw.WrapBox({ childSpacing: 12, lineSpacing: 4, align: 0 });
    this.root.addCssClass('KeybindingHints');

    for (const [keys, action] of hints) {
      // Keep each keycap glued to its action word so a wrap never splits them.
      const unit = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
      const cap = keycap(keys);
      cap.setValign(Gtk.Align.CENTER);
      unit.append(cap);
      const label = new Gtk.Label({ label: action });
      label.addCssClass('keybinding-action');
      unit.append(label);
      this.root.append(unit);
    }

    // Reactive gate: fires immediately with the current value, then on every change.
    this.sub = zym.config.observe('help.showKeybindings', (v) => this.root.setVisible(!!v));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sub.dispose();
  }
}
