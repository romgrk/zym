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
import { Gtk, Gdk, Adw } from '../gi.ts';
import { zym } from '../zym.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { openFloatingCard } from './FloatingCard.ts';
import { Combobox } from './Combobox.ts';
import { createInput } from './TextEditor/TextEditor.ts';
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

export interface AgentLauncherOptions {
  /** The current working directory the agent is rooted at by default. */
  cwd: string;
  /** The kind selected by default (from `resolveAgentKind(config)`). */
  defaultKind: AgentKind;
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
    background-color: var(--window-bg-color);
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
    background-color: var(--t-ui-editor-background);
    border-bottom-left-radius: var(--popover-radius);
    border-bottom-right-radius: var(--popover-radius);
  }
  #AgentLauncherField > .field-caption {
    font-size: var(--t-font-ui-size-small);
    color: var(--t-ui-text-muted);
    padding-left: 6px;
  }
`);

let keymapRegistered = false;
function registerLauncherKeymapOnce(): void {
  if (keymapRegistered) return;
  keymapRegistered = true;
  // Enter (in the prompt) launches and switches to the agent; alt-enter inserts a newline
  // (the app convention, see AgentConversation). ctrl-enter launches from anywhere in the
  // card (incl. the option dropdowns); ctrl-shift-enter launches in the background (without
  // switching to the new agent). Escape is handled by a bubble-phase controller on the card
  // so an open combobox popover can swallow it first (the window keymap runs in capture
  // phase, ahead of that).
  zym.keymaps.add('agent-launcher', {
    '#AgentLauncher': {
      'ctrl-enter': 'launcher:submit',
      'ctrl-shift-enter': 'launcher:submit-background',
    },
    '#AgentLauncherPrompt #TextEditor': {
      enter: 'launcher:submit',
      'shift-enter': 'launcher:submit-background',
      'alt-enter': 'launcher:newline',
    },
    // From NORMAL mode, q or escape dismiss the launcher (in insert mode escape is
    // vim's insert→normal, so it doesn't reach this). Mirrors DiffCommentBox.
    '#AgentLauncherPrompt #TextEditor.normal-mode': {
      q: 'launcher:close',
      escape: 'launcher:close',
    },
  });
}

/** Open the agent launcher overlay in `host`. */
export function openAgentLauncher(host: Overlay, options: AgentLauncherOptions): void {
  const { cwd, defaultKind, onLaunch } = options;

  const draft = savedDraft; // an unsent prompt from a previous dismissal, if any

  let commandsSub: { dispose(): void } | null = null;
  const card = openFloatingCard({
    host,
    name: 'AgentLauncher',
    marginTop: 110, // sit lower than the Picker's default — it's a taller compose card
    dim: true, // it's a focused compose surface — dim the rest of the window
    fade: true,
    // Remember the (possibly unsent) prompt + the chosen options on any dismissal, so they
    // persist to the next launch; submit clears the draft below (but keeps the options).
    onClose: () => {
      savedDraft = input.getText();
      savedModel = modelDropdown.getValue();
      savedPermission = permissionDropdown.getValue();
      savedKind = kindDropdown.getValue() as AgentKind;
      savedWorktree = worktreeDropdown.getValue();
      commandsSub?.dispose();
    },
  });
  const panel = card.panel;
  panel.setSizeRequest(CARD_WIDTH, -1);

  // The prompt — a buffer-only editor (full vim editing) that auto-grows with its
  // content up to 5 lines (then scrolls), wrapped in a named container so the
  // enter/alt-enter keymap scopes to it. Seeded with any restored draft.
  const input = createInput({ placeholder: 'Prompt for the agent…', initialText: draft, grow: true, maxLines: 5, padding: CARD_PADDING });
  const promptContainer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  promptContainer.setName('AgentLauncherPrompt');
  promptContainer.append(input.root);
  panel.append(promptContainer);

  // Ring the whole card while the prompt editor (not the dropdowns) holds focus.
  const promptFocus = new Gtk.EventControllerFocus();
  promptFocus.on('enter', () => panel.addCssClass('prompt-focused'));
  promptFocus.on('leave', () => panel.removeCssClass('prompt-focused'));
  promptContainer.addController(promptFocus);

  // Options, seeded from the last-used values (else the kind's defaults). The kind drives
  // which models / permission modes are offered; the Claude kinds share a list today, but
  // changing the kind re-populates them (to that kind's defaults).
  const kind0 = savedKind || defaultKind;
  const kindOptions = AGENT_CONFIGS[kind0].options;

  const modelDropdown = new Combobox({ options: kindOptions.models, value: savedModel || kindOptions.defaultModel });
  const permissionDropdown = new Combobox({ options: kindOptions.permissionModes, value: savedPermission || kindOptions.defaultPermissionMode });
  const kindDropdown = new Combobox({
    options: listAgentKinds(),
    value: kind0,
    onChange: (value) => {
      const opts = AGENT_CONFIGS[value as AgentKind].options;
      modelDropdown.setOptions(opts.models, opts.defaultModel);
      permissionDropdown.setOptions(opts.permissionModes, opts.defaultPermissionMode);
    },
  });

  // Worktree: a dropdown with two special choices up top — "create" (start in a fresh
  // worktree the agent makes) and "current" (run in the workbench cwd, no worktree) —
  // followed by the repo's branches (work on a chosen branch in its own worktree). The
  // specials use sentinel values; the list is searchable; branches load asynchronously.
  const worktreeSpecials = [
    { value: WT_CREATE, label: 'create' },
    { value: WT_CURRENT, label: 'current' },
  ];
  const worktreeDropdown = new Combobox({
    options: worktreeSpecials,
    value: savedWorktree,
    specialLabels: ['create'],
    mutedLabels: ['current'],
  });
  const worktreeField = field('worktree', worktreeDropdown.root);
  const repo = repoRoot(cwd);
  if (repo) {
    listBranches(repo, (branches) => {
      if (card.isClosed()) return;
      worktreeDropdown.setOptions(
        [...worktreeSpecials, ...branches.map((b) => ({ value: b, label: b }))],
        savedWorktree, // keep the last-used choice selected if it still exists
      );
    });
  }

  // A WrapBox so the option fields reflow onto another line on a narrow card rather
  // than overflowing. Each field carries a caption above its control.
  const optionsRow = new Adw.WrapBox({ childSpacing: 10, lineSpacing: 8 });
  optionsRow.setName('AgentLauncherOptions');
  optionsRow.append(field('agent', kindDropdown.root));
  optionsRow.append(field('model', modelDropdown.root));
  optionsRow.append(field('permission', permissionDropdown.root));
  optionsRow.append(worktreeField);
  panel.append(optionsRow);

  const submit = (background: boolean) => {
    const kind = kindDropdown.getValue() as AgentKind;
    const command = AGENT_CONFIGS[kind].options.buildCommand({
      model: modelDropdown.getValue(),
      permissionMode: permissionDropdown.getValue(),
    });
    const prompt = input.getText().trim();
    const sel = worktreeDropdown.getValue();
    const worktree: WorktreeChoice =
      sel === WT_CREATE ? { create: true } : sel === WT_CURRENT ? { current: true } : { branch: sel };
    card.close(false); // onClose stashes the text…
    savedDraft = ''; // …but it was submitted, so don't restore it next time
    onLaunch({ prompt, command, cwd, kind, worktree, background });
  };

  registerLauncherKeymapOnce();
  commandsSub = zym.commands.add(panel, {
    'launcher:submit': { didDispatch: () => submit(false), description: 'Launch the agent and switch to it' },
    'launcher:submit-background': { didDispatch: () => submit(true), description: 'Launch the agent without switching to it' },
    'launcher:newline': { didDispatch: () => input.insertText('\n'), description: 'Insert a newline in the prompt' },
    'launcher:close': { didDispatch: () => card.close(), description: 'Close the launcher' },
  });

  // Escape closes the card — handled here in the bubble phase so a combobox's own
  // capture-phase Escape (closing its open popover) wins first; only an unhandled
  // Escape bubbles up to dismiss the card.
  const keys = new Gtk.EventControllerKey();
  keys.on('key-pressed', (keyval: number) => {
    if (keyval !== Gdk.KEY_Escape) return false;
    card.close();
    return true;
  });
  panel.addController(keys);

  input.focusInsert(); // ready to type the prompt immediately
  if (draft) input.selectAll(); // a restored draft starts fully selected (keep or overtype)
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
