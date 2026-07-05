/*
 * WorkbenchList — the contents of the WorkbenchSidebar (the full-height column at the
 * very left of the window). The rail is grouped by **project**: each open project is a
 * section headed by its own **default workbench** row (which shows the project name),
 * followed by the agents launched under it (`getGroups`, from the host). See
 * docs/session-management.md "Multi-root".
 *
 * The top is an `Adw.HeaderBar` showing the active session name (see `setSessionName`);
 * it is hidden entirely for the unnamed/default session, so an unnamed window shows the
 * rail flush to the top.
 *
 * Activating a default (project) row invokes `onActivateProject`; an agent row invokes
 * `onActivate`. The rail rebuilds wholesale when the owner set changes (project or agent
 * workbench opened/closed) — grouping/order can shift, so there's no per-row animation.
 *
 * `startJump()` (workbench:jump) is the leap-style quick switch: every row shows a
 * one-letter mark and the next keystroke — grabbed ahead of command dispatch —
 * activates the marked row, exactly like clicking it. Marks render with zero layout
 * shift: an agent row flips its lead slot (a homogeneous Gtk.Stack) from status icon
 * to letter; a project row conceals its title's first character behind the letter
 * (markup swap). See docs/workbench.md.
 *
 * The assembled widget — an `Adw.ToolbarView` with the header bar as a top bar
 * over the scrollable list — is exposed via `root`.
 */
import Pango from 'gi:Pango-1.0';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import { zym } from '../zym.ts';
import { addStyles } from '../styles.ts';
import { fonts } from '../fonts.ts';
import { theme } from '../theme/theme.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import type { Key } from '../keymap/Key.ts';
import { createAgentStatusIcon } from './agentStatusIcon.ts';
import { escapeMarkup } from './proseMarkup.ts';
import { Icons, iconLabel } from './icons.ts';
import type { Agent } from '../agents/types.ts';
import { type Owner, type Project } from './workbench/Owner.ts';

addStyles(/* css */`
  /* The unsaved-changes marker (a small dot) next to the session title — warning-colored. */
  .zym-modified-dot { color: var(--t-ui-status-warning); }

  .WorkbenchRow {
    padding: calc(0.4 * var(--t-spacing)) calc(2 * var(--t-spacing));
  }
  .Workbenchrow--icon {
    margin-right: calc(1.5 * var(--t-spacing));
  }
  .Workbenchrow--label {
    font-weight: bold;
  }
  /* The default row's icon is dimmed to match the exited agent icon (muted foreground). */
  .Workbenchrow--user-icon {
    opacity: var(--dim-opacity);
  }
  /* The default (header) row: dimmed and iconless — its text is the project name. */
  .WorkbenchRow--project {
    opacity: var(--dim-opacity);
  }
  /* Leap-style jump mark (workbench:jump): a bold monospace letter, error-colored to
     match the editor leap marks. On agent rows it swaps in over the status icon. */
  .Workbenchrow--jump {
    font-family: var(--t-font-monospace-family);
    font-weight: bold;
    color: var(--t-ui-status-error);
  }
`);

// Jump labels in assignment order (home row first), one per row in rail order. Rows
// past the alphabet stay unlabeled — unreachable by jump, still one `j/k` away.
const JUMP_LABELS = 'asdfghjklqwertyuiopzxcvbnm';

// The Pango-markup twin of `.Workbenchrow--jump` for the project rows' in-title mark
// (markup can't read CSS vars, so it interpolates the live family/color literals).
function jumpMarkSpan(mark: string): string {
  return `<span face="${fonts.monospaceFamily}" weight="bold" foreground="${theme.ui.status.error}">${escapeMarkup(mark)}</span>`;
}

/** A project and the agents launched under it — the rail's grouped unit. */
export interface ProjectGroup {
  project: Project;
  agents: Agent[];
}

export interface WorkbenchListOptions {
  /** Fired when an agent row is activated (clicked / Enter). */
  onActivate?: (agent: Agent) => void;
  /** Fired when a project's default row is activated. */
  onActivateProject?: (project: Project) => void;
  /** The open projects with their agents, in rail order. */
  getGroups?: () => ProjectGroup[];
  /** Subscribe to owner-set changes (project/agent opened or closed) so the rail
   *  rebuilds; returns an unsubscribe. */
  onProjectsChanged?: (callback: () => void) => { dispose(): void };
  /** Restart an agent (respawn / resume) — the list's `r` key. */
  onRestart?: (agent: Agent) => void;
  /** Stop an agent's process (it stays listed, restartable) — the list's `x` key. */
  onStop?: (agent: Agent) => void;
  /** Close an agent (terminate if running, then remove it from the list) — the `d d` key. */
  onClose?: (agent: Agent) => void;
  /** Rename an agent — the list's `R` key. */
  onRename?: (agent: Agent) => void;
  /** Open the files an agent has edited — the changed-files badge / `o` key. */
  onOpenChanges?: (agent: Agent) => void;
}

// A list entry: a project's default ("you") workbench, or one of its agents.
type Entry = { kind: 'project'; project: Project } | { kind: 'agent'; agent: Agent };

// A built row: its entry, the ListBoxRow, its jump-mark toggles, and the per-row
// unsubscribes (agent title/status). Rebuilt wholesale, so there's no
// removal/animation bookkeeping.
interface RowHandle {
  entry: Entry;
  row: InstanceType<typeof Gtk.ListBoxRow>;
  /** Show this row's jump mark (workbench:jump), with no layout shift: an agent row
   *  flips its lead Stack slot from the status icon to the letter; a project row
   *  conceals its title's first character behind the letter (markup swap). */
  showMark(mark: string): void;
  /** Restore the row (status icon / title) after the jump ends. */
  hideMark(): void;
  unsubs: Array<() => void>;
}

export class WorkbenchList {
  readonly root: InstanceType<typeof Adw.ToolbarView>;

  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly scrolled: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly options: WorkbenchListOptions;
  // The built rows, in list-box order (each project's default row then its agents).
  private handles: RowHandle[] = [];
  // The owner whose row is selected (kept stable across rebuilds); null selects the
  // first default row by default. Reflects the active workbench's owner; see AppWindow.
  private selected: Owner | null = null;
  // The sidebar header bar (the session-name bar). Shown for a named session, or (when
  // unnamed) whenever there are unsaved edits so the modified dot still surfaces; a clean
  // unnamed window hides it so the rail sits flush to the top.
  private headerBar: InstanceType<typeof Adw.HeaderBar> | null = null;
  // The active session's name in the header bar (empty for the unnamed default).
  private headerTitle: InstanceType<typeof Adw.WindowTitle> | null = null;
  // The unsaved-changes marker after the session title; toggled via opacity (slot always
  // reserved). `named`/`modified` are the last-known states driving header visibility.
  private modifiedDot: InstanceType<typeof Gtk.Label> | null = null;
  private named = false;
  private modified = false;
  // The pending jump's key grab (workbench:jump) — non-null while labels are shown.
  private jumpGrab: { dispose(): void } | null = null;
  private jumpDone: ((jumped: boolean) => void) | null = null;
  private readonly subs = new CompositeDisposable();

  constructor(options: WorkbenchListOptions = {}) {
    this.options = options;

    // An Adw.ToolbarView holds the session-title header bar as a top bar over the
    // scrollable workbench list, so the bar matches the window header beside it and
    // the view manages the seam (and undershoot shadow) between header and list.
    this.root = new Adw.ToolbarView();
    this.root.addCssClass('WorkbenchList');
    this.root.addTopBar(this.buildHeader());

    this.scrolled = new Gtk.ScrolledWindow();
    this.scrolled.setVexpand(true);
    this.root.setContent(this.scrolled);

    this.listBox = new Gtk.ListBox();
    this.listBox.addCssClass('navigation-sidebar');
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);
    this.subs.connect(this.listBox, 'row-activated', (row: any) => {
      const handle = this.handleForRow(row);
      if (handle) this.activate(handle.entry);
    });
    this.scrolled.setChild(this.listBox);

    this.registerCommands();

    // Rebuild when the owner set changes: project add/close and agent-workbench build
    // both fire `did-change-projects` from WorkbenchManager (the latter after the
    // workbench + its project association exist — the agent's own `did-add-agent`
    // fires too early to group). Agent removal comes through the registry.
    const projectsSub = this.options.onProjectsChanged?.(() => this.rebuild());
    if (projectsSub) this.subs.add(projectsSub);
    this.subs.add(zym.agents.onDidRemoveAgent(() => this.rebuild()));
    this.rebuild();
  }

  // The sidebar header bar: an Adw.HeaderBar (so its height/chrome matches the window
  // header bar beside it) showing the active session name. `.workbench-header` lets the
  // chrome theme the bar.
  private buildHeader(): InstanceType<typeof Adw.HeaderBar> {
    const bar = new Adw.HeaderBar();
    this.headerBar = bar;
    bar.addCssClass('workbench-header');
    bar.setShowStartTitleButtons(false);
    bar.setShowEndTitleButtons(false);
    bar.setVisible(false); // clean unnamed window → hidden (see updateHeaderVisibility)

    // The active session's name — empty until a session is named (`setSessionName`).
    // Packed at the start (not the centered title slot) so it aligns left.
    bar.setTitleWidget(new Gtk.Box()); // clear the centered title slot
    this.headerTitle = new Adw.WindowTitle({ title: '' });
    bar.packStart(this.headerTitle);

    // Unsaved-changes marker — a warning-colored dot right after the session title,
    // shown when any open editor has unsaved edits (driven by the host via
    // `setModified`). Toggled with opacity so its slot never shifts the title.
    this.modifiedDot = iconLabel(Icons.modified);
    this.modifiedDot.addCssClass('zym-modified-dot');
    this.modifiedDot.setTooltipText('Unsaved changes');
    this.modifiedDot.setCanTarget(false);
    this.updateModifiedDot();
    bar.packStart(this.modifiedDot);
    return bar;
  }

  /** Reflect whether any open editor has unsaved edits (the host computes this). */
  setModified(modified: boolean): void {
    this.modified = modified;
    this.updateModifiedDot();
    this.updateHeaderVisibility(); // an unnamed window reveals the bar to show the dot
  }

  /** Reflect the active session name in the header (empty for the unnamed default). */
  setSessionName(name: string | null): void {
    this.named = name != null;
    this.headerTitle?.setTitle(name ?? '');
    this.updateHeaderVisibility();
  }

  // The unsaved-changes dot shows whenever there are unsaved edits. Opacity keeps its
  // slot fixed so revealing it never shifts the title.
  private updateModifiedDot(): void {
    this.modifiedDot?.setOpacity(this.modified ? 1 : 0);
    this.modifiedDot?.setCanTarget(this.modified);
  }

  // The header bar shows for a named session, or (unnamed) while there are unsaved edits
  // so the modified dot still surfaces; a clean unnamed window hides it.
  private updateHeaderVisibility(): void {
    this.headerBar?.setVisible(this.named || this.modified);
  }

  // Live groups from the host (empty until wired). The rail is never truly empty — the
  // primary project is always present.
  private groups(): ProjectGroup[] {
    return this.options.getGroups?.() ?? [];
  }

  // Full (re)build of every row: per project, its default (header) row then its agents.
  private rebuild(): void {
    this.endJump(false); // rows are being replaced — a pending jump's labels die with them
    for (const handle of this.handles) for (const unsub of handle.unsubs) unsub();
    this.handles = [];

    let child = this.listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.listBox.remove(child);
      child = next;
    }

    for (const group of this.groups()) {
      const entries: Entry[] = [
        { kind: 'project', project: group.project },
        ...group.agents.map((agent): Entry => ({ kind: 'agent', agent })),
      ];
      for (const entry of entries) {
        const handle = this.createHandle(entry);
        this.handles.push(handle);
        this.listBox.append(handle.row);
      }
    }
    this.applySelection();
  }

  private createHandle(entry: Entry): RowHandle {
    const unsubs: Array<() => void> = [];
    const built =
      entry.kind === 'project'
        ? this.buildProjectContent(entry.project)
        : this.buildAgentContent(entry.agent, unsubs);

    const row = new Gtk.ListBoxRow();
    row.addCssClass('WorkbenchRow');
    if (entry.kind === 'project') row.addCssClass('WorkbenchRow--project'); // dimmed header
    row.setChild(built.content);
    return { entry, row, showMark: built.showMark, hideMark: built.hideMark, unsubs };
  }

  // The row content box: the leading icon plus the trailing widgets.
  private rowContent(icon: InstanceType<typeof Gtk.Widget>, ...trailing: InstanceType<typeof Gtk.Widget>[]): InstanceType<typeof Gtk.Box> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    icon.addCssClass('Workbenchrow--icon');
    box.append(icon);
    for (const w of trailing) box.append(w);
    return box;
  }

  // A project's default workbench row — the section header: no icon, just the project
  // name (its root basename), dimmed via the row's `--project` class. It's still an
  // activatable workbench row (editing the project directly, like the 'user' workbench on
  // master); its name just *is* the project's, so the agents below belong to it.
  // With no icon slot, the jump mark conceals the title's *first character* instead
  // (the editor leap's replace-the-glyph idiom) — a markup swap, no layout shift.
  private buildProjectContent(project: Project) {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    const label = new Gtk.Label({ label: project.title, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END });
    label.addCssClass('Workbenchrow--label');
    box.append(label);
    return {
      content: box,
      showMark: (mark: string) => label.setMarkup(jumpMarkSpan(mark) + escapeMarkup(project.title.slice(1))),
      hideMark: () => label.setText(project.title),
    };
  }

  // An agent row's content. Subscriptions (status/title) are pushed onto `unsubs`,
  // which the row's handle owns and tears down when the row goes away.
  private buildAgentContent(agent: Agent, unsubs: Array<() => void>) {
    // Status indicator (shared with the conversation footer): a bundled symbolic icon —
    // dot (idle/waiting), loading (working), circle outline (disconnected) — swapped in
    // place as the status changes.
    const status = createAgentStatusIcon(agent);
    unsubs.push(status.dispose);

    // The lead slot: a homogeneous Gtk.Stack of [status icon | jump mark], so the
    // slot keeps one constant size (the max of both) and flipping to the mark during
    // a jump shifts nothing.
    const mark = new Gtk.Label();
    mark.addCssClass('Workbenchrow--jump');
    const slot = new Gtk.Stack();
    slot.addChild(status.widget);
    slot.addChild(mark);
    slot.setVisibleChild(status.widget);

    const label = new Gtk.Label({ xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END });
    label.addCssClass('Workbenchrow--label'); // same title font as the default row
    label.setText(agent.title);
    unsubs.push(agent.onTitleChange(() => label.setText(agent.title)));

    // Single-line row: [status dot | name]. The edited-files badge lives on the
    // agent-sidebar header (AgentSidebar), reflecting the active agent, not per-row.
    return {
      content: this.rowContent(slot, label),
      showMark: (m: string) => {
        mark.setLabel(m);
        slot.setVisibleChild(mark);
      },
      hideMark: () => slot.setVisibleChild(status.widget),
    };
  }

  private handleForRow(row: InstanceType<typeof Gtk.ListBoxRow>): RowHandle | undefined {
    return this.handles.find((h) => h.row === row);
  }

  // Activate an entry: switch to the project's default workbench, or reveal the agent.
  private activate(entry: Entry | undefined): void {
    if (!entry) return;
    if (entry.kind === 'project') this.options.onActivateProject?.(entry.project);
    else this.options.onActivate?.(entry.agent);
  }

  // The owner an entry represents — the source of truth for selection matching.
  private entryOwner(entry: Entry): Owner {
    return entry.kind === 'project' ? entry.project : entry.agent;
  }

  // --- Keyboard navigation (vim bare keys while .WorkbenchList is focused) --------

  private registerCommands(): void {
    zym.commands.add(this.root, {
      'core:down': { didDispatch: () => this.moveSelection(1), description: 'Move down' },
      'core:up': { didDispatch: () => this.moveSelection(-1), description: 'Move up' },
      'core:top': { didDispatch: () => this.selectIndex(0), description: 'Go to the top' }, // `g g`
      'core:bottom': { didDispatch: () => this.selectIndex(this.handles.length - 1), description: 'Go to the bottom' }, // `G`
      'core:right': { didDispatch: () => this.activate(this.selectedEntry()), description: 'Reveal the selection' },
      // Lifecycle on the selected row (a no-op on a project's default row).
      'agent:restart': { didDispatch: () => this.withSelectedAgent((a) => this.options.onRestart?.(a)), description: 'Restart the selected agent' },
      'agent:rename': { didDispatch: () => this.withSelectedAgent((a) => this.options.onRename?.(a)), description: 'Rename the selected agent' },
      'agent:stop': { didDispatch: () => this.withSelectedAgent((a) => this.options.onStop?.(a)), description: 'Stop the selected agent' },
      'agent:close': { didDispatch: () => this.withSelectedAgent((a) => this.options.onClose?.(a)), description: 'Close the selected agent' },
      'agent:open-changes': { didDispatch: () => this.withSelectedAgent((a) => this.options.onOpenChanges?.(a)), description: "Open the selected agent's changes" },
    });
  }

  private selectedEntry(): Entry | undefined {
    const row = this.listBox.getSelectedRow();
    return row ? this.handleForRow(row)?.entry : undefined;
  }

  // Run `fn` with the agent of the currently selected row, if it's an agent row.
  private withSelectedAgent(fn: (agent: Agent) => void): void {
    const entry = this.selectedEntry();
    if (entry?.kind === 'agent') fn(entry.agent);
  }

  private moveSelection(delta: number): void {
    const selectedRow = this.listBox.getSelectedRow();
    const current = selectedRow ? this.handles.findIndex((h) => h.row === selectedRow) : -1;
    this.selectIndex(current + delta);
  }

  // Select (and scroll/focus) the row at `index`, clamped into range.
  private selectIndex(index: number): void {
    if (this.handles.length === 0) return;
    const clamped = Math.max(0, Math.min(index, this.handles.length - 1));
    const handle = this.handles[clamped];
    this.listBox.selectRow(handle.row);
    handle.row.grabFocus();
  }

  /** Move keyboard focus into the list (so its scoped bindings apply and the
   *  pane-navigation commands see focus as being within the workbench list). */
  focus(): void {
    const row = this.listBox.getSelectedRow() ?? this.handles[0]?.row;
    if (row) row.grabFocus();
    else this.listBox.grabFocus();
  }

  // --- Leap-style jump (workbench:jump) --------------------------------------

  /** Show a one-letter label on every row and grab the next keystroke ahead of
   *  command dispatch (`KeymapManager.addListener` — the vim `readChar` pattern, so
   *  the key never reaches the focused widget). The label's key activates its row
   *  exactly like clicking it; escape — or any key that isn't a shown label —
   *  cancels. `onDone(jumped)` fires once, on either outcome. */
  startJump(onDone?: (jumped: boolean) => void): void {
    this.endJump(false); // a jump already in flight is cancelled — never tangle grabs
    const byLabel = new Map<string, RowHandle>();
    for (let i = 0; i < this.handles.length && i < JUMP_LABELS.length; i++) {
      const handle = this.handles[i];
      byLabel.set(JUMP_LABELS[i], handle);
      handle.showMark(JUMP_LABELS[i]);
    }
    if (byLabel.size === 0) {
      onDone?.(false);
      return;
    }
    this.jumpDone = onDone ?? null;
    this.jumpGrab = zym.keymaps.addListener((key: Key) => {
      if (key.isModifier()) return false; // a bare modifier resolves nothing — keep waiting
      // A plain printable key may be a label; a chord / control key always cancels.
      // `string` comes from real GDK events; a synthetic `fromDescription` key (tests,
      // macro replay) only carries `name`, so fall back to a single-char name.
      const raw =
        key.string && key.string.charCodeAt(0) >= 0x20 ? key.string
        : key.name && key.name.length === 1 ? key.name
        : null;
      const char = !key.ctrl && !key.alt && !key.super && raw ? raw.toLowerCase() : null;
      const handle = char !== null ? byLabel.get(char) : undefined;
      this.endJump(handle !== undefined);
      if (handle) this.activate(handle.entry);
      return true; // claim the key either way — a pending jump swallows its keystroke
    });
  }

  /** Cancel a pending jump, if any — labels hidden, key grab released, its
   *  `onDone(false)` settled. Call before re-triggering so the previous jump's
   *  cleanup (e.g. the host's sidebar restore) runs first. */
  cancelJump(): void {
    this.endJump(false);
  }

  // Tear down a pending jump — hide the labels, release the key grab, settle its
  // `onDone`. Idempotent; safe to call when no jump is pending.
  private endJump(jumped: boolean): void {
    this.jumpGrab?.dispose();
    this.jumpGrab = null;
    for (const handle of this.handles) handle.hideMark();
    const done = this.jumpDone;
    this.jumpDone = null;
    done?.(jumped);
  }

  /** Select the row for `owner` (the active workbench's project or agent). Called on
   *  every workbench switch so the rail highlight follows the active owner. */
  selectOwner(owner: Owner | null): void {
    this.selected = owner;
    this.applySelection();
  }

  // Reflect `this.selected` onto the list box (the first default row when nothing is
  // selected, so a row is always highlighted).
  private applySelection(): void {
    const handle = this.handles.find((h) => this.entryOwner(h.entry) === this.selected) ?? this.handles[0];
    if (handle) this.listBox.selectRow(handle.row);
  }

  dispose(): void {
    this.endJump(false);
    for (const handle of this.handles) for (const unsub of handle.unsubs) unsub();
    this.handles = [];
    this.subs.dispose();
  }
}
