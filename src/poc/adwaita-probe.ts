#!/usr/bin/env node
/*
 * POC / probe: does Gtk.StyleContext.lookup_color() resolve libadwaita's colors
 * at runtime? lookup_color reads the legacy @define-color registry (underscore
 * names: accent_color), which libadwaita keeps alongside the CSS variables
 * (dash names: --accent-color). We test every color variable from the doc in
 * BOTH dark and light, and also probe the non-color helpers (opacity/radius) to
 * confirm they do NOT resolve as colors. Prints a coverage table, writes JSON to
 * /tmp/adwaita-probe.json, and quits.
 *
 *   node src/poc/adwaita-probe.ts
 */
import { createRequire } from 'node:module';
import * as Fs from 'node:fs';

const require_ = createRequire(import.meta.url);
const gi = require_('node-gtk') as typeof import('node-gtk');
const GLib = gi.require('GLib', '2.0');
const Gtk = gi.require('Gtk', '4.0');
const Adw = gi.require('Adw', '1');

// Every color variable listed in the libadwaita css-variables doc, by category.
// Names are the CSS-variable name minus the leading `--`, with `-` kept; we probe
// lookup_color with the underscore form (accent-bg-color -> accent_bg_color).
const COLOR_VARS: Record<string, string[]> = {
  accent: [
    'accent-bg-color', 'accent-fg-color', 'accent-color',
    'accent-blue', 'accent-teal', 'accent-green', 'accent-yellow',
    'accent-orange', 'accent-red', 'accent-pink', 'accent-purple', 'accent-slate',
  ],
  destructive: ['destructive-bg-color', 'destructive-fg-color', 'destructive-color'],
  success: ['success-bg-color', 'success-fg-color', 'success-color'],
  warning: ['warning-bg-color', 'warning-fg-color', 'warning-color'],
  error: ['error-bg-color', 'error-fg-color', 'error-color'],
  window: ['window-bg-color', 'window-fg-color'],
  view: ['view-bg-color', 'view-fg-color'],
  headerbar: [
    'headerbar-bg-color', 'headerbar-fg-color', 'headerbar-border-color',
    'headerbar-backdrop-color', 'headerbar-shade-color', 'headerbar-darker-shade-color',
  ],
  sidebar: [
    'sidebar-bg-color', 'sidebar-fg-color', 'sidebar-backdrop-color',
    'sidebar-border-color', 'sidebar-shade-color',
  ],
  secondarySidebar: [
    'secondary-sidebar-bg-color', 'secondary-sidebar-fg-color', 'secondary-sidebar-backdrop-color',
    'secondary-sidebar-border-color', 'secondary-sidebar-shade-color',
  ],
  card: ['card-bg-color', 'card-fg-color', 'card-shade-color'],
  overview: ['overview-bg-color', 'overview-fg-color', 'thumbnail-bg-color', 'thumbnail-fg-color'],
  activeToggle: ['active-toggle-bg-color', 'active-toggle-fg-color'],
  dialog: ['dialog-bg-color', 'dialog-fg-color'],
  popover: ['popover-bg-color', 'popover-fg-color', 'popover-shade-color'],
  misc: ['shade-color', 'scrollbar-outline-color', 'border-color'],
  palette: ([] as string[]).concat(
    ...['blue', 'green', 'yellow', 'orange', 'red', 'purple', 'brown', 'light', 'dark'].map(
      (hue) => [1, 2, 3, 4, 5].map((n) => `${hue}-${n}`),
    ),
  ),
};

// Non-color helpers — should NOT resolve via lookup_color (proves color-only).
const NON_COLOR_VARS = ['border-opacity', 'dim-opacity', 'disabled-opacity', 'window-radius'];

function toHex(rgba: any): string {
  const c = (v: number): string => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  const base = `#${c(rgba.red)}${c(rgba.green)}${c(rgba.blue)}`;
  return rgba.alpha < 0.999 ? `${base}${c(rgba.alpha)}` : base;
}

function lookup(ctx: any, cssName: string): { ok: boolean; hex?: string } {
  const named = cssName.replace(/-/g, '_');
  // node-gtk returns [gboolean, Gdk.RGBA] for (gboolean lookup_color(name, out color)).
  const res = ctx.lookupColor(named);
  let ok: boolean;
  let color: any;
  if (Array.isArray(res)) { [ok, color] = res; } else { ok = !!res; color = (ctx as any).__lastColor; }
  return ok && color ? { ok: true, hex: toHex(color) } : { ok: false };
}

function probeScheme(label: string): Record<string, Record<string, { ok: boolean; hex?: string }>> {
  const widget = new Gtk.Label({ label: 'probe' });
  // Realize-free: the display-wide Adwaita provider is in the style cascade.
  const ctx = (widget as any).getStyleContext();
  const out: Record<string, Record<string, { ok: boolean; hex?: string }>> = {};
  for (const [cat, names] of Object.entries(COLOR_VARS)) {
    out[cat] = {};
    for (const name of names) out[cat][name] = lookup(ctx, name);
  }
  out['_nonColor'] = {};
  for (const name of NON_COLOR_VARS) out['_nonColor'][name] = lookup(ctx, name);
  return out;
}

const app = new Adw.Application({ applicationId: 'com.github.romgrk.zym.adwaitaprobe' });

app.on('activate', () => {
  const sm = Adw.StyleManager.getDefault();
  const result: Record<string, any> = {};

  sm.setColorScheme(Adw.ColorScheme.FORCE_DARK);
  result.dark = probeScheme('dark');
  sm.setColorScheme(Adw.ColorScheme.FORCE_LIGHT);
  result.light = probeScheme('light');

  // ---- report ----
  const lines: string[] = [];
  let total = 0, resolvedDark = 0, resolvedLight = 0;
  for (const [cat, names] of Object.entries(COLOR_VARS)) {
    lines.push(`\n## ${cat}`);
    for (const name of names) {
      total++;
      const d = result.dark[cat][name];
      const l = result.light[cat][name];
      if (d.ok) resolvedDark++;
      if (l.ok) resolvedLight++;
      const mark = d.ok && l.ok ? 'OK ' : d.ok || l.ok ? '~  ' : 'NO ';
      lines.push(`  [${mark}] --${name.padEnd(30)} dark=${(d.hex ?? '—').padEnd(10)} light=${l.hex ?? '—'}`);
    }
  }
  lines.push(`\n## _nonColor (expected: NO)`);
  for (const name of NON_COLOR_VARS) {
    const d = result.dark['_nonColor'][name];
    lines.push(`  [${d.ok ? 'OK?' : 'NO '}] --${name.padEnd(30)} ${d.hex ?? '—'}`);
  }
  lines.push(`\n=== ${resolvedDark}/${total} resolved (dark), ${resolvedLight}/${total} (light) ===`);

  console.log(lines.join('\n'));
  Fs.writeFileSync('/tmp/adwaita-probe.json', JSON.stringify(result, null, 2));
  console.log('\nwrote /tmp/adwaita-probe.json');

  app.quit();
});

app.run([]);
GLib.MainLoop.new(null, false); // keep gi alive if needed
