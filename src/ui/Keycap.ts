/*
 * Keycap — a small badge rendering a keybinding in its canonical form (the exact
 * keystroke string from the keymap, e.g. `space f f` or `ctrl-w v`). A monospace
 * pill whose border/background derive from `currentColor`, so it adopts whatever
 * text color its context sets (the muted welcome cheatsheet, a tooltip, …). Use
 * `keycap()` wherever a binding is shown to the user as a discrete chip.
 */
import { Gtk } from '../gi.ts';
import { addStyles } from '../styles.ts';

addStyles(`
  .keycap {
    font-family: var(--t-font-monospace-family, monospace);
    font-size: 0.92em;
    padding: 2px 9px;
    border-radius: 6px;
    border: 1px solid var(--t-ui-border, alpha(currentColor, 0.4));
    background-color: alpha(currentColor, 0.08);
  }
`);

/** A keycap badge labelled with `keys` (a canonical keystroke string). */
export function keycap(keys: string): InstanceType<typeof Gtk.Label> {
  const label = new Gtk.Label({ label: keys });
  label.addCssClass('keycap');
  return label;
}
