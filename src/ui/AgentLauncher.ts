/*
 * AgentLauncher — the overlay for starting a new agent. A multi-line prompt editor
 * sits on top; a row of controls below it gathers the launch options (model,
 * permission mode, agent kind, and a "new worktree" toggle). Enter (in the prompt)
 * launches, Escape cancels.
 *
 * It's a `FloatingCard` (the same overlay shell the Picker uses) filled with a
 * `createInput` prompt and `Combobox`es for the options (model, permission, agent,
 * and the worktree choice). The options come from the chosen kind's
 * `AgentLaunchOptions` (see `agents/configs.ts`), so changing the kind re-populates
 * the model/permission lists — today the Claude kinds share a list, but the wiring
 * lets them diverge. `onLaunch` receives the assembled argv + cwd + kind; the host
 * turns that into `openAgent`.
 */
import { outdent } from 'outdent';
import { Gtk, Gdk, Adw } from '../gi.ts';
import { zym } from '../zym.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { openFloatingCard } from './FloatingCard.ts';
import { Combobox } from './Combobox.ts';
import { createInput } from './TextEditor/TextEditor.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import { AGENT_CONFIGS, listAgentKinds, type AgentKind } from '../agents/configs.ts';
import { repoRoot, listBranches } from '../git.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

const CARD_WIDTH = 640;
// Shared inset for the prompt text and the options row (four spacing units), so the two
// sections line up on the same left edge. CSS uses `calc(4 * var(--t-spacing))`; this is
// the matching px value for the prompt editor's (numeric) padding.
const CARD_PADDING = 4 * theme.spacing;

// An unsent prompt left over from a dismissed launcher, restored (fully selected) on
// the next open so a cancelled compose isn't lost. Cleared once submitted.
let savedDraft = '';

// The last-used launch options, persisted across launches within the session so they
// don't reset each time. '' means "not chosen yet" → fall back to the kind's default
// (for worktree, '' is the valid "create" choice).
let savedModel = '';
let savedPermission = '';
let savedEffort = '';
let savedKind: AgentKind | '' = '';
let savedWorktree = '';

/** The worktree choice: run in the current workbench cwd (no worktree), create a fresh
 *  worktree, or work on an existing branch (in its own worktree). */
export type WorktreeChoice = { current: true } | { create: true } | { branch: string };

// Worktree dropdown sentinel values, distinct from any branch name (a branch can't be
// empty or contain a NUL); branches use their own name as the value.
const WT_CREATE = '';
const WT_CURRENT = '\0current';

export interface AgentLaunchRequest {
  /** The (trimmed) prompt text, or '' if left empty. */
  prompt: string;
  /** Base argv for the chosen model/permission mode (e.g. `['claude','--model',…]`). */
  command: string[];
  /** Working directory to root the agent at (the current workbench cwd). */
  cwd: string;
  /** The chosen agent kind. */
  kind: AgentKind;
  /** Create a fresh worktree, or work on a chosen branch (the agent sets it up). */
  worktree: WorktreeChoice;
  /** Start the agent without switching to it (it runs in the background). */
  background: boolean;
}

/** Which launch flow the launcher renders. They differ only in how the worktree choice is
 *  surfaced/seeded and where focus starts:
 *  - `default` — the full launcher; the worktree dropdown (create / current / branch) sits
 *    in the options row, prompt focused.
 *  - `existing-worktree` — pick an existing branch up front: the worktree combobox moves
 *    into the title (and is focused first), "create" is dropped (that's `new-worktree`).
 *  - `this-worktree` — same titled combobox, but pre-selected to the current root and with
 *    the prompt focused (tweak the choice only if you want to).
 *  - `new-worktree` — always a fresh worktree: no worktree control, just a title saying so. */
export type LauncherMode = 'default' | 'existing-worktree' | 'this-worktree' | 'new-worktree';

export interface AgentLauncherOptions {
  /** The current working directory the agent is rooted at by default. */
  cwd: string;
  /** The kind selected by default (from `resolveAgentKind(config)`). */
  defaultKind: AgentKind;
  /** The launch flow to render (default: `'default'`). */
  mode?: LauncherMode;
  /** Pre-select this worktree choice instead of the last-used one (`default` mode only). The
   *  review-send flow seeds `'current'` so a review runs against the working tree by default. */
  initialWorktree?: 'current' | 'create';
  /** Invoked with the assembled launch request when the user submits. */
  onLaunch: (request: AgentLaunchRequest) => void;
}

// The card reuses the Picker's opaque-card look (libadwaita's `.card` fill is
// semi-transparent and would show the editor through it).
addStyles(/* css */`
  #AgentLauncher {
    font: var(--t-font-monospace);
    border: 1px solid var(--border-color);
    border-radius: var(--popover-radius);
    background-color: var(--view-bg-color);
  }
  /* Accent focus ring around the whole card while the prompt editor has focus
     (toggled via .prompt-focused below). GTK draws the outline following the card's
     border-radius. */
  #AgentLauncher.prompt-focused {
    outline: 2px solid var(--accent-color);
    outline-offset: -1px;
  }
  /* The prompt uses the large editor font size. */
  #AgentLauncherPrompt .zym-editor,
  #AgentLauncherPrompt .zym-placeholder {
    font: var(--t-font-monospace-large);
  }
  #AgentLauncherOptions {
    /* No top padding — the prompt's own bottom padding already sets the gap. */
    padding: 0 calc(4 * var(--t-spacing)) calc(4 * var(--t-spacing));
    /* The card is monospace (for the prompt); the option controls read better in the
       UI (proportional) font. */
    font: var(--t-font-ui);
    background-color: var(--view-bg-color);
    border-bottom-left-radius: var(--popover-radius);
    border-bottom-right-radius: var(--popover-radius);
  }
  #AgentLauncherField > .field-caption {
    font-size: var(--t-font-ui-size-small);
    color: var(--t-ui-text-muted);
    padding-left: 6px;
  }
  /* Title row above the prompt for the worktree-scoped flows; inset to line up with the
     prompt text and the options row. The worktree combobox sits inline after the label. */
  #AgentLauncherTitle {
    padding: calc(4 * var(--t-spacing)) calc(4 * var(--t-spacing)) 0;
    font: var(--t-font-ui);
    background-color: var(--view-bg-color);
  }
  #AgentLauncherTitle > .launcher-title {
    font-weight: bold;
  }
`);

let keymapRegistered = false;
function registerLauncherKeymapOnce(): void {
  if (keymapRegistered) return;
  keymapRegistered = true;
  // Enter (in the prompt) launches and switches to the agent; alt-enter inserts a newline
  // (the app convention, see AgentConversation). ctrl-enter launches from anywhere in the
  // card (incl. the option dropdowns); ctrl-shift-enter launches in the background (without
  // switching to the new agent). Escape (core:cancel) dismisses the launcher — handled by a
  // bubble-phase controller on the card so an open combobox popover can swallow it first (a
  // closed combobox lets it through; the window keymap runs in capture phase, ahead of that).
  //
  // ctrl-tab / ctrl-shift-tab cycle focus forward / backward through the card's controls in
  // their natural tab order (prompt → option dropdowns → …, wrapping at the ends) — the Tab /
  // shift-Tab the prompt editor itself swallows. We bind them here — in the window's
  // capture-phase keymap — specifically to swallow the keystroke before Adw.TabView's built-in
  // ctrl-tab shortcut (managed scope, so it fires from any focus) cycles a background panel
  // group's tab.
  zym.keymaps.add('agent-launcher', {
    '#AgentLauncher': {
      'ctrl-enter': 'launcher:submit',
      'ctrl-shift-enter': 'launcher:submit-background',
      'ctrl-tab': 'launcher:focus-next',
      'ctrl-shift-tab': 'launcher:focus-previous',
    },
    '#AgentLauncherPrompt #TextEditor': {
      enter: 'launcher:submit',
      'shift-enter': 'launcher:submit-background',
      'alt-enter': 'launcher:newline',
    },
    // From NORMAL mode, q or escape dismiss the launcher (in insert mode escape is
    // vim's insert→normal, so it doesn't reach this). Mirrors DiffCommentBox.
    '#AgentLauncherPrompt #TextEditor.normal-mode': {
      q: 'core:cancel',
      escape: 'core:cancel',
    },
  });
}

/** Open the agent launcher overlay in `host`. */
export function openAgentLauncher(host: Overlay, options: AgentLauncherOptions): void {
  const { cwd, defaultKind, onLaunch } = options;
  const mode = options.mode ?? 'default';
  const newWorktree = mode === 'new-worktree';
  // The two flows that surface the worktree combobox inline in the title (vs the options row).
  const worktreeInTitle = mode === 'existing-worktree' || mode === 'this-worktree';

  const draft = savedDraft; // an unsent prompt from a previous dismissal, if any

  // Owns everything the launcher pins that node-gtk would otherwise root past the card's
  // lifetime: the comboboxes (each pins controllers + a parented popover) and the launcher's
  // own raw controllers. Disposed in onClose, AFTER the option values are read for persistence.
  const disposables = new CompositeDisposable();

  let commandsSub: { dispose(): void } | null = null;
  const card = openFloatingCard({
    host,
    name: 'AgentLauncher',
    dim: true, // it's a focused compose surface — dim the rest of the window
    fade: true,
    // Remember the (possibly unsent) prompt + the chosen options on any dismissal, so they
    // persist to the next launch; submit clears the draft below (but keeps the options).
    onClose: () => {
      // Read the option values BEFORE disposing — disposing tears down the comboboxes.
      savedDraft = input.getText();
      savedModel = modelDropdown.getValue();
      savedPermission = permissionDropdown.getValue();
      savedEffort = effortDropdown.getValue();
      savedKind = kindDropdown.getValue() as AgentKind;
      if (worktreeDropdown) savedWorktree = worktreeDropdown.getValue();
      commandsSub?.dispose();
      disposables.dispose();
    },
  });
  const panel = card.panel;
  panel.setSizeRequest(CARD_WIDTH, -1);

  // Options, seeded from the last-used values (else the kind's defaults). The kind drives
  // which models / permission modes are offered; the Claude kinds share a list today, but
  // changing the kind re-populates them (to that kind's defaults).
  const kind0 = savedKind || defaultKind;
  const kindOptions = AGENT_CONFIGS[kind0].options;

  const modelDropdown = disposables.use(new Combobox({ options: kindOptions.models, value: savedModel || kindOptions.defaultModel }));
  const permissionDropdown = disposables.use(new Combobox({ options: kindOptions.permissionModes, value: savedPermission || kindOptions.defaultPermissionMode }));
  const effortDropdown = disposables.use(new Combobox({ options: kindOptions.efforts, value: savedEffort || kindOptions.defaultEffort }));
  const kindDropdown = disposables.use(new Combobox({
    options: listAgentKinds(),
    value: kind0,
    onChange: (value) => {
      const opts = AGENT_CONFIGS[value as AgentKind].options;
      modelDropdown.setOptions(opts.models, opts.defaultModel);
      permissionDropdown.setOptions(opts.permissionModes, opts.defaultPermissionMode);
      effortDropdown.setOptions(opts.efforts, opts.defaultEffort);
    },
  }));

  // Worktree: a dropdown with two special choices up top — "create" (start in a fresh
  // worktree the agent makes) and "current" (run in the workbench cwd, no worktree) —
  // followed by the repo's branches (work on a chosen branch in its own worktree). The
  // worktree-in-title flows drop "create" (that's what the new-worktree flow is for); the
  // new-worktree flow has no dropdown at all (it's pinned to "create"). Specials use
  // sentinel values; the list is searchable; branches load asynchronously.
  const worktreeSpecials = worktreeInTitle
    ? [{ value: WT_CURRENT, label: 'current' }]
    : [
        { value: WT_CREATE, label: 'create' },
        { value: WT_CURRENT, label: 'current' },
      ];
  // `this-worktree` pre-selects the current root; `existing-worktree` keeps the last-used
  // choice but falls back off a stale "create" (which it doesn't offer). A caller-supplied
  // `initialWorktree` (default flow) overrides the last-used choice.
  const worktreeInitial =
    mode === 'this-worktree' ? WT_CURRENT
    : worktreeInTitle && savedWorktree === WT_CREATE ? WT_CURRENT
    : options.initialWorktree === 'current' ? WT_CURRENT
    : options.initialWorktree === 'create' ? WT_CREATE
    : savedWorktree;
  const worktreeDropdown = newWorktree
    ? null
    : disposables.use(new Combobox({ options: worktreeSpecials, value: worktreeInitial, specialLabels: ['create'], mutedLabels: ['current'] }));
  const repo = repoRoot(cwd);
  if (worktreeDropdown && repo) {
    listBranches(repo, (branches) => {
      if (card.isClosed()) return;
      worktreeDropdown.setOptions(
        [...worktreeSpecials, ...branches.map((b) => ({ value: b, label: b }))],
        worktreeInitial, // keep the seeded choice selected if it still exists
      );
    });
  }

  // Title above the prompt for the worktree-scoped flows: existing/this show "Launch agent
  // in worktree [combobox]" (the worktree control lives inline here, not in the options
  // row); new-worktree is just a label.
  if (worktreeInTitle || newWorktree) {
    const title = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    title.setName('AgentLauncherTitle');
    const label = new Gtk.Label({ xalign: 0, label: newWorktree ? 'Launch agent in new worktree:' : 'Launch agent in worktree' });
    label.addCssClass('launcher-title');
    title.append(label);
    if (worktreeDropdown) {
      worktreeDropdown.root.setHexpand(true); // fill the rest of the title width
      title.append(worktreeDropdown.root);
    }
    panel.append(title);
  }

  // The prompt — a buffer-only editor (full vim editing) that auto-grows with its
  // content up to 20 lines (then scrolls), wrapped in a named container so the
  // enter/alt-enter keymap scopes to it. Seeded with any restored draft.
  const input = createInput({ placeholder: 'Prompt for the agent…', initialText: draft, grow: true, maxLines: 20, padding: CARD_PADDING });
  const promptContainer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  promptContainer.setName('AgentLauncherPrompt');
  promptContainer.append(input.root);
  panel.append(promptContainer);

  // Ring the whole card while the prompt editor (not the dropdowns) holds focus.
  const promptFocus = new Gtk.EventControllerFocus();
  promptFocus.on('enter', () => panel.addCssClass('prompt-focused'));
  promptFocus.on('leave', () => panel.removeCssClass('prompt-focused'));
  disposables.addController(promptContainer, promptFocus);

  // A WrapBox so the option fields reflow onto another line on a narrow card rather
  // than overflowing. Each field carries a caption above its control. The worktree field
  // only appears here in the default flow (the worktree flows surface it in the title).
  const optionsRow = new Adw.WrapBox({ childSpacing: 10, lineSpacing: 8 });
  optionsRow.setName('AgentLauncherOptions');
  optionsRow.append(field('agent', kindDropdown.root));
  optionsRow.append(field('model', modelDropdown.root));
  optionsRow.append(field('permission', permissionDropdown.root));
  optionsRow.append(field('effort', effortDropdown.root));
  if (worktreeDropdown && mode === 'default') optionsRow.append(field('worktree', worktreeDropdown.root));
  panel.append(optionsRow);

  const submit = (background: boolean) => {
    const kind = kindDropdown.getValue() as AgentKind;
    const command = AGENT_CONFIGS[kind].options.buildCommand({
      model: modelDropdown.getValue(),
      permissionMode: permissionDropdown.getValue(),
      effort: effortDropdown.getValue(),
    });
    const prompt = input.getText().trim();
    // No dropdown (the new-worktree flow) → always a fresh worktree.
    const sel = worktreeDropdown?.getValue();
    const worktree: WorktreeChoice =
      sel === undefined || sel === WT_CREATE ? { create: true }
        : sel === WT_CURRENT ? { current: true }
          : { branch: sel };
    card.close(false); // onClose stashes the text…
    savedDraft = ''; // …but it was submitted, so don't restore it next time
    onLaunch({ prompt, command, cwd, kind, worktree, background });
  };

  // Cycle keyboard focus through the card's controls in their real tab order, wrapping at the
  // ends. We drive GTK's own focus traversal (childFocus) scoped to the card rather than naming
  // widgets, so it follows the layout and survives reordering/adding options. childFocus returns
  // false when it runs off the end; clearing the card's focus child restarts traversal from the
  // first/last control, giving the wrap.
  const cycleFocus = (forward: boolean) => {
    const dir = forward ? Gtk.DirectionType.TAB_FORWARD : Gtk.DirectionType.TAB_BACKWARD;
    if (panel.childFocus(dir)) return;
    panel.setFocusChild(null);
    panel.childFocus(dir);
  };

  registerLauncherKeymapOnce();
  commandsSub = zym.commands.add(panel, {
    'launcher:submit': { didDispatch: () => submit(false), description: 'Launch the agent and switch to it' },
    'launcher:submit-background': { didDispatch: () => submit(true), description: 'Launch the agent without switching to it' },
    'launcher:newline': { didDispatch: () => input.insertText('\n'), description: 'Insert a newline in the prompt' },
    'launcher:focus-next': { didDispatch: () => cycleFocus(true), description: 'Cycle focus to the next launcher control' },
    'launcher:focus-previous': { didDispatch: () => cycleFocus(false), description: 'Cycle focus to the previous launcher control' },
    'core:cancel': { didDispatch: () => card.close(), description: 'Close the launcher' },
  });

  // Escape closes the card — handled here in the bubble phase so a combobox's own
  // capture-phase Escape (closing its open popover) wins first; only an unhandled Escape
  // (the prompt's normal-mode binding aside, or a closed combobox) bubbles up to dismiss
  // the card. This is why it isn't a plain `#AgentLauncher` keymap binding (capture phase).
  const keys = new Gtk.EventControllerKey();
  keys.on('key-pressed', (keyval: number) => {
    if (keyval !== Gdk.KEY_Escape) return false;
    card.close();
    return true;
  });
  disposables.addController(panel, keys);

  // Focus the worktree combobox first in the existing-worktree flow (pick before typing);
  // every other flow (incl. this-worktree, which is pre-selected) focuses the prompt. Focus
  // it closed (`false`) — opening here, before the card is laid out, would mis-size the
  // popover; it opens correctly on the first interaction.
  if (mode === 'existing-worktree' && worktreeDropdown) {
    worktreeDropdown.focus(false);
  } else {
    input.focusInsert(); // ready to type the prompt immediately
    if (draft) input.selectAll(); // a restored draft starts fully selected (keep or overtype)
  }
}

// A captioned field: a small muted label on top of `control`. Used for the dropdowns
// (Gtk.DropDown has no built-in label).
function field(caption: string, control: InstanceType<typeof Gtk.Widget>): InstanceType<typeof Gtk.Box> {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3 });
  box.setName('AgentLauncherField');
  const label = new Gtk.Label({ xalign: 0, label: caption });
  label.addCssClass('field-caption');
  box.append(label);
  box.append(control);
  return box;
}

// The launch prompt for a new agent. The launcher's worktree choice is realized by the
// agent itself (there's no host-side worktree creation): prepend an instruction to set
// up the worktree and announce it via set_worktree (which re-roots the workbench), then
// run the user's prompt.
const NEW_WORKTREE_INSTRUCTION = outdent`
  Before anything else, create a new git worktree with a descriptive branch
  name for the following task and switch into it:
`;
function branchWorktreeInstruction(branch: string): string {
  return outdent`
    Before anything else, either go to the existing git worktree or create a new one
    for the branch ${branch}, then do the following task:
  `;
}

/** Assemble the launch prompt for `openAgent` from the user's prompt and the chosen
 *  worktree option (see NEW_WORKTREE_INSTRUCTION). */
export function launchPrompt(prompt: string, worktree: WorktreeChoice): string | undefined {
  if ('current' in worktree) return prompt || undefined; // run in the cwd, no worktree setup
  const instruction = 'create' in worktree ? NEW_WORKTREE_INSTRUCTION : branchWorktreeInstruction(worktree.branch);
  return prompt ? `${instruction}\n\n${prompt}` : instruction;
}
