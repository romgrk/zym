/*
 * AgentLauncher — the overlay for starting a new agent. A multi-line prompt editor
 * sits on top; a row of comboboxes below it gathers the launch options (model,
 * effort [reserved], permission mode, worktree, and agent kind). Enter (in the
 * prompt) launches, Escape cancels.
 *
 * It's a `FloatingCard` (the same overlay shell the Picker uses) filled with a
 * `createInput` prompt and reusable `Combobox` widgets. The options come from the
 * chosen kind's `AgentLaunchOptions` (see `agents/configs.ts`), so changing the kind
 * re-populates the model/permission lists — today the Claude kinds share a list, but
 * the wiring lets them diverge. `onLaunch` receives the assembled argv + cwd + kind;
 * the host turns that into `openAgent`.
 */
import { Gtk, Gdk, Adw } from '../gi.ts';
import Path from 'node:path';
import { zym } from '../zym.ts';
import { addStyles } from '../styles.ts';
import { openFloatingCard } from './FloatingCard.ts';
import { Combobox, type ComboOption } from './Combobox.ts';
import { createInput } from './TextEditor/TextEditor.ts';
import { AGENT_CONFIGS, listAgentKinds, type AgentKind } from '../agents/configs.ts';
import { listWorktrees } from '../git.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

const CARD_WIDTH = 640;

export interface AgentLaunchRequest {
  /** The (trimmed) prompt text, or '' if left empty. */
  prompt: string;
  /** Base argv for the chosen model/permission mode (e.g. `['claude','--model',…]`). */
  command: string[];
  /** Working directory to root the agent at (the chosen worktree, or the launch cwd). */
  cwd: string;
  /** The chosen agent kind. */
  kind: AgentKind;
}

export interface AgentLauncherOptions {
  /** The current working directory (offered as "current", plus the repo's worktrees). */
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
  #AgentLauncherPrompt {
    padding: 0.5em;
  }
  #AgentLauncherOptions {
    padding: 0.5em;
    border-top: 1px solid var(--border-color);
  }
  #AgentLauncherField > .field-caption {
    font-size: var(--font-size-small);
    opacity: 0.6;
    margin-bottom: 2px;
  }
  #AgentLauncherFooter {
    padding: 0.4em 0.75em;
    border-top: 1px solid var(--border-color);
    opacity: 0.6;
    font-size: var(--font-size-small);
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
    options: kindOptions.models,
    value: kindOptions.defaultModel,
    width: 130,
  });
  const permissionCombo = new Combobox({
    options: kindOptions.permissionModes,
    value: kindOptions.defaultPermissionMode,
    width: 140,
  });
  const kindCombo = new Combobox({
    options: listAgentKinds(),
    value: defaultKind,
    width: 110,
    onChange: (value) => {
      const opts = AGENT_CONFIGS[value as AgentKind].options;
      modelCombo.setOptions(opts.models, opts.defaultModel);
      permissionCombo.setOptions(opts.permissionModes, opts.defaultPermissionMode);
    },
  });

  // Effort isn't wired yet (no launch mechanism exists); a disabled slot reserves
  // its place so the row layout is stable when it lands.
  const effortCombo = new Combobox({
    options: [{ value: 'auto', label: 'auto' }],
    value: 'auto',
    width: 100,
  });
  effortCombo.setSensitive(false);
  effortCombo.root.setTooltipText('Effort — coming soon');

  const worktreeCombo = new Combobox({
    options: worktreeOptions(cwd),
    value: cwd,
    width: 150,
  });

  // A WrapBox so the options reflow onto another line on a narrow card rather than
  // overflowing.
  const optionsRow = new Adw.WrapBox({ childSpacing: 10, lineSpacing: 8 });
  optionsRow.setName('AgentLauncherOptions');
  for (const [caption, combo] of [
    ['model', modelCombo],
    ['effort', effortCombo],
    ['permission', permissionCombo],
    ['worktree', worktreeCombo],
    ['agent', kindCombo],
  ] as const) {
    optionsRow.append(field(caption, combo));
  }
  panel.append(optionsRow);

  const footer = new Gtk.Label({ xalign: 0, label: '⏎ launch · esc cancel' });
  footer.setName('AgentLauncherFooter');
  panel.append(footer);

  const submit = () => {
    const kind = kindCombo.getValue() as AgentKind;
    const command = AGENT_CONFIGS[kind].options.buildCommand({
      model: modelCombo.getValue(),
      permissionMode: permissionCombo.getValue(),
    });
    const prompt = input.getText().trim();
    card.close(false); // the host focuses the new agent
    onLaunch({ prompt, command, cwd: worktreeCombo.getValue(), kind });
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

// One option per worktree, prefixed by "current" (the launch cwd). The main checkout
// or a linked worktree that *is* the cwd isn't repeated.
function worktreeOptions(cwd: string): ComboOption[] {
  const options: ComboOption[] = [{ value: cwd, label: 'current', detail: Path.basename(cwd) }];
  for (const wt of listWorktrees(cwd)) {
    if (wt.path === cwd) continue;
    options.push({ value: wt.path, label: wt.name, detail: wt.branch ?? 'detached' });
  }
  return options;
}

// A captioned field: a small muted label above a combobox.
function field(caption: string, combo: Combobox): InstanceType<typeof Gtk.Box> {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
  box.setName('AgentLauncherField');
  const label = new Gtk.Label({ xalign: 0, label: caption });
  label.addCssClass('field-caption');
  box.append(label);
  box.append(combo.root);
  return box;
}
