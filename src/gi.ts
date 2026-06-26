/*
 * node-gtk bootstrap.
 *
 * Loads the GObject-introspection namespaces once and re-exports them with full
 * type information (resolved from node-gtk's generated `.d.ts` shim). Everything
 * else in the app imports the typed namespaces from here rather than touching
 * node-gtk directly.
 */
import { createRequire } from 'node:module';

// node-gtk is a CommonJS native addon, so load it through createRequire to keep
// this an ES module. The cast restores the types lost to createRequire's
// untyped `require`.
const gi = createRequire(import.meta.url)('node-gtk') as typeof import('node-gtk');

export const GLib = gi.require('GLib', '2.0');
export const GObject = gi.require('GObject', '2.0');
export const Gio = gi.require('Gio', '2.0');
export const Pango = gi.require('Pango', '1.0');
export const PangoCairo = gi.require('PangoCairo', '1.0');
export const Gdk = gi.require('Gdk', '4.0');
export const GdkPixbuf = gi.require('GdkPixbuf', '2.0');
export const Gsk = gi.require('Gsk', '4.0');
export const Graphene = gi.require('Graphene', '1.0');
export const Gtk = gi.require('Gtk', '4.0');
export const Adw = gi.require('Adw', '1');
export const GtkSource = gi.require('GtkSource', '5');
export const Vte = gi.require('Vte', '3.91');

/** Cooperatively drive GLib's main loop from Node's event loop. */
export function startLoop(): void {
  gi.startLoop();
}

/** Register a JS subclass of a GObject type so its vfunc overrides take effect. */
export function registerClass(klass: unknown): void {
  (gi as any).registerClass(klass);
}

// Instance-type aliases for the widgets we hold references to across methods.
// (The namespaces above are runtime values; these recover the matching types.)
export type Application = InstanceType<typeof Adw.Application>;
export type ApplicationWindow = InstanceType<typeof Adw.ApplicationWindow>;
export type WindowTitle = InstanceType<typeof Adw.WindowTitle>;
export type ToastOverlay = InstanceType<typeof Adw.ToastOverlay>;
export type SourceBuffer = InstanceType<typeof GtkSource.Buffer>;
export type SourceView = InstanceType<typeof GtkSource.View>;
export type VimContext = InstanceType<typeof GtkSource.VimIMContext>;
export type VteTerminal = InstanceType<typeof Vte.Terminal>;
