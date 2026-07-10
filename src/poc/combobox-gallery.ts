#!/usr/bin/env node
/*
 * POC: a gallery of the real Combobox in every state, so the control — and in
 * particular this branch's floating-label work — can be eyeballed WITHOUT booting
 * the AgentLauncher. Nothing is reimplemented: it mounts the production
 * `src/ui/Combobox.ts` verbatim, so whatever changes there shows up here.
 *
 * The states on display:
 *   - Floating label (Adw.EntryRow-like): a title that RESTS as a placeholder while
 *     the value is empty and FLOATS above once a value is set or the popup opens.
 *     The first cell is empty (resting), the second pre-filled (floated); the
 *     "Toggle empty/filled" button flips a value so the CSS transition is visible.
 *   - The actual AgentLauncher options row (model / permission / effort / agent).
 *   - Plain, untitled combobox.
 *   - special (accent) + muted (dimmed) labels, à la the worktree picker.
 *   - Auto-width: the trigger sizes to its value, clamped to `maxWidth` (long value).
 *   - A searchable list long enough to scroll + fuzzy-filter (branch names).
 *
 * Every combobox reports through `onChange` into the status line at the bottom, so
 * commits are observable. Click (or Tab into) any trigger to open its popover;
 * Up/Down move the highlight, Enter/click commits, Esc/focus-loss reverts.
 *
 * Run:  node src/poc/combobox-gallery.ts
 */
import GLib from 'gi:GLib-2.0';
import Gio from 'gi:Gio-2.0';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import { addStyles, installStyles } from '../styles.ts';
import { registerBundledFonts, fonts } from '../fonts.ts';
import { theme } from '../theme/theme.ts';
import { Combobox } from '../ui/Combobox.ts';
import { CompositeDisposable } from '../util/eventKit.ts';

addStyles(/* css */`
  #ComboboxGalleryPoc { background: var(--view-bg-color); color: var(--t-ui-editor-foreground); }
  #ComboboxGalleryPoc .gallery { padding: 22px; }
  #ComboboxGalleryPoc .section-title {
    font-weight: bold;
    font-size: 1.05em;
    margin-top: 14px;
    margin-bottom: 2px;
  }
  #ComboboxGalleryPoc .section-note { opacity: 0.6; margin-bottom: 10px; }
  #ComboboxGalleryPoc .cell-caption { opacity: 0.55; font-size: 0.85em; margin-bottom: 4px; }
  #ComboboxGalleryPoc .row { padding: 6px 0; }
  #ComboboxGalleryPoc .status {
    margin-top: 18px;
    padding: 8px 12px;
    border-radius: 8px;
    background: var(--t-ui-surface-popover);
    font-family: monospace;
  }
  /* Caller-owned option styling, attached to options via their cssClasses. Unscoped so they
     also apply on the popover's own surface (a separate window from #ComboboxGalleryPoc). */
  .cb-special { color: var(--accent-color); font-weight: bold; }
  .cb-muted { opacity: var(--dim-opacity); }
  /* Linked options row: mirror AgentLauncher's segmented-group styling so it can be eyeballed
     here. (The production rules live in AgentLauncher.ts, scoped to its own options row — this
     is the same mechanism: −1px inset + squared interior corners on the nested entry.) */
  #ComboboxGalleryPoc .linked > .Combobox:not(:first-child) { margin-left: -1px; }
  #ComboboxGalleryPoc .linked > .Combobox:not(:first-child) .ComboboxEntry {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
  }
  #ComboboxGalleryPoc .linked > .Combobox:not(:last-child) .ComboboxEntry {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
`);

// --- realistic option sets (shapes mirror AgentLauncher's, values are illustrative) ---
const MODELS = [
  { value: 'claude-opus-4-8', label: 'opus 4.8' },
  { value: 'claude-sonnet-4-6', label: 'sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'haiku 4.5' },
];
const PERMISSIONS = [
  { value: 'default', label: 'default' },
  { value: 'plan', label: 'plan' },
  { value: 'acceptEdits', label: 'accept edits' },
  { value: 'bypassPermissions', label: 'bypass' },
];
const EFFORTS = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
];
const AGENTS = [
  { value: 'claude', label: 'claude' },
  { value: 'claude-tui', label: 'claude (tui)' },
  { value: 'explore', label: 'explore' },
  { value: 'plan', label: 'plan' },
  { value: 'general-purpose', label: 'general-purpose' },
];
// Worktree picker: two specials up top, then branches — long enough to scroll/filter.
const WORKTREES = [
  { value: '@@create', label: 'create', cssClasses: ['cb-special'] },
  { value: '@@current', label: 'current', cssClasses: ['cb-muted'] },
  { value: 'master', label: 'master' },
  { value: 'feat/combobox-floating-label', label: 'feat/combobox-floating-label' },
  { value: 'feat/agent-conversation-ui', label: 'feat/agent-conversation-ui' },
  { value: 'feat/hide-panels-by-default', label: 'feat/hide-panels-by-default' },
  { value: 'fix/gitpanel-disappears', label: 'fix/gitpanel-disappears' },
  { value: 'fix/exclude-oneshot-from-resume-picker', label: 'fix/exclude-oneshot-from-resume-picker' },
  { value: 'fix/sdk-agent-error-during-execution', label: 'fix/sdk-agent-error-during-execution' },
  { value: 'refactor/coordinate-vocabulary', label: 'refactor/coordinate-vocabulary' },
  { value: 'refactor/remove-editor-background', label: 'refactor/remove-editor-background' },
  { value: 'docs/canonical-keymaps', label: 'docs/canonical-keymaps' },
];

const disposables = new CompositeDisposable();
let setStatus: (text: string) => void = () => {};

// A combobox wired to report its commits into the status line.
function combo(config: ConstructorParameters<typeof Combobox>[0]): Combobox {
  const c = new Combobox({
    ...config,
    onChange: (value) => {
      config.onChange?.(value);
      setStatus(`${config.title ?? '(untitled)'} → ${value}`);
    },
  });
  disposables.add(c);
  return c;
}

// caption + control, stacked.
function cell(caption: string, widget: InstanceType<typeof Gtk.Widget>): InstanceType<typeof Gtk.Box> {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
  const label = new Gtk.Label({ xalign: 0, label: caption });
  label.addCssClass('cell-caption');
  box.append(label);
  // Keep the control at its natural (auto-) width rather than stretching it.
  const holder = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
  holder.setHalign(Gtk.Align.START);
  holder.append(widget);
  box.append(holder);
  return box;
}

// A row of comboboxes rendered as one linked, segmented group (mirrors AgentLauncher's
// options row): childSpacing 0 + the `linked` class. Only the group's outer corners round —
// GTK's :first-child / :last-child (which skip hidden fields) handle that in CSS, no tagging.
function linkedRow(combos: Combobox[]): InstanceType<typeof Gtk.Widget> {
  const row = new Adw.WrapBox({ childSpacing: 0, lineSpacing: 8 });
  row.addCssClass('linked');
  row.setHalign(Gtk.Align.START);
  for (const c of combos) row.append(c.root);
  return row;
}

// section header + a horizontal row of cells.
function section(title: string, note: string, cells: InstanceType<typeof Gtk.Widget>[]): InstanceType<typeof Gtk.Box> {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  const h = new Gtk.Label({ xalign: 0, label: title });
  h.addCssClass('section-title');
  box.append(h);
  const n = new Gtk.Label({ xalign: 0, label: note, wrap: true });
  n.addCssClass('section-note');
  box.append(n);
  const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 24 });
  row.addCssClass('row');
  row.setValign(Gtk.Align.START);
  for (const c of cells) row.append(c);
  box.append(row);
  return box;
}

const loop = GLib.MainLoop.new(null, false);
const app = new Adw.Application({ applicationId: 'com.github.romgrk.zym.poc.combobox', flags: Gio.ApplicationFlags.NON_UNIQUE });

app.on('activate', () => {
  try {
    registerBundledFonts();
    installStyles();
    fonts.init();
    Adw.StyleManager.getDefault().setColorScheme(
      theme.appearance === 'light' ? Adw.ColorScheme.FORCE_LIGHT : Adw.ColorScheme.FORCE_DARK,
    );

    const gallery = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
    gallery.addCssClass('gallery');

    // --- Floating label: the star of this branch -----------------------------------
    const floatEmpty = combo({ title: 'model', options: MODELS, value: '' });
    const floatFilled = combo({ title: 'model', options: MODELS, value: 'claude-opus-4-8' });
    // A cell whose value we toggle empty<->filled so the float transition is visible.
    const floatToggle = combo({ title: 'effort', options: EFFORTS, value: '' });
    const toggleBtn = new Gtk.Button({ label: 'Toggle empty / filled' });
    toggleBtn.setHalign(Gtk.Align.START);
    toggleBtn.setMarginTop(6);
    disposables.connect(toggleBtn, 'clicked', () => {
      floatToggle.setValue(floatToggle.getValue() ? '' : 'medium');
    });
    const toggleCell = cell('toggles — watch the title float', floatToggle.root);
    toggleCell.append(toggleBtn);

    gallery.append(section(
      'Floating label (this branch)',
      'A `title` rests in the value’s place as a placeholder while empty, and floats above once a value is set (or the popup opens). The transition is CSS-driven.',
      [
        cell('empty — title resting as placeholder', floatEmpty.root),
        cell('filled — title floated above the value', floatFilled.root),
        toggleCell,
      ],
    ));

    // --- The real AgentLauncher options row ----------------------------------------
    gallery.append(section(
      'AgentLauncher options row',
      'The production usage: four titled comboboxes side by side. Changing one fires onChange (see the status line).',
      [
        cell('model', combo({ title: 'model', options: MODELS, value: 'claude-opus-4-8' }).root),
        cell('permission', combo({ title: 'permission', options: PERMISSIONS, value: 'default' }).root),
        cell('effort', combo({ title: 'effort', options: EFFORTS, value: 'high' }).root),
        cell('agent', combo({ title: 'agent', options: AGENTS, value: 'claude' }).root),
      ],
    ));

    // --- The linked options row (this branch) --------------------------------------
    gallery.append(section(
      'Linked options row (this branch)',
      'The same options rendered as one segmented, `linked` group: the fields sit flush and share a single seam, with only the group’s outer corners rounded. Model is always shown, right after Agent.',
      [linkedRow([
        combo({ title: 'agent', options: AGENTS, value: 'claude' }),
        combo({ title: 'model', options: MODELS, value: 'claude-opus-4-8' }),
        combo({ title: 'permission', options: PERMISSIONS, value: 'default' }),
        combo({ title: 'effort', options: EFFORTS, value: 'high' }),
        combo({ title: 'worktree', options: WORKTREES, value: '@@create' }),
      ])],
    ));

    // --- Plain (no title) ----------------------------------------------------------
    gallery.append(section(
      'Plain (no title)',
      'No floating label — the trigger renders like a button and shows the bare value.',
      [
        cell('untitled', combo({ options: MODELS, value: 'claude-sonnet-4-6' }).root),
      ],
    ));

    // --- Special / muted labels ----------------------------------------------------
    gallery.append(section(
      'Per-option cssClasses (worktree picker)',
      'Each option carries its own `cssClasses`, forwarded to its list row and (when selected) the trigger — the Combobox itself is style-agnostic. Here `create` → `.cb-special` (accent) and `current` → `.cb-muted` (dimmed), both defined by this POC. Open it to see the styled rows; the list is searchable and scrolls.',
      [
        cell('value = create (.cb-special / accent)', combo({
          title: 'worktree', options: WORKTREES, value: '@@create',
        }).root),
        cell('value = current (.cb-muted / dimmed)', combo({
          title: 'worktree', options: WORKTREES, value: '@@current',
        }).root),
      ],
    ));

    // --- Auto-width & clamping -----------------------------------------------------
    gallery.append(section(
      'Auto-width & clamping',
      'The trigger auto-sizes to fit its value. A long value is clamped to `maxWidth` (here 200px) and shown from its start; open it to read the full text.',
      [
        cell('short value', combo({ title: 'effort', options: EFFORTS, value: 'low' }).root),
        cell('long value — clamped to maxWidth', combo({
          title: 'worktree', options: WORKTREES, value: 'fix/exclude-oneshot-from-resume-picker',
          maxWidth: 200,
        }).root),
      ],
    ));

    // --- A toolbar: open the first combobox post-layout (safe vs. ellipsizing) ------
    const openBtn = new Gtk.Button({ label: 'Open the first combobox' });
    openBtn.setHalign(Gtk.Align.START);
    disposables.connect(openBtn, 'clicked', () => floatEmpty.focus());

    // --- Status line ----------------------------------------------------------------
    const status = new Gtk.Label({ xalign: 0, label: 'last commit: (none yet) — click a trigger, then Up/Down + Enter' });
    status.addCssClass('status');
    status.setHexpand(true);
    setStatus = (text) => status.setText(`last commit: ${text}`);

    const toolbar = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });
    toolbar.setMarginTop(12);
    toolbar.append(openBtn);
    gallery.append(toolbar);
    gallery.append(status);

    const scroller = new Gtk.ScrolledWindow({ vexpand: true });
    scroller.setChild(gallery);

    const root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    root.setName('ComboboxGalleryPoc');
    root.append(scroller);

    const window = new Adw.ApplicationWindow({ application: app });
    window.setName('AppWindow'); // so the --t-* theme CSS variables resolve
    window.setTitle('zym POC — Combobox states');
    window.setDefaultSize(940, 760);
    window.setContent(root);
    window.on('close-request', () => { disposables.dispose(); loop.quit(); app.quit(); return false; });
    window.present();

    loop.run();
  } catch (e) {
    process.stderr.write('[POC] activate threw: ' + (e as Error)?.stack + '\n');
    loop.quit();
    app.quit();
  }
});

// node-gtk #442: defer app.run past the top-level module microtask, or activate
// never fires and the app exits 0.
await new Promise((res) => setTimeout(res, 0));
app.run([]);
