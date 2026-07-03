/*
 * PaneItems — the tab/item-registry spine: the per-widget registries for every kind of
 * center tab (editors, terminals, headless agents, project-search and diff surfaces,
 * workbench-action terminals) and their lifecycle (create / attach / serialize / dispose /
 * reopen). It is the single funnel `openFile` goes through (reveal-if-open), builds each
 * person's center (`makeCenter`), and owns the shared `DocumentRegistry`. This is Atom's
 * `Workspace` / `PaneContainer` / `TextEditorRegistry` split, pulled out of AppWindow.
 *
 * It reads the active workbench and the few cross-cutting hooks it needs (the agent-tab
 * veto's `activateOwner`, the active-tab-changed signal, diff-review delivery, the
 * sidebar's unsaved marker) through an injected deps object; everything else is self-
 * contained. `zym.workspace` keeps delegating to it through the AppWindow's provider seams.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import Gtk from 'gi:Gtk-4.0';
import { zym } from '../../zym.ts';
import { Panel, type PanelChild } from '../Panel.ts';
import { PanelGroup, type RestoredChild } from '../PanelGroup.ts';
import type { Workbench } from './Workbench.ts';
import { type Owner } from './Owner.ts';
import type { Agent } from '../../agents/types.ts';
import { type Action } from '../../actions.ts';
import { TextEditor } from '../TextEditor/index.ts';
import { DocumentRegistry } from '../TextEditor/DocumentRegistry.ts';
import { Terminal, terminalTabTitle } from '../Terminal.ts';
import { AgentTerminal } from '../AgentTerminal.ts';
import { AgentConversation } from '../AgentConversation.ts';
import { DiffView } from '../DiffView.ts';
import { ProjectSearchView } from '../ProjectSearchView.ts';
import type { SearchResultsView } from '../SearchResultsView.ts';
import { GitLogView } from '../git/GitLogView.ts';
import { Icons } from '../icons.ts';
import { repoRoot, git } from '../../git.ts';
import { detectPackageManager } from '../ScriptRunner.ts';
import { type OpenTabOptions } from '../../Workspace.ts';
import { type TabState } from '../../SessionManager.ts';
import { deserializeTab } from '../../SessionController.ts';
import { normalizeWorkspaceEdit, applyTextEdits } from '../../lsp/workspaceEdit.ts';
import { uriToPath, type PositionEncoding } from '../../lsp/position.ts';
import type { WorkspaceEdit } from 'vscode-languageserver-protocol';
import { CompositeDisposable, Disposable, Emitter, type DisposableLike } from '../../util/eventKit.ts';

type Widget = InstanceType<typeof Gtk.Widget>;
type Wb = Workbench<Owner>;

export interface PaneItemsDeps {
  /** The active workbench (switches on person change). */
  getWorkbench: () => Wb;
  /** Activate a workbench (the action-terminal runner runs beside its workbench). */
  activateWorkbench: (workbench: Wb) => void;
  /** Activate the primary project (the agent-tab close veto returns there). */
  activatePrimaryProject: () => void;
  /** Fired when the active split/tab changes (agent highlight / viewed + autosave). */
  onActiveTabChanged: () => void;
  /** Deliver a diff/comment review to an agent (editor `enter`, diff `onSend`). */
  onReview: (message: string) => void;
  /** Reflect whether any open editor has unsaved edits (the sidebar's unsaved dot). */
  setModified: (modified: boolean) => void;
}

export class PaneItems {
  private readonly d: PaneItemsDeps;

  // Editor tabs in the active workbench's center, mapped from their root widget so the
  // active child can be resolved back to its editor regardless of which split it's in.
  private readonly editors = new Map<Widget, TextEditor>();
  // Which workbench each editor lives in, so a workbench re-root can re-point its
  // editors' git gutters (kept in lockstep with `editors`).
  private readonly editorOwners = new Map<Widget, Wb>();
  // Open documents (text model + undo + file I/O), ref-counted. Editor tabs are views
  // onto these — a split or the see-definition peek shares one document (A2 model).
  private readonly documentRegistry = new DocumentRegistry();
  // Per-editor `zym.workspace` registration (drives plugin `observeTextEditors`);
  // disposed when the tab closes (see disposeChild).
  private readonly editorRegistrations = new Map<Widget, Disposable>();
  // Tab-lifetime subscriptions on the editor/terminal source (title + modified
  // state), disposed in disposeChild so a closed tab leaves no handlers behind.
  private readonly tabSubs = new Map<Widget, CompositeDisposable>();
  // Terminal tabs share the center panel with editors; tracked separately so the
  // active child can be resolved back to its Terminal (it has no vim state).
  private readonly terminals = new Map<Widget, Terminal>();
  // Headless `claude-sdk` agents mounted as center tabs (keyed by their root
  // widget), disposed when their tab closes (see disposeChild).
  private readonly conversations = new Map<Widget, AgentConversation>();
  // Terminal tabs opened for a `terminal` workbench action, keyed by the terminal's
  // root widget. Re-running an action reuses its still-open tab; the tab is closed when
  // the action is cleared, its workbench is closed, or the user closes the tab.
  private readonly actionTerminals = new Map<Widget, { workbench: Wb; actionId: string; terminal: Terminal; child: PanelChild }>();
  // Fires (with the affected workbench) when a `terminal` action's command starts or
  // exits, so the header bar's run/stop button updates.
  private readonly actionTerminalChanges = new Emitter();
  // Maps an editor's root widget to its center tab handle, so a location jump can
  // reveal an already-open file instead of opening a duplicate tab.
  private readonly editorChildren = new Map<Widget, PanelChild>();
  // Tab-hosted project-search surfaces (the search-entry header + its results multibuffer),
  // keyed by root widget so the view is disposed when its tab closes.
  private readonly projectSearchViews = new Map<Widget, ProjectSearchView>();
  // Teardown for a center tab, keyed by its root widget — run (and cleared) when the tab
  // closes. The generic seam behind `zym.workspace.openTab`'s `onClose`.
  private readonly tabCloseHandlers = new Map<Widget, () => void>();
  // Session modified-status registrations (editors, diff views), keyed by the tab's root
  // widget so the registration is disposed when the tab closes.
  private readonly participants = new Map<Widget, DisposableLike>();

  constructor(deps: PaneItemsDeps) {
    this.d = deps;
  }

  private get workbench(): Wb {
    return this.d.getWorkbench();
  }

  /** The shared document registry (a live peek / project search attaches to an open document). */
  get documents(): DocumentRegistry {
    return this.documentRegistry;
  }

  // --- Editor lifecycle ------------------------------------------------------

  /** The TextEditor backing the focused tab, if any. Prefers whichever panel holds
   *  keyboard focus (so a right-dock review editor receives editor commands), else
   *  falls back to the center's active split. */
  get activeEditor(): TextEditor | null {
    const focused = Panel.active?.activeChild;
    const focusedEditor = focused ? this.editors.get(focused) : undefined;
    if (focusedEditor) return focusedEditor;
    const centerChild = this.workbench.center.activePanel.activeChild;
    return centerChild ? this.editors.get(centerChild) ?? null : null;
  }

  /**
   * Open `path` in a center tab and focus it — revealing an already-open editor
   * for the file (in any split) instead of opening a duplicate tab. This is the
   * single funnel every file-open goes through, so reveal-if-open is the default
   * everywhere; it's also exposed app-wide as `zym.workspace.openFile`.
   */
  openFile(path: string): TextEditor {
    return this.openFileIn(path, this.workbench.center.openPanel);
  }

  // Open `path` as a tab in `panel`, revealing an already-open editor anywhere instead
  // of opening a duplicate — a file is only ever backed by one editor. `focus` (default
  // true) moves keyboard focus to it; callers opening several files at once suppress it
  // and focus the one they want at the end.
  openFileIn(
    path: string,
    panel: Panel,
    options: { focus?: boolean; owner?: Wb; select?: boolean } = {},
  ): TextEditor {
    const focus = options.focus ?? true;
    const targetOwner = options.owner ?? this.workbench;
    const existing = [...this.editors.entries()].find(
      ([widget, editor]) => editor.currentFile === path && this.editorOwners.get(widget) === targetOwner,
    )?.[1];
    if (existing) {
      if (options.select !== false) this.editorChildren.get(existing.root)?.select();
      if (focus) existing.focus();
      return existing;
    }
    return this.openFileViewIn(path, panel, { focus, owner: options.owner, select: options.select });
  }

  // Open a *new* view of `path` in `panel` — no reveal-if-open, so the same file can
  // show in two panes as two views sharing one Document (live model + undo). Used by
  // splitPane; openFileIn reveals instead. `owner` is the workbench the editor lives
  // in (its git feeds the gutter); defaults to the active one.
  openFileViewIn(path: string, panel: Panel, options: { focus?: boolean; owner?: Wb; select?: boolean } = {}): TextEditor {
    const { focus = true, owner = this.workbench, select } = options;
    const built = this.createEditorTab(path, { owner, focus });
    const child = panel.add(built.widget, {
      title: built.title,
      requireTabBar: built.requireTabBar,
      select,
    });
    built.onAttached?.(child);
    const editor = this.editors.get(built.widget)!;
    if (focus) editor.focus();
    return editor;
  }

  // Open `path` (revealing an already-open tab, since openFile dedupes) and place
  // the cursor. Used by location jumps (diagnostics, go-to-definition, search).
  openOrFocusFile(path: string, cursor: [number, number]): void {
    this.openFile(path).restoreCursor(cursor);
  }

  // Construct + wire a file editor tab WITHOUT attaching it to a panel. Shared by
  // openFile (which adds it to the active panel) and session restore (which places
  // it into the rebuilt workbench). The map is set before any attach so the first
  // onActiveChanged resolves the active editor.
  createEditorTab(
    path: string,
    restore: {
      cursor?: [number, number];
      scroll?: number;
      unsavedText?: string;
      owner?: Wb;
      focus?: boolean;
    } = {},
  ): RestoredChild {
    const owner = restore.owner ?? this.workbench;
    let child: PanelChild | null = null;
    // A ref-counted shared Document from the registry: the first view to be *shown* loads
    // it; a second view (split / restore) attaches to the already-loaded shared model.
    const { document } = this.documentRegistry.acquire(path);
    const editor = new TextEditor({
      onClose: () => child?.close(),
      git: owner.git, // the owning workbench's repo draws the gutter (follows re-root)
      cwd: () => owner.cwd, // the LocationBar shortens paths against the workbench's (live) root
      document,
      onReleaseDocument: () => this.documentRegistry.release(document),
      // `enter` (normal mode / visual selection) comments the line to an agent — same seam every
      // diff's review routes through; with no agent running it opens the picker / launches one.
      onComment: (message) => this.d.onReview(message),
    });
    this.editors.set(editor.root, editor);
    this.editorOwners.set(editor.root, owner);
    this.participants.set(editor.root, zym.session.registerParticipant(editor));
    // Lazy open: assign the file now (title/dedup/serialize go live) but defer the read,
    // parse, highlight, and LSP until this tab is first shown — a background or
    // session-restored tab does no work until it's selected. The editor's activate()
    // decides load-vs-attach off the shared document's loaded state.
    editor.prepareFile(path, {
      cursor: restore.cursor,
      scroll: restore.scroll,
      unsavedText: restore.unsavedText,
      focus: restore.focus,
      // Announce to the workspace so editor-observing plugins (color preview, …) can
      // attach; registered after load so their first pass sees the file's content.
      onActivate: () => this.editorRegistrations.set(editor.root, zym.workspace.addTextEditor(editor)),
    });
    return {
      widget: editor.root,
      title: this.editorTabTitle(editor),
      requireTabBar: true, // editors always show their filename tab, even when alone
      onAttached: (attached) => {
        child = attached;
        this.editorChildren.set(editor.root, attached);
        const sync = () => {
          attached.setTitle(this.editorTabTitle(editor));
          this.updateModifiedMarker();
        };
        this.tabSubs.get(editor.root)?.dispose(); // guard re-attach (tab moved between docks)
        this.tabSubs.set(editor.root, new CompositeDisposable(
          new Disposable(editor.onTitleChange(sync)),
          new Disposable(editor.onModifiedChange(sync)),
        ));
      },
    };
  }

  /** Open a new Terminal tab in the center panel and select it. */
  openTerminal(): Terminal {
    const built = this.createTerminalTab(this.workbench.cwd);
    const child = this.workbench.center.add(built.widget, { title: built.title });
    built.onAttached?.(child);
    const terminal = this.terminals.get(built.widget)!;
    terminal.focus();
    return terminal;
  }

  // Run a `package.json` script in a new terminal tab via the detected package
  // manager. The shell runs `<pm> run <name>` then execs a login shell, so the
  // tab stays open on the script's output (and ready to re-run).
  runScript(name: string): void {
    const cwd = this.workbench.cwd;
    const detect = zym.config.get('scriptRunner.detectPackageManager');
    const pm = detect ? detectPackageManager(cwd) : 'npm';
    const shell = process.env.SHELL || '/bin/bash';
    const run = `${pm} run ${name}`;
    const built = this.createTerminalTab(cwd, {
      command: [shell, '-l', '-c', `${run}; exec ${shell} -l`],
      title: run,
    });
    const child = this.workbench.center.add(built.widget, { title: built.title });
    built.onAttached?.(child);
    this.terminals.get(built.widget)!.focus();
  }

  // Open a `terminal` workbench action in a dedicated terminal tab in that
  // workbench's own center, so its output lands beside the work. Re-running the same
  // action reuses its still-open tab. The tab is cleaned up when the action is cleared
  // (pruneActionTerminals) or its workbench is closed.
  runWorkbenchActionInTerminal(workbench: Wb, action: Action): void {
    this.d.activateWorkbench(workbench); // run beside its workbench — switch to it if needed
    const shell = process.env.SHELL || '/bin/bash';
    const command = [shell, '-l', '-c', action.command];

    // Reuse the action's existing tab if it's still around (it lingers on its output
    // after the command exits): bring it forward and re-run the command in place.
    const existing = this.findActionTerminal(workbench, action.id);
    if (existing) {
      existing.child.select();
      existing.terminal.run(command);
      existing.terminal.focus();
      return;
    }

    const built = this.createTerminalTab(workbench.cwd, {
      command,
      title: action.label,
      keepOpenOnExit: true, // stay on the output when the command exits; don't respawn a shell
      transient: true, // too short-lived to restore — keep it out of the session
      onRunningChange: () => this.actionTerminalChanges.emit('change', workbench),
    });
    const child = workbench.center.add(built.widget, { title: built.title });
    built.onAttached?.(child);
    const terminal = this.terminals.get(built.widget)!;
    this.actionTerminals.set(built.widget, { workbench, actionId: action.id, terminal, child });
    terminal.focus();
  }

  // The still-open terminal tab for `workbench`'s action, or null. (Closed tabs are
  // dropped from the map by disposeChild, so a hit is always a live tab.)
  findActionTerminal(workbench: Wb, actionId: string) {
    for (const entry of this.actionTerminals.values())
      if (entry.workbench === workbench && entry.actionId === actionId) return entry;
    return null;
  }

  // Close the terminal tabs of `workbench`'s actions that no longer exist — the set
  // changed and dropped these. Closing the tab tears down the rest via disposeChild.
  pruneActionTerminals(workbench: Wb): void {
    const live = new Set(workbench.actions.actions.map((a) => a.id));
    for (const entry of [...this.actionTerminals.values()])
      if (entry.workbench === workbench && !live.has(entry.actionId)) entry.child.close();
  }

  /** Subscribe to a `terminal` action's run/stop changes (the header run/stop button). */
  onActionTerminalChange(cb: (workbench: Wb) => void): DisposableLike {
    return this.actionTerminalChanges.on('change', (wb) => cb(wb as Wb));
  }

  // Construct + wire a terminal tab WITHOUT attaching it to a panel. Shared by
  // openTerminal, the script runner, and session restore (a restored terminal is
  // a fresh shell in cwd).
  createTerminalTab(cwd: string, options: { command?: string[]; title?: string; keepOpenOnExit?: boolean; transient?: boolean; onRunningChange?: () => void } = {}): RestoredChild {
    let child: PanelChild | null = null;
    const terminal = new Terminal({
      cwd,
      command: options.command,
      title: options.title,
      keepOpenOnExit: options.keepOpenOnExit,
      transient: options.transient,
      onRunningChange: options.onRunningChange,
      // The shell exiting (`exit`/Ctrl-D) closes its tab. A `keepOpenOnExit` tab
      // (an agent action) instead stays on its output and never fires this.
      onExit: () => child?.close(),
    });
    this.terminals.set(terminal.root, terminal);
    return {
      widget: terminal.root,
      title: terminalTabTitle(terminal),
      onAttached: (attached) => {
        child = attached;
        this.tabSubs.get(terminal.root)?.dispose(); // guard re-attach
        this.tabSubs.set(terminal.root, new CompositeDisposable(
          new Disposable(terminal.onTitleChange(() => attached.setTitle(terminalTabTitle(terminal)))),
        ));
      },
    };
  }

  // Serialize one center tab (editor/terminal/agent) to its session state, or
  // null for a tab that shouldn't persist.
  serializeChild(widget: Widget): TabState | null {
    const editor = this.editors.get(widget);
    if (editor) return editor.serialize();
    const terminal = this.terminals.get(widget);
    if (terminal) return terminal.serialize();
    return null;
  }

  // Build a fresh center (one person's splittable editor area). Every center
  // shares the same callbacks — they operate on the shared per-widget maps, and
  // only the *active* center fires interactive events (the others are detached).
  makeCenter(): PanelGroup {
    return new PanelGroup({
      onActiveChanged: () => this.d.onActiveTabChanged(),
      onTabCloseRequest: (widget) => {
        // An agent's terminal tab is never closed/destroyed here, whatever its state:
        // closing it would kill a running agent and would drop a stopped one from the
        // list. Veto the close (the terminal stays put in its workbench, alive) and just
        // return to the user's workbench, so the agent is one switch away. Defer the swap
        // out of the close-page emission: it reparents the agent workbench (an ancestor of
        // the emitting tab view), unsafe mid-emit.
        const terminal = this.terminals.get(widget);
        const owner: Agent | null = terminal instanceof AgentTerminal ? terminal : (this.conversations.get(widget) ?? null);
        if (owner) {
          if (this.workbench.owner === owner)
            setTimeout(() => {
              if (this.workbench.owner === owner) this.d.activatePrimaryProject();
            }, 0);
          return false;
        }
        return true;
      },
      // Agent tabs are vetoed above, so only editors / plain terminals reach here.
      // Snapshot the tab's restorable state before disposeChild tears it down, so
      // `tab:reopen-last` can rebuild it; tabs that don't persist serialize to null.
      onClosed: (widget) => {
        const state = this.serializeChild(widget);
        if (state) zym.workspace.recordClosedTab(state);
        this.disposeChild(widget);
      },
    });
  }

  // Drop a closed tab's bookkeeping (editor/terminal/agent maps + session
  // registration) and run its close side effects. Shared by the center and the
  // right-dock editor group, which host the same kinds of tab.
  disposeChild(widget: Widget): void {
    this.tabSubs.get(widget)?.dispose(); // editor/terminal title + modified-state subscriptions
    this.tabSubs.delete(widget);
    this.participants.get(widget)?.dispose();
    this.participants.delete(widget);
    this.editorRegistrations.get(widget)?.dispose(); // detach observing plugins
    this.editorRegistrations.delete(widget);
    this.editors.get(widget)?.dispose(); // explicit teardown, not reliant on the GTK destroy signal
    this.editors.delete(widget);
    this.projectSearchViews.get(widget)?.dispose(); // free its results' per-source parses
    this.projectSearchViews.delete(widget);
    this.tabCloseHandlers.get(widget)?.(); // generic tab teardown (e.g. dispose a hosted diff view)
    this.tabCloseHandlers.delete(widget);
    this.editorOwners.delete(widget);
    this.editorChildren.delete(widget);
    this.terminals.get(widget)?.dispose(); // sever the Vte focus controller (rule 9)
    this.terminals.delete(widget);
    // A workbench-action terminal: kill any still-running command (e.g. a dev server) so a
    // closed/cleared action leaves nothing behind, then drop it from the map and notify so
    // the run/stop button drops back to "start" (disposing the terminal severed its
    // onRunningChange, so emit the change ourselves).
    const actionTerminal = this.actionTerminals.get(widget);
    actionTerminal?.terminal.kill();
    actionTerminal?.terminal.dispose();
    this.actionTerminals.delete(widget);
    if (actionTerminal) this.actionTerminalChanges.emit('change', actionTerminal.workbench);
    this.conversations.get(widget)?.dispose(); // kill the claude child + IPC watchers
    this.conversations.delete(widget);
    this.updateModifiedMarker(); // a closed editor no longer counts as unsaved
  }

  // Rebuild one closed tab from its serialized state — the reopener `zym.workspace`
  // calls (it owns the history stack; the panel tree lives here). Reuses the same
  // per-kind reconstruction as session restore. Returns false when it can't be rebuilt.
  reopenTab(state: TabState): boolean {
    const built = deserializeTab(state, {
      createEditorTab: (path, restore) => this.createEditorTab(path, restore),
      createTerminalTab: (cwd) => this.createTerminalTab(cwd),
    });
    if (!built) return false;
    const child = this.workbench.center.add(built.widget, { title: built.title, requireTabBar: built.requireTabBar });
    built.onAttached?.(child);
    (this.editors.get(built.widget) ?? this.terminals.get(built.widget))?.focus();
    return true;
  }

  /** Host `widget` as a center tab: select, focus, and register its `onClose` teardown
   *  (disposeChild runs it on close). Backs `zym.workspace.openTab` for any component. */
  openCenterTab(widget: Widget, options: OpenTabOptions): void {
    const child = this.workbench.center.add(widget, { title: options.title, requireTabBar: options.requireTabBar });
    if (options.onClose) this.tabCloseHandlers.set(widget, options.onClose);
    child.select();
    widget.grabFocus();
  }

  /** The tab title for an editor, prefixed with the modified dot when unsaved. */
  private editorTabTitle(editor: TextEditor): string {
    // A file changed underneath us takes precedence — it's the more urgent signal.
    if (editor.hasDiskChange()) return `${Icons.warning} ${editor.title}`;
    return editor.isModified() ? `${Icons.modified} ${editor.title}` : editor.title;
  }

  /** Show the sidebar-header unsaved dot when any open editor has unsaved edits. */
  private updateModifiedMarker(): void {
    this.d.setModified([...this.editors.values()].some((e) => e.isModified()));
  }

  // --- Project search & diff views (hosted as center tabs) -------------------

  /** Open the project-search surface in a tab: a debounced search entry over an editable
   *  results multibuffer. Seeded with `initialQuery` or empty. */
  openProjectSearch(initialQuery: string): void {
    const view = new ProjectSearchView({
      cwd: this.workbench.cwd,
      documents: this.documentRegistry,
      initialQuery,
      onActivate: ({ path, row }) => this.openFile(path).restoreCursor([row, 0]),
    });
    const title = initialQuery ? `${Icons.search}  ${initialQuery}` : `${Icons.search}  Search`;
    const child = this.workbench.center.add(view.root, { title, requireTabBar: true });
    this.projectSearchViews.set(view.root, view); // disposeChild tears it down on close
    child.select();
    view.focus();
  }

  /** Open a read-only diff of the active file (working tree vs git HEAD) in a tab. */
  openCurrentFileDiff(): void {
    const editor = this.activeEditor;
    const path = editor?.currentFile;
    if (!editor || !path) return;
    const root = repoRoot(Path.dirname(path));
    if (!root) {
      zym.notifications.addInfo('Not in a git repository');
      return;
    }
    const current = editor.getText();
    const rel = Path.relative(root, path);
    git(root, ['show', `HEAD:${rel}`], (ok, stdout) => {
      const head = ok ? stdout : ''; // untracked / new file → empty base (all added)
      if (head === current) {
        zym.notifications.addInfo('No changes against HEAD');
        return;
      }
      // One-file diff on the unified surface: OLD = HEAD blob, NEW = the editor's current
      // text (incl. unsaved edits). Read-only snapshot (not backed by the live Document).
      const name = Path.basename(path);
      const view = new DiffView({
        files: [{ path, oldText: head, newText: current }],
        cwd: this.workbench.cwd,
        onActivate: ({ path, row }) => this.openFile(path).restoreCursor([row, 0]),
        onSend: (message) => this.d.onReview(message), // comment/review → agent
      });
      const child = this.workbench.center.add(view.root, { title: `± ${name}`, requireTabBar: true });
      this.tabCloseHandlers.set(view.root, () => view.dispose());
      // Consult the diff on window close so unsent review comments aren't lost.
      this.participants.set(view.root, zym.session.registerParticipant(view));
      child.select();
      view.focus();
    });
  }

  /** Build a live, editable working-tree DiffView for `workbench`'s changes: NEW side = each
   *  changed file's current text (an open document's live text incl. unsaved edits, else from
   *  disk; a deleted file → empty) backed by a live Document, OLD side = the HEAD blob. Null only
   *  outside a repo. Shared by the `git:diff-current-changes` center tab and the GitPanel's
   *  embedded diff (via GitPanelOptions.buildDiffView). */
  async buildCurrentChangesDiff(workbench: Wb): Promise<DiffView | null> {
    const cwd = workbench.cwd;
    const root = repoRoot(cwd);
    if (!root) return null;
    const paths = [...workbench.git.getFileStatuses().keys()].sort();
    const showHead = (rel: string): Promise<string> =>
      new Promise((resolve) => git(root, ['show', `HEAD:${rel}`], (ok, out) => resolve(ok ? out : '')));
    const files = await Promise.all(
      paths.map(async (path) => {
        const oldText = await showHead(Path.relative(root, path));
        const open = this.documentRegistry.find(path);
        let newText = open ? open.getText() : '';
        let deleted = false;
        if (!open) {
          try {
            newText = Fs.readFileSync(path, 'utf8');
          } catch {
            deleted = true; // gone from the working tree (and not held open) → a deletion
          }
        }
        return { path, oldText, newText, deleted };
      }),
    );
    return new DiffView({
      files,
      cwd,
      editable: true,
      live: true, // the staging surface: live worktree+index → staging markers + `space h s`/`space h u`
      documents: this.documentRegistry,
      git: workbench.git, // enables the staged/unstaged gutter marker + `space h s`/`space h u`
      onActivate: ({ path, row }) => this.openFile(path).restoreCursor([row, 0]),
      onSend: (message) => this.d.onReview(message),
    });
  }

  /** Show every changed file (working tree vs HEAD) as ONE continuous diff in a tab — the live,
   *  editable staging surface. */
  async openLiveDiff(): Promise<void> {
    const view = await this.buildCurrentChangesDiff(this.workbench);
    if (!view) {
      zym.notifications.addInfo('Not in a git repository'); // a clean tree still opens the diff (its empty state)
      return;
    }
    const title = () => {
      const mod = view.isModified() ? `${Icons.modified} ` : '';
      const review = view.reviewCount > 0 ? `  ${Icons.comment} ${view.reviewCount}` : '';
      return `${mod}${Icons.git}  Diff${review}`;
    };
    const child = this.workbench.center.add(view.root, { title: title(), requireTabBar: true });
    this.tabCloseHandlers.set(view.root, () => view.dispose()); // disposeChild tears it down on close
    // Consult the diff on window close (unsaved edits OR unsent review comments).
    this.participants.set(view.root, zym.session.registerParticipant(view));
    view.onModifiedChange(() => child.setTitle(title())); // show the unsaved marker on edit/save
    view.onReviewChange(() => child.setTitle(title())); // show the accumulated-review count
    child.select();
    view.focus();
  }

  // `git:log` — open the git history viewer as a single center tab. The viewer is a
  // self-contained split (commit list | selected commit's diff); it hosts and disposes
  // the embedded diff itself, so the host just opens + focuses the tab.
  openGitLog(): void {
    const cwd = this.workbench.cwd;
    if (!repoRoot(cwd)) {
      zym.notifications.addInfo('Not in a git repository');
      return;
    }
    const view = new GitLogView({ cwd, git: this.workbench.git });
    this.openCenterTab(view.root, { title: `${Icons.git}  Log`, requireTabBar: true, onClose: () => view.dispose() });
    view.focus(); // openCenterTab focuses the tab root; move focus into the commit list
  }

  // --- Active editable surfaces (resolved from the focused tab) --------------

  /** The active center/focused child resolved to a widget, for surface lookups. */
  private activeChildWidget(): Widget | null {
    return Panel.active?.activeChild ?? this.workbench.center.activePanel.activeChild ?? null;
  }

  /** The active editable surface (project-search or diff multibuffer) that owns a `save()`. */
  activeSavableSurface(): { save(): void } | null {
    const widget = this.activeChildWidget();
    if (!widget) return null;
    return this.projectSearchViews.get(widget) ?? DiffView.forRoot(widget) ?? null;
  }

  /** The diff multibuffer the diff commands act on. Prefer the DiffView containing keyboard focus
   *  (walking up from the focused widget) — that covers an *embedded* diff like the GitPanel's,
   *  which isn't itself a center tab. Falls back to the active center tab's content. */
  activeContinuousDiff(): DiffView | null {
    for (let w: Widget | null = zym.window?.getFocus() ?? null; w; w = w.getParent()) {
      const diff = DiffView.forRoot(w);
      if (diff) return diff;
    }
    const widget = this.activeChildWidget();
    return widget ? DiffView.forRoot(widget) : null;
  }

  /** The search-results multibuffer hosted by the active child, if any (for the collapse commands). */
  activeSearchResults(): SearchResultsView | null {
    const widget = this.activeChildWidget();
    return widget ? this.projectSearchViews.get(widget)?.results ?? null : null;
  }

  // --- Focus & cross-cutting helpers -----------------------------------------

  /** Focus the editor/terminal backing a center-tab content widget (WorkbenchView delegates here). */
  focusContent(widget: Widget): void {
    const editor = this.editors.get(widget);
    if (editor) { editor.focus(); return; }
    this.terminals.get(widget)?.focus();
  }

  /**
   * Apply an LSP `WorkspaceEdit`: open editors are edited in their buffer (single
   * undo group, decorations refresh); files with no open editor are edited on disk.
   * Returns how many files were touched and how many resource operations were skipped.
   */
  applyWorkspaceEdit(edit: WorkspaceEdit, encoding: PositionEncoding): { applied: number; resourceOps: number } {
    const { files, resourceOps } = normalizeWorkspaceEdit(edit);
    for (const { uri, edits } of files) {
      const path = uriToPath(uri);
      const open = [...this.editors.values()].find((e) => e.currentFile === path);
      if (open) {
        open.applyLspEdits(edits, encoding);
      } else {
        try {
          Fs.writeFileSync(path, applyTextEdits(Fs.readFileSync(path, 'utf8'), edits, encoding));
        } catch {
          // unreadable / unwritable — skip
        }
      }
    }
    return { applied: files.length, resourceOps };
  }

  /** Register a tab-close teardown on a center widget (the `openTab` / GitPanel seam). */
  setTabCloseHandler(widget: Widget, fn: () => void): void {
    this.tabCloseHandlers.set(widget, fn);
  }

  // --- Agent support (used by the agent lifecycle code) ----------------------

  /** A snapshot of every open editor. */
  allEditors(): TextEditor[] {
    return [...this.editors.values()];
  }

  /** The open editor for `path`, if any (in any workbench). */
  editorForPath(path: string): TextEditor | null {
    return [...this.editors.values()].find((e) => e.currentFile === path) ?? null;
  }

  /** The center tab handle of the editor rooted at `root`, if tracked (for reveal/select). */
  editorChildFor(root: Widget): PanelChild | undefined {
    return this.editorChildren.get(root);
  }

  /** Track a freshly-launched agent's widget so the tab maps can resolve it (terminal focus
   *  routing / headless disposal key off these). */
  trackAgent(agent: Agent): void {
    if (agent instanceof AgentTerminal) this.terminals.set(agent.root, agent);
    else if (agent instanceof AgentConversation) this.conversations.set(agent.root, agent);
  }

  /** Dispose + drop a retired agent's widget from the tab maps (sever the Vte focus
   *  controller / kill the headless child + IPC watchers). */
  disposeAgentWidget(agent: Agent): void {
    this.terminals.get(agent.root)?.dispose();
    this.terminals.delete(agent.root);
    this.conversations.get(agent.root)?.dispose();
    this.conversations.delete(agent.root);
  }

  /** Tear down the action terminals hosted in `workbench`'s center (closing the agent
   *  drops its set_actions tabs; disposeChild won't reach them — they're terminals). */
  disposeWorkbenchActionTerminals(workbench: Wb): void {
    for (const entry of [...this.actionTerminals.values()])
      if (entry.workbench === workbench) this.disposeChild(entry.terminal.root);
  }

  /** Tear down the editors that lived in `workbench` (closing it drops their widgets but not
   *  their bookkeeping — gutter git sub, LSP doc ref, session participant, the owner entry). */
  disposeWorkbenchEditors(workbench: Wb): void {
    // Copy first: disposeChild mutates editorOwners.
    for (const [widget, owner] of [...this.editorOwners])
      if (owner === workbench) this.disposeChild(widget);
  }

  /** Re-point the gutters of editors already open in `workbench` at its new repo (re-root). */
  repointGutters(workbench: Wb, repo: Wb['git']): void {
    for (const [root, owner] of this.editorOwners)
      if (owner === workbench) this.editors.get(root)?.setGitRepo(repo);
  }

  /** Drain any tab subscriptions whose tabs weren't individually closed (window teardown). */
  dispose(): void {
    for (const subs of this.tabSubs.values()) subs.dispose();
    this.tabSubs.clear();
  }
}
