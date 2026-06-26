/*
 * getActiveElements.ts — the focused widget and its ancestor chain.
 *
 * Ported from xedel's utils/get-active-element.js. Returns the currently focused
 * widget first, then each of its GTK parents up to the window root. Command and
 * keymap lookups walk this list so a binding can target the focused widget or
 * any ancestor.
 *
 * The window is always included as the final element — even when nothing is
 * focused (e.g. no editor is open, so focus has nowhere to land). Otherwise
 * window-scoped bindings like `.AppWindow` pane navigation would silently stop
 * working whenever focus is lost.
 */
import type { Gtk } from '../gi.ts';
import { zym } from '../zym.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

export function getActiveElements(): Widget[] {
  const window = zym.window;
  if (!window)
    return [];

  const activeElement = window.getFocus();
  if (!activeElement)
    return [window];

  const elements: Widget[] = [activeElement];
  let current: Widget | null = activeElement;
  while (current && (current = current.getParent()) !== null) {
    elements.push(current);
  }
  // Normally the parent walk reaches the window; guard in case the focused
  // widget sits outside its tree (e.g. a transient/popover).
  if (!elements.includes(window))
    elements.push(window);

  return elements;
}
