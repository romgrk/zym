/*
 * headerButton — the shared look + [icon][count] content for the agent header bar's
 * icon buttons (subagent / monitor count buttons in HeaderCountButton, and the
 * edited-files badge in AgentSidebar), so all three carry one consistent class and
 * the same 1×spacing gap between the icon and its count.
 */
import Gtk from 'gi:Gtk-4.0';
import { addStyles } from '../styles.ts';
import { iconLabel } from './icons.ts';

addStyles(`
  /* A flat, muted header-bar icon button; the count sits 1×spacing right of the icon. */
  .agent-header-button { min-width: 0; min-height: 0; padding: 0 6px; }
  .agent-header-button label { opacity: 0.6; font-size: var(--t-font-ui-size-small); }
  .agent-header-button:hover label { opacity: 1; }
  .agent-header-button .agent-header-count { margin-left: var(--t-spacing); }
`);

/** Build the `[icon][count]` content for a header-bar button (set it as the button's
 *  child and add the `agent-header-button` class to the button). Returns the box plus
 *  a `setCount` to refresh the trailing number. */
export function headerButtonContent(glyph: string): {
  root: InstanceType<typeof Gtk.Box>;
  setCount: (value: number | string) => void;
} {
  const root = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
  root.append(iconLabel(glyph));
  const count = new Gtk.Label();
  count.addCssClass('agent-header-count');
  root.append(count);
  return { root, setCount: (value) => count.setLabel(String(value)) };
}
