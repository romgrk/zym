/*
 * AgentLauncher — the overlay for starting a new agent. A multi-line prompt editor
 * sits on top; a row of controls below it gathers the launch options (model,
 * permission mode, agent kind, and a "new worktree" toggle). Enter (in the prompt)
 * launches, Escape cancels.
 *
 * It's a `FloatingCard` (the same overlay shell the Picker uses) filled with a
 * `createInput` prompt and `Combobox`es for the options (model, permission, agent,
 * and the worktree choice). The agent control is a *profile* picker (see
 * `agents/profiles.ts`): the terminal kind plus one entry per configured ACP
 * agent (`agent.profiles`), so gemini / the claude adapter / codex sit side by
 * side. The other options come from the picked profile's kind
 * (`AgentLaunchOptions`, see `agents/configs.ts`), so changing the profile
 * re-populates the model/permission lists. `onLaunch` receives the assembled
 * argv + cwd + kind; the host turns that into `openAgent`.
 */
import { outdent } from 'outdent';
import Gdk from 'gi:Gdk-4.0';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import { zym } from '../zym.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { openFloatingCard } from './FloatingCard.ts';
import { Combobox } from './Combobox.ts';
import { createInput } from './TextEditor/TextEditor.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import { AGENT_CONFIGS, type AgentKind, type AgentLaunchOptions } from '../agents/configs.ts';
import { listAgentProfiles, defaultProfileFor, profileCommand, type AgentProfile } from '../agents/profiles.ts';
import { repoRoot, listBranches } from '../git.ts';
import { wrapEditorInstructions } from './conversation/format.ts';

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
let savedProfile = ''; // an AgentProfile id (see agents/profiles.ts)
let savedWorktree = '';
// Last-used generic config-option values (ACP configOptions — model / effort / …),
// keyed by option id, so a re-launch pre-fills the previous choice.
const savedConfigOptions: Record<string, string> = {};

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
  /** The launcher's model / permission-mode selections, for options an acp
   *  profile applies over the protocol rather than argv (`'default'` = the
   *  agent's own — nothing to apply). claude-tui encodes both in `command`. */
  model?: string;
  permissionMode?: string;
  /** Generic config-option choices (ACP `configOptions` — model / effort / … —
   *  discovered from the agent and applied via `session/set_config_option`), value
   *  id per option id. Empty for claude-tui. */
  configOptions?: Record<string, string>;
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
  /** Pre-fill the prompt editor (the agent's first turn) — the review-send flow seeds the formatted
   *  comment so it's visible/editable and is delivered as the launch prompt. Unlike a restored draft
   *  it doesn't start fully-selected (a stray keystroke shouldn't wipe it) and isn't persisted as a
   *  draft on dismissal (it's specific to this launch, not a leftover the next launch should restore). */
  initialPrompt?: string;
  /** Invoked with the assembled launch request when the user submits. */
  onLaunch: (request: AgentLaunchRequest) => void;
}

// The card reuses the Picker's opaque-card look (libadwaita's `.card` fill is
// semi-transparent and would show the editor through it).
addStyles(/* css */`
  .AgentLauncher {
    font: var(--t-font-monospace);
    border: 1px solid var(--border-color);
    border-radius: var(--popover-radius);
    background-color: var(--view-bg-color);
    /* Native (libadwaita) focus ring: invisible at rest, fading + scaling in when the
       prompt takes focus (.prompt-focused). Follows the card's border-radius. */
    outline: 0 solid transparent;
    outline-offset: 3px;
    transition: outline-color 200ms ease-in-out, outline-width 200ms ease-in-out, outline-offset 200ms ease-in-out;
  }
  /* Ring the whole card while the prompt editor has focus. */
  .AgentLauncher.prompt-focused {
    outline: 2px solid alpha(var(--accent-color), 0.6);
    outline-offset: -1px;
  }
  /* Worktree-picker option styling, forwarded to the (style-agnostic) Combobox via each
     option's cssClasses: the "create" sentinel reads as an action, "current" is muted.
     Unscoped so they also apply on the popover's own surface, not just inside the card. */
  .worktree-create { color: var(--accent-color); font-weight: bold; }
  .worktree-current { opacity: var(--dim-opacity); }
  /* The prompt uses the large editor font size. */
  .AgentLauncherPrompt .zym-editor,
  .AgentLauncherPrompt .zym-placeholder {
    font: var(--t-font-monospace-large);
  }
  .AgentLauncherOptions {
    /* No top padding — the prompt's own bottom padding already sets the gap. */
    padding: 0 calc(4 * var(--t-spacing)) calc(4 * var(--t-spacing));
    /* The card is monospace (for the prompt); the option controls read better in the
       UI (proportional) font. */
    font: var(--t-font-ui);
    background-color: var(--view-bg-color);
    border-bottom-left-radius: var(--popover-radius);
    border-bottom-right-radius: var(--popover-radius);
  }
  /* Title row above the prompt for the worktree-scoped flows; inset to line up with the
     prompt text and the options row. The worktree combobox sits inline after the label. */
  .AgentLauncherTitle {
    padding: calc(4 * var(--t-spacing)) calc(4 * var(--t-spacing)) 0;
    font: var(--t-font-ui);
    background-color: var(--view-bg-color);
  }
  .AgentLauncherTitle > .launcher-title {
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
    '.AgentLauncher': {
      'ctrl-enter': 'launcher:submit',
      'ctrl-shift-enter': 'launcher:submit-background',
      'ctrl-tab': 'launcher:focus-next',
      'ctrl-shift-tab': 'launcher:focus-previous',
    },
    '.AgentLauncherPrompt .TextEditor': {
      enter: 'launcher:submit',
      'shift-enter': 'launcher:submit-background',
      'alt-enter': 'launcher:newline',
    },
    // From NORMAL mode, q or escape dismiss the launcher (in insert mode escape is
    // vim's insert→normal, so it doesn't reach this). Mirrors DiffCommentBox.
    '.AgentLauncherPrompt .TextEditor.normal-mode': {
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
  const seededPrompt = options.initialPrompt; // a flow-specific pre-fill (the review), not a draft

  // Owns everything the launcher pins that node-gtk would otherwise root past the card's
  // lifetime: the comboboxes (each pins controllers + a parented popover) and the launcher's
  // own raw controllers. Disposed in onClose, AFTER the option values are read for persistence.
  const disposables = new CompositeDisposable();

  let commandsSub: { dispose(): void } | null = null;
  const card = openFloatingCard({
    host,
    name: 'AgentLauncher',
    dim: true, // it's a focused compose surface — dim the rest of the window
    // Remember the (possibly unsent) prompt + the chosen options on any dismissal, so they
    // persist to the next launch; submit clears the draft below (but keeps the options).
    onClose: () => {
      // Read the option values BEFORE disposing — disposing tears down the comboboxes.
      // A flow-specific pre-fill (the review) isn't a draft — don't persist it, so the next plain
      // launch isn't seeded with a leftover review.
      if (!seededPrompt) savedDraft = input.getText();
      savedModel = modelDropdown.getValue();
      savedPermission = permissionDropdown.getValue();
      savedEffort = effortDropdown.getValue();
      savedProfile = profileDropdown.getValue();
      for (const [id, combo] of configDropdowns) savedConfigOptions[id] = combo.getValue();
      if (worktreeDropdown) savedWorktree = worktreeDropdown.getValue();
      commandsSub?.dispose();
      disposables.dispose();
    },
  });
  const panel = card.panel;
  panel.setSizeRequest(CARD_WIDTH, -1);

  // Options, seeded from the last-used values (else the profile's defaults). The
  // picked profile drives which models / permission modes are offered — its own
  // imported/configured lists when it has them (see agents/profiles.ts), else its
  // kind's; changing the profile re-populates them (to that profile's defaults).
  const profiles = listAgentProfiles();
  const profileById = (id: string): AgentProfile | undefined => profiles.find((p) => p.id === id);
  const profile0 = profileById(savedProfile) ?? defaultProfileFor(defaultKind, profiles);
  // A profile's own option list always leads with the `default` sentinel, so
  // that is its default value; kind lists keep the kind's own default.
  const optionsFor = (p: AgentProfile): AgentLaunchOptions => {
    const base = AGENT_CONFIGS[p.kind].options;
    return {
      ...base,
      models: p.models ?? base.models,
      defaultModel: p.models ? 'default' : base.defaultModel,
      permissionModes: p.permissionModes ?? base.permissionModes,
      defaultPermissionMode: p.permissionModes ? 'default' : base.defaultPermissionMode,
      efforts: p.efforts ?? base.efforts,
      defaultEffort: p.efforts ? 'default' : base.defaultEffort,
    };
  };
  const kindOptions = optionsFor(profile0);

  const modelDropdown = disposables.use(new Combobox({ title: 'model', options: kindOptions.models, value: savedModel || kindOptions.defaultModel }));
  const permissionDropdown = disposables.use(new Combobox({ title: 'permission', options: kindOptions.permissionModes, value: savedPermission || kindOptions.defaultPermissionMode }));
  const effortDropdown = disposables.use(new Combobox({ title: 'effort', options: kindOptions.efforts, value: savedEffort || kindOptions.defaultEffort }));

  // A fixed model / permission / effort slot with only the pass-through `default`
  // (an ACP profile with nothing configured/discovered for it) reads as dead UI —
  // hide it. Its real options ride the generic config dropdowns (below) instead.
  const applySlotVisibility = (opts: AgentLaunchOptions): void => {
    modelDropdown.root.setVisible(opts.models.length > 1);
    permissionDropdown.root.setVisible(opts.permissionModes.length > 1);
    effortDropdown.root.setVisible(opts.efforts.length > 1);
  };
  // Assigned once the options row exists (it rebuilds the generic config-option
  // dropdowns for the picked profile). Declared here so the profile onChange can call it.
  let rebuildConfigDropdowns: (profile: AgentProfile) => void = () => {};

  const profileDropdown = disposables.use(new Combobox({
    title: 'agent',
    options: profiles.map((p) => ({ value: p.id, label: p.label })),
    value: profile0.id,
    onChange: (value) => {
      const profile = profileById(value) ?? profile0;
      const opts = optionsFor(profile);
      modelDropdown.setOptions(opts.models, opts.defaultModel);
      permissionDropdown.setOptions(opts.permissionModes, opts.defaultPermissionMode);
      effortDropdown.setOptions(opts.efforts, opts.defaultEffort);
      applySlotVisibility(opts);
      rebuildConfigDropdowns(profile);
    },
  }));

  // Worktree: a dropdown with two special choices up top — "create" (start in a fresh
  // worktree the agent makes) and "current" (run in the workbench cwd, no worktree) —
  // followed by the repo's branches (work on a chosen branch in its own worktree). The
  // worktree-in-title flows drop "create" (that's what the new-worktree flow is for); the
  // new-worktree flow has no dropdown at all (it's pinned to "create"). Specials use
  // sentinel values; the list is searchable; branches load asynchronously.
  const worktreeSpecials = worktreeInTitle
    ? [{ value: WT_CURRENT, label: 'current', cssClasses: ['worktree-current'] }]
    : [
        { value: WT_CREATE, label: 'create', cssClasses: ['worktree-create'] },
        { value: WT_CURRENT, label: 'current', cssClasses: ['worktree-current'] },
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
    // In the options row it carries a floating "worktree" title; the inline title flows
    // (worktreeInTitle) already label it in their sentence, so it goes untitled there.
    : disposables.use(new Combobox({ title: mode === 'default' ? 'worktree' : undefined, options: worktreeSpecials, value: worktreeInitial }));
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
    title.addCssClass('AgentLauncherTitle');
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
  const input = createInput({ placeholder: 'Prompt for the agent…', initialText: seededPrompt ?? draft, grow: true, maxLines: 20, padding: CARD_PADDING });
  const promptContainer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  promptContainer.addCssClass('AgentLauncherPrompt');
  promptContainer.append(input.root);
  panel.append(promptContainer);

  // Ring the whole card while the prompt editor (not the dropdowns) holds focus.
  const promptFocus = new Gtk.EventControllerFocus();
  promptFocus.on('enter', () => panel.addCssClass('prompt-focused'));
  promptFocus.on('leave', () => panel.removeCssClass('prompt-focused'));
  disposables.addController(promptContainer, promptFocus);

  // A WrapBox so the option fields reflow onto another line on a narrow card rather than
  // overflowing. Each combobox carries its own floating title (Adw.EntryRow-like) — no
  // caption row. The worktree field only appears here in the default flow (the worktree
  // flows surface it in the title).
  const optionsRow = new Adw.WrapBox({ childSpacing: 10, lineSpacing: 8 });
  optionsRow.addCssClass('AgentLauncherOptions');
  optionsRow.append(profileDropdown.root);
  optionsRow.append(modelDropdown.root);
  optionsRow.append(permissionDropdown.root);
  optionsRow.append(effortDropdown.root);
  const worktreeInRow = !!worktreeDropdown && mode === 'default';
  if (worktreeInRow) optionsRow.append(worktreeDropdown!.root);
  panel.append(optionsRow);

  // The picked profile's generic config-option dropdowns (ACP configOptions,
  // cache-seeded — model / effort / …). Their set changes per profile, so they're
  // rebuilt (not just re-optioned) on every profile change; their controllers +
  // popovers live in a re-armable nested bag. Kept just before the worktree field.
  const configBag = disposables.nest();
  const configDropdowns = new Map<string, Combobox>();
  let configWidgets: Array<InstanceType<typeof Gtk.Widget>> = [];
  rebuildConfigDropdowns = (profile: AgentProfile): void => {
    for (const w of configWidgets) optionsRow.remove(w);
    if (worktreeInRow) optionsRow.remove(worktreeDropdown!.root); // re-added last, after the new config fields
    configBag.clear();
    configWidgets = [];
    configDropdowns.clear();
    for (const option of profile.configOptions ?? []) {
      const saved = savedConfigOptions[option.id];
      const value = option.options.some((o) => o.value === saved) ? saved : option.default;
      const combo = configBag.use(new Combobox({
        title: option.name,
        options: option.options.map((o) => ({ value: o.value, label: o.label })),
        value,
      }));
      configDropdowns.set(option.id, combo);
      configWidgets.push(combo.root);
      optionsRow.append(combo.root);
    }
    if (worktreeInRow) optionsRow.append(worktreeDropdown!.root);
  };
  applySlotVisibility(kindOptions);
  rebuildConfigDropdowns(profile0);

  const submit = (background: boolean) => {
    const profile = profileById(profileDropdown.getValue()) ?? profile0;
    const kind = profile.kind;
    const selections = {
      model: modelDropdown.getValue(),
      permissionMode: permissionDropdown.getValue(),
      effort: effortDropdown.getValue(),
    };
    // An ACP profile is its argv plus the chosen options' args; the terminal
    // kind assembles its own from the model/permission/effort selections.
    const command = profile.command ? profileCommand(profile, selections) : AGENT_CONFIGS[kind].options.buildCommand(selections);
    // Generic config-option choices (applied over session/set_config_option).
    const configOptions: Record<string, string> = {};
    for (const [id, combo] of configDropdowns) { const v = combo.getValue(); if (v) configOptions[id] = v; }
    const prompt = input.getText().trim();
    // No dropdown (the new-worktree flow) → always a fresh worktree.
    const sel = worktreeDropdown?.getValue();
    const worktree: WorktreeChoice =
      sel === undefined || sel === WT_CREATE ? { create: true }
        : sel === WT_CURRENT ? { current: true }
          : { branch: sel };
    card.close(false); // onClose stashes the text…
    savedDraft = ''; // …but it was submitted, so don't restore it next time
    onLaunch({ prompt, command, cwd, kind, worktree, background, model: selections.model, permissionMode: selections.permissionMode, configOptions });
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
  // the card. This is why it isn't a plain `.AgentLauncher` keymap binding (capture phase).
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
    // A restored draft starts fully selected (keep or overtype); a seeded review does NOT — the user
    // means to send it, so a stray keystroke mustn't wipe it (cursor sits at the start to add to it).
    if (draft && !seededPrompt) input.selectAll();
  }
}

// The launch prompt for a new agent. The launcher's worktree choice is realized by the
// agent itself (there's no host-side worktree creation): prepend an instruction to set
// up the worktree and announce it via set_worktree (which re-roots the workbench), then
// run the user's prompt.
const NEW_WORKTREE_INSTRUCTION = outdent`
  Before anything else, create a new git worktree with a descriptive branch
  name for the task below and switch into it. The moment you are in it, you MUST
  call the set_worktree tool with the worktree's absolute path — before running
  any other command — so the editor re-roots to it. Then do the task:
`;
function branchWorktreeInstruction(branch: string): string {
  return outdent`
    Before anything else, switch into the git worktree for the branch ${branch}
    (create it if it does not exist). The moment you are in it, you MUST call the
    set_worktree tool with its absolute path — before running any other command —
    so the editor re-roots to it. Then do the task:
  `;
}

/** A launch prompt split into the two things downstream cares about separately:
 *  what the agent is told vs. what the *user* actually asked for. */
export interface LaunchPrompt {
  /** The agent's first turn: zym's editor instructions (worktree setup, if any)
   *  followed by the user's prompt. Undefined when there's nothing to send. */
  agentPrompt: string | undefined;
  /** The user's own prompt, free of zym's instructions — the context for
   *  auto-naming, so a generated title reflects the task and not our scaffolding.
   *  Undefined when the user typed nothing. */
  userPrompt: string | undefined;
}

/** Assemble the launch prompt for `openAgent` from the user's prompt and the chosen
 *  worktree option (see NEW_WORKTREE_INSTRUCTION). Keeps the user's prompt separate
 *  from the prepended editor instructions so each can be routed independently, and wraps
 *  the instructions in `<zym-editor-instructions label="…">` so the conversation shows a
 *  condensed label instead of the raw scaffolding (see parseEditorInstructions). */
export function launchPrompt(prompt: string, worktree: WorktreeChoice): LaunchPrompt {
  const userPrompt = prompt || undefined;
  if ('current' in worktree) return { agentPrompt: userPrompt, userPrompt }; // run in the cwd, no worktree setup
  const { label, body } = 'create' in worktree
    ? { label: 'Creating a new worktree', body: NEW_WORKTREE_INSTRUCTION }
    : { label: `Switching to worktree for ${worktree.branch}`, body: branchWorktreeInstruction(worktree.branch) };
  const instruction = wrapEditorInstructions(label, body);
  return { agentPrompt: prompt ? `${instruction}\n\n${prompt}` : instruction, userPrompt };
}
