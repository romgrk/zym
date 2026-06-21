/*
 * AgentLauncher — the overlay for starting a new agent. A multi-line prompt editor
 * sits on top; a row of controls below it gathers the launch options (model,
 * effort [reserved], permission mode, agent kind, and a "new worktree" toggle).
 * Enter (in the prompt) launches, Escape cancels.
 *
 * It's a `FloatingCard` (the same overlay shell the Picker uses) filled with a
 * `createInput` prompt and reusable `Combobox` widgets. The options come from the
 * chosen kind's `AgentLaunchOptions` (see `agents/configs.ts`), so changing the kind
 * re-populates the model/permission lists — today the Claude kinds share a list, but
 * the wiring lets them diverge. `onLaunch` receives the assembled argv + cwd + kind;
 * the host turns that into `openAgent`.
 */
import { Gtk, Gdk, Adw } from '../gi.ts';
import { zym } from '../zym.ts';
import { addStyles } from '../styles.ts';
import { openFloatingCard } from './FloatingCard.ts';
import { Combobox } from './Combobox.ts';
import { createInput } from './TextEditor/TextEditor.ts';
import { AGENT_CONFIGS, listAgentKinds, type AgentKind } from '../agents/configs.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

const CARD_WIDTH = 640;

export interface AgentLaunchRequest {
  /** The (trimmed) prompt text, or '' if left empty. */
  prompt: string;
  /** Base argv for the chosen model/permission mode (e.g. `['claude','--model',…]`). */
  command: string[];
  /** Working directory to root the agent at (the current workbench cwd). */
  cwd: string;
  /** The chosen agent kind. */
  kind: AgentKind;
  /** Whether to start the work in a fresh git worktree (the agent creates it) rather
   *  than the current one. */
  newWorktree: boolean;
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
    box-shadow: 0px 10px 33px 28px var(--t-ui-shadow);
  }
  #AgentLauncherOptions {
    padding: 0.6em;
    background-color: var(--t-ui-editor-background);
    border-bottom-left-radius: var(--popover-radius);
    border-bottom-right-radius: var(--popover-radius);
  }
  /* Each option sits on its own raised chip: the elevated-surface background (pickers
     / popovers / menus), a step up from the footer's editor background behind them. */
  #AgentLauncherOptions #ComboboxList,
  #AgentLauncherOptions #AgentLauncherField {
    background-color: var(--t-ui-surface-popover);
    border-radius: var(--popover-radius-small);
  }
  #AgentLauncherField {
    padding: 4px 8px;
  }
  #AgentLauncherField > .field-caption {
    font-size: var(--font-size-small);
    opacity: 0.6;
    margin-left: 2px;
  }
`);

let keymapRegistered = false;
function registerLauncherKeymapOnce(): void {
  if (keymapRegistered) return;
  keymapRegistered = true;
  // Enter (in the prompt) launches; alt-enter inserts a newline — the app
  // convention for agent prompts (see AgentConversation). Escape is handled by a
  // bubble-phase controller on the card so an open combobox popover can swallow it
  // first (the window keymap runs in capture phase, ahead of that).
  zym.keymaps.add('agent-launcher', {
    '#AgentLauncherPrompt #TextEditor': {
      enter: 'launcher:submit',
      'alt-enter': 'launcher:newline',
    },
  });
}

/** Open the agent launcher overlay in `host`. */
export function openAgentLauncher(host: Overlay, options: AgentLauncherOptions): void {
  const { cwd, defaultKind, onLaunch } = options;

  let commandsSub: { dispose(): void } | null = null;
  const card = openFloatingCard({
    host,
    name: 'AgentLauncher',
    onClose: () => commandsSub?.dispose(),
  });
  const panel = card.panel;
  panel.setSizeRequest(CARD_WIDTH, -1);

  // The prompt — a buffer-only editor (full vim editing), wrapped in a named
  // container so the enter/alt-enter keymap scopes to it.
  const input = createInput({ placeholder: 'Prompt for the agent…' });
  input.root.setVexpand(false);
  input.root.setSizeRequest(-1, 120);
  const promptContainer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  promptContainer.setName('AgentLauncherPrompt');
  promptContainer.append(input.root);
  panel.append(promptContainer);

  // Options. The kind drives which models / permission modes are offered; the
  // Claude kinds share a list today, but changing the kind re-populates them.
  const kindOptions = AGENT_CONFIGS[defaultKind].options;

  const modelCombo = new Combobox({
    title: 'model',
    options: kindOptions.models,
    value: kindOptions.defaultModel,
    width: 140,
  });
  const permissionCombo = new Combobox({
    title: 'permission',
    options: kindOptions.permissionModes,
    value: kindOptions.defaultPermissionMode,
    width: 155,
  });
  const kindCombo = new Combobox({
    title: 'agent',
    options: listAgentKinds(),
    value: defaultKind,
    width: 130,
    onChange: (value) => {
      const opts = AGENT_CONFIGS[value as AgentKind].options;
      modelCombo.setOptions(opts.models, opts.defaultModel);
      permissionCombo.setOptions(opts.permissionModes, opts.defaultPermissionMode);
    },
  });

  // Effort isn't wired yet (no launch mechanism exists); a disabled slot reserves
  // its place so the row layout is stable when it lands.
  const effortCombo = new Combobox({
    title: 'effort',
    options: [{ value: 'auto', label: 'auto' }],
    value: 'auto',
    width: 120,
  });
  effortCombo.setSensitive(false);
  effortCombo.root.setTooltipText('Effort — coming soon');

  // Worktree is a toggle, not a combobox: "current" works in the current workbench
  // cwd, "new" starts the work in a fresh worktree (the agent creates it). A compact
  // captioned segmented control (a linked pair of grouped toggle buttons) with its
  // label on top, to stay tight in the option row.
  const currentButton = new Gtk.ToggleButton({ label: 'current' });
  const newButton = new Gtk.ToggleButton({ label: 'new' });
  newButton.setGroup(currentButton); // mutually exclusive (radio-like)
  currentButton.setActive(true);
  const worktreeToggle = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
  worktreeToggle.addCssClass('linked');
  worktreeToggle.append(currentButton);
  worktreeToggle.append(newButton);
  const worktreeField = field('worktree', worktreeToggle);
  worktreeField.setTooltipText('Start the work in a fresh git worktree instead of the current one');

  // A WrapBox so the option rows reflow onto another line on a narrow card rather
  // than overflowing. Each combobox carries its own floating Adwaita label.
  const optionsRow = new Adw.WrapBox({ childSpacing: 10, lineSpacing: 8 });
  optionsRow.setName('AgentLauncherOptions');
  for (const combo of [modelCombo, effortCombo, permissionCombo, kindCombo]) {
    optionsRow.append(combo.root);
  }
  optionsRow.append(worktreeField);
  panel.append(optionsRow);

  const submit = () => {
    const kind = kindCombo.getValue() as AgentKind;
    const command = AGENT_CONFIGS[kind].options.buildCommand({
      model: modelCombo.getValue(),
      permissionMode: permissionCombo.getValue(),
    });
    const prompt = input.getText().trim();
    card.close(false); // the host focuses the new agent
    onLaunch({ prompt, command, cwd, kind, newWorktree: newButton.getActive() });
  };

  registerLauncherKeymapOnce();
  commandsSub = zym.commands.add(panel, {
    'launcher:submit': { didDispatch: () => submit(), description: 'Launch the agent' },
    'launcher:newline': { didDispatch: () => input.insertText('\n'), description: 'Insert a newline in the prompt' },
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
}

// A captioned field: a small muted label on top of `control`. Used for controls that
// (unlike the comboboxes' Adw.EntryRow) have no built-in floating label.
function field(caption: string, control: InstanceType<typeof Gtk.Widget>): InstanceType<typeof Gtk.Box> {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3 });
  box.setName('AgentLauncherField');
  const label = new Gtk.Label({ xalign: 0, label: caption });
  label.addCssClass('field-caption');
  box.append(label);
  box.append(control);
  return box;
}
