/*
 * PluginManagerPanel — lists every registered plugin grouped by source.
 *
 * Each row is an Adw.ExpanderRow with a Gtk.Switch suffix. Clicking the row
 * header expands it to show the plugin's raw package.json in a monospace label.
 * The switch toggles the plugin on/off immediately (persisted to config) without
 * rebuilding the list, so expanded state is preserved.
 *
 * Keyboard bindings (j/k/o/space) are declared in src/keymaps/default.ts under
 * the #PluginManagerPanel selector and dispatched via the quilx command system.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { Adw, Gtk } from '../gi.ts';
import { plugins, disabledPluginIds } from '../plugin/index.ts';
import { saveConfig } from '../config/load.ts';
import { quilx } from '../quilx.ts';
import type { PluginInfo } from '../plugin/PluginRegistry.ts';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface PluginRow {
  expander: InstanceType<typeof Adw.ExpanderRow>;
  sw: InstanceType<typeof Gtk.Switch>;
  info: PluginInfo;
}

export class PluginManagerPanel {
  readonly root: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly content: InstanceType<typeof Gtk.Box>;
  private rows: PluginRow[] = [];

  constructor() {
    this.content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 24 });
    this.content.setMarginTop(24);
    this.content.setMarginBottom(24);
    this.content.setMarginStart(24);
    this.content.setMarginEnd(24);

    const clamp = new Adw.Clamp();
    clamp.setChild(this.content);
    clamp.setMaximumSize(640);

    const viewport = new Gtk.Viewport();
    viewport.setChild(clamp);

    this.root = new Gtk.ScrolledWindow();
    this.root.setName('PluginManagerPanel');
    this.root.setChild(viewport);
    this.root.setHexpand(true);
    this.root.setVexpand(true);

    quilx.commands.add(this.root, {
      'plugin-manager:focus-next':      { didDispatch: () => this.moveFocus(1),            description: 'Focus next plugin row' },
      'plugin-manager:focus-prev':      { didDispatch: () => this.moveFocus(-1),           description: 'Focus previous plugin row' },
      'plugin-manager:toggle-expander': { didDispatch: () => this.toggleFocusedExpander(), description: 'Expand or collapse the focused plugin' },
      'plugin-manager:toggle-switch':   { didDispatch: () => this.toggleFocusedSwitch(),   description: 'Enable or disable the focused plugin' },
    });

    this.refresh();
  }

  refresh(): void {
    this.rows = [];
    let child = this.content.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.content.remove(child);
      child = next;
    }

    const disabled = disabledPluginIds();
    const infos = plugins.list(disabled);
    const builtins = infos.filter((i) => i.source === 'builtin');
    const userPlugins = infos.filter((i) => i.source === 'user');

    if (builtins.length > 0) {
      const group = new Adw.PreferencesGroup();
      group.setTitle('Built-in');
      for (const info of builtins) {
        const row = this.buildRow(info);
        group.add(row.expander);
        this.rows.push(row);
      }
      this.content.append(group);
    }

    if (userPlugins.length > 0) {
      const group = new Adw.PreferencesGroup();
      group.setTitle('User');
      for (const info of userPlugins) {
        const row = this.buildRow(info);
        group.add(row.expander);
        this.rows.push(row);
      }
      this.content.append(group);
    }

    if (infos.length === 0) {
      const status = new Adw.StatusPage();
      status.setTitle('No plugins loaded');
      this.content.append(status);
    }
  }

  private buildRow(info: PluginInfo): PluginRow {
    const expander = new Adw.ExpanderRow();
    expander.setTitle(esc(info.name));
    if (info.description) expander.setSubtitle(esc(info.description));

    // Switch in the header suffix. Non-focusable so Tab/j/k stay on the row;
    // mouse clicks still work. State set before signal connection so the initial
    // setActive() doesn't trigger the handler.
    const sw = new Gtk.Switch();
    sw.setValign(Gtk.Align.CENTER);
    sw.setFocusable(false);
    sw.setActive(!info.disabled);
    sw.on('notify::active', () => void this.toggle(info.id, sw.getActive()));
    expander.addSuffix(sw);

    // Revealed content: formatted package.json in a selectable monospace label.
    const detailBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    detailBox.setMarginTop(8);
    detailBox.setMarginBottom(8);
    detailBox.setMarginStart(16);
    detailBox.setMarginEnd(16);

    const label = new Gtk.Label({ xalign: 0, yalign: 0 });
    label.setSelectable(true);
    try {
      const raw = Fs.readFileSync(Path.join(info.dir, 'package.json'), 'utf8');
      const formatted = JSON.stringify(JSON.parse(raw), null, 2);
      label.setMarkup(`<tt>${esc(formatted)}</tt>`);
    } catch {
      label.setMarkup(`<tt><i>(package.json unavailable)</i></tt>`);
    }
    detailBox.append(label);
    expander.addRow(detailBox);

    return { expander, sw, info };
  }

  // Find the row that contains (or is) the currently focused widget.
  private getFocusedRow(): PluginRow | null {
    const window = this.root.getRoot() as InstanceType<typeof Gtk.Window> | null;
    const focused = window?.getFocus() as InstanceType<typeof Gtk.Widget> | null;
    if (!focused) return null;
    return this.rows.find((r) => focused === r.expander || focused.isAncestor(r.expander)) ?? null;
  }

  private moveFocus(delta: number): void {
    if (this.rows.length === 0) return;
    const current = this.rows.indexOf(this.getFocusedRow()!);
    const from = current >= 0 ? current : (delta > 0 ? -1 : this.rows.length);
    const next = Math.max(0, Math.min(this.rows.length - 1, from + delta));
    this.rows[next].expander.grabFocus();
  }

  private toggleFocusedExpander(): void {
    const row = this.getFocusedRow();
    if (!row) return;
    row.expander.setExpanded(!row.expander.getExpanded());
  }

  private toggleFocusedSwitch(): void {
    const row = this.getFocusedRow();
    if (!row) return;
    row.sw.setActive(!row.sw.getActive());
  }

  private async toggle(id: string, enable: boolean): Promise<void> {
    const disabled = disabledPluginIds();
    if (enable) {
      disabled.delete(id);
      quilx.config.set('plugins.disabled', [...disabled]);
      saveConfig();
      await plugins.activate(id);
    } else {
      disabled.add(id);
      quilx.config.set('plugins.disabled', [...disabled]);
      saveConfig();
      await plugins.deactivate(id);
    }
  }
}
