/*
 * AgentLauncher — the overlay for starting a new agent. A multi-line prompt editor
 * sits on top; a row of controls below it gathers the launch options (model,
 * permission mode, agent kind, and a "new worktree" toggle). Enter (in the prompt)
 * launches, Escape cancels.
 *
 * It's a `FloatingCard` (the same overlay shell the Picker uses) filled with a
 * `createInput` prompt, `Gtk.DropDown`s for the picked options, and a toggle-button
 * group for the worktree choice. The options come from the chosen kind's
 * `AgentLaunchOptions` (see `agents/configs.ts`), so changing the kind re-populates
 * the model/permission lists — today the Claude kinds share a list, but the wiring
 * lets them diverge. `onLaunch` receives the assembled argv + cwd + kind; the host
 * turns that into `openAgent`.
 */
import { Gtk, Gdk, Adw } from '../gi.ts';
import { zym } from '../zym.ts';
import { addStyles } from '../styles.ts';
import { openFloatingCard } from './FloatingCard.ts';
import { createInput } from './TextEditor/TextEditor.ts';
import { AGENT_CONFIGS, listAgentKinds, type AgentKind, type LaunchOption } from '../agents/configs.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

const CARD_WIDTH = 640;

// An unsent prompt left over from a dismissed launcher, restored (fully selected) on
// the next open so a cancelled compose isn't lost. Cleared once submitted.
let savedDraft = '';

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
  }
  #AgentLauncherOptions {
    padding: 0.6em;
    /* The card is monospace (for the prompt); the option controls read better in the
       UI (proportional) font. */
    font: var(--t-font-ui);
    background-color: var(--t-ui-editor-background);
    border-bottom-left-radius: var(--popover-radius);
    border-bottom-right-radius: var(--popover-radius);
  }
  #AgentLauncherField {
    padding: 4px 8px;
  }
  /* The dropdowns sit flush in the option row (no extra button frame/background). */
  #AgentLauncherField > dropdown {
    background: none;
    box-shadow: none;
    padding: 0;
  }
  #AgentLauncherField > .field-caption {
    font-size: var(--font-size-small);
    color: var(--t-ui-text-muted);
    padding-left: 6px;
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
    // Remember the (possibly unsent) prompt on any dismissal; submit clears it below.
    onClose: () => { savedDraft = input.getText(); commandsSub?.dispose(); },
  });
  const panel = card.panel;
  panel.setSizeRequest(CARD_WIDTH, -1);

  // The prompt — a buffer-only editor (full vim editing) that auto-grows with its
  // content up to 5 lines (then scrolls), wrapped in a named container so the
  // enter/alt-enter keymap scopes to it. Seeded with any restored draft.
  const input = createInput({ placeholder: 'Prompt for the agent…', initialText: draft, grow: true, maxLines: 5 });
  const promptContainer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  promptContainer.setName('AgentLauncherPrompt');
  promptContainer.append(input.root);
  panel.append(promptContainer);

  // Options. The kind drives which models / permission modes are offered; the
  // Claude kinds share a list today, but changing the kind re-populates them.
  const kindOptions = AGENT_CONFIGS[defaultKind].options;

  const modelDropdown = new OptionDropdown(kindOptions.models, kindOptions.defaultModel);
  const permissionDropdown = new OptionDropdown(kindOptions.permissionModes, kindOptions.defaultPermissionMode);
  const kindDropdown = new OptionDropdown(listAgentKinds(), defaultKind, (value) => {
    const opts = AGENT_CONFIGS[value as AgentKind].options;
    modelDropdown.setOptions(opts.models, opts.defaultModel);
    permissionDropdown.setOptions(opts.permissionModes, opts.defaultPermissionMode);
  });

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

  // A WrapBox so the option fields reflow onto another line on a narrow card rather
  // than overflowing. Each field carries a caption above its control.
  const optionsRow = new Adw.WrapBox({ childSpacing: 10, lineSpacing: 8 });
  optionsRow.setName('AgentLauncherOptions');
  optionsRow.append(field('agent', kindDropdown.widget));
  optionsRow.append(field('model', modelDropdown.widget));
  optionsRow.append(field('permission', permissionDropdown.widget));
  optionsRow.append(worktreeField);
  panel.append(optionsRow);

  const submit = () => {
    const kind = kindDropdown.getValue() as AgentKind;
    const command = AGENT_CONFIGS[kind].options.buildCommand({
      model: modelDropdown.getValue(),
      permissionMode: permissionDropdown.getValue(),
    });
    const prompt = input.getText().trim();
    card.close(false); // onClose stashes the text…
    savedDraft = ''; // …but it was submitted, so don't restore it next time
    onLaunch({ prompt, command, cwd, kind, newWorktree: newButton.getActive() });
  };

  registerLauncherKeymapOnce();
  commandsSub = zym.commands.add(panel, {
    'launcher:submit': { didDispatch: () => submit(), description: 'Launch the agent' },
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

// A Gtk.DropDown over a list of LaunchOptions: shows each option's label, maps the
// selection back to its value, and can be re-populated (when the kind changes the
// available models / permission modes).
class OptionDropdown {
  readonly widget: InstanceType<typeof Gtk.DropDown>;
  private values: string[];
  private applying = false; // suppress onChange while re-populating

  constructor(options: LaunchOption[], value: string, onChange?: (value: string) => void) {
    this.widget = Gtk.DropDown.newFromStrings(options.map((o) => o.label));
    this.widget.addCssClass('flat');
    this.values = options.map((o) => o.value);
    this.selectValue(value);
    if (onChange) {
      this.widget.on('notify::selected', () => { if (!this.applying) onChange(this.getValue()); });
    }
  }

  getValue(): string {
    return this.values[this.widget.getSelected()] ?? this.values[0] ?? '';
  }

  setOptions(options: LaunchOption[], value: string): void {
    this.applying = true;
    this.widget.setModel(Gtk.StringList.new(options.map((o) => o.label)));
    this.values = options.map((o) => o.value);
    this.selectValue(value);
    this.applying = false;
  }

  private selectValue(value: string): void {
    const i = this.values.indexOf(value);
    this.widget.setSelected(i >= 0 ? i : 0);
  }
}

// A captioned field: a small muted label on top of `control`. Used for the dropdowns
// and the worktree toggle (Gtk.DropDown has no built-in label).
function field(caption: string, control: InstanceType<typeof Gtk.Widget>): InstanceType<typeof Gtk.Box> {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3 });
  box.setName('AgentLauncherField');
  const label = new Gtk.Label({ xalign: 0, label: caption });
  label.addCssClass('field-caption');
  box.append(label);
  box.append(control);
  return box;
}
