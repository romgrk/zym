/*
 * AgentLauncher — the overlay for starting a new agent. A multi-line prompt editor
 * sits on top; a row of controls below it gathers the launch options (model,
 * permission mode, agent kind, and a "new worktree" toggle). Enter (in the prompt)
 * launches, Escape cancels.
 *
 * It's a `FloatingCard` (the same overlay shell the Picker uses) filled with a
 * `createInput` prompt and `Gtk.DropDown`s for the options (model, permission, agent,
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
import { createInput } from './TextEditor/TextEditor.ts';
import { AGENT_CONFIGS, listAgentKinds, type AgentKind, type LaunchOption } from '../agents/configs.ts';
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

/** The worktree choice: create a fresh worktree, or work on an existing branch. */
export type WorktreeChoice = { create: true } | { branch: string };

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
  /* The worktree "Create" option, set apart from the branch names. */
  .combobox-special {
    color: var(--accent-color);
    font-weight: bold;
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
    dim: true, // it's a focused compose surface — dim the rest of the window
    fade: true,
    // Remember the (possibly unsent) prompt on any dismissal; submit clears it below.
    onClose: () => { savedDraft = input.getText(); commandsSub?.dispose(); },
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

  // Options. The kind drives which models / permission modes are offered; the
  // Claude kinds share a list today, but changing the kind re-populates them.
  const kindOptions = AGENT_CONFIGS[defaultKind].options;

  const modelDropdown = new OptionDropdown({ options: kindOptions.models, value: kindOptions.defaultModel });
  const permissionDropdown = new OptionDropdown({ options: kindOptions.permissionModes, value: kindOptions.defaultPermissionMode });
  const kindDropdown = new OptionDropdown({
    options: listAgentKinds(),
    value: defaultKind,
    onChange: (value) => {
      const opts = AGENT_CONFIGS[value as AgentKind].options;
      modelDropdown.setOptions(opts.models, opts.defaultModel);
      permissionDropdown.setOptions(opts.permissionModes, opts.defaultPermissionMode);
    },
  });

  // Worktree: a dropdown whose first value, "create", starts the work in a fresh
  // worktree (the agent creates it); the rest are the repo's branches, to work on a
  // chosen branch in its own worktree. "create" is the empty-string sentinel (a branch
  // name can never be empty), rendered specially, and the list is searchable. Branches
  // load asynchronously.
  const worktreeDropdown = new OptionDropdown({
    options: [{ value: '', label: 'create' }],
    value: '',
    search: true,
    specialLabel: 'create',
  });
  const worktreeField = field('worktree', worktreeDropdown.widget);
  const repo = repoRoot(cwd);
  if (repo) {
    listBranches(repo, (branches) => {
      if (card.isClosed()) return;
      worktreeDropdown.setOptions(
        [{ value: '', label: 'create' }, ...branches.map((b) => ({ value: b, label: b }))],
        '',
      );
    });
  }

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
    const sel = worktreeDropdown.getValue();
    const worktree: WorktreeChoice = sel === '' ? { create: true } : { branch: sel };
    card.close(false); // onClose stashes the text…
    savedDraft = ''; // …but it was submitted, so don't restore it next time
    onLaunch({ prompt, command, cwd, kind, worktree });
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

interface OptionDropdownConfig {
  options: LaunchOption[];
  value: string;
  onChange?: (value: string) => void;
  /** Show a search entry in the popup and filter the list by it. */
  search?: boolean;
  /** A label rendered with emphasis (the `.combobox-special` accent), e.g. "create". */
  specialLabel?: string;
}

// A Gtk.DropDown over a list of LaunchOptions: shows each option's label, maps the
// selection back to its value (by the selected item's string, so it's robust to search
// filtering), and can be re-populated (when the kind changes the available models, or
// branches load in). Opt-in search and a special-styled label.
//
// Search is wired *without* a GtkExpression (node-gtk mishandles GtkExpression, which
// isn't a GObject): the model is wrapped in a FilterListModel + CustomFilter, and the
// dropdown's own search entry drives the filter via its `search-changed` signal — the
// approach from https://discourse.gnome.org/t/.../12748.
class OptionDropdown {
  readonly widget: InstanceType<typeof Gtk.DropDown>;
  private values: string[] = [];
  private labelToValue = new Map<string, string>();
  private applying = false; // suppress onChange while re-populating
  private base: InstanceType<typeof Gtk.StringList>;
  private readonly filtered: InstanceType<typeof Gtk.FilterListModel> | null = null;
  private query = '';

  constructor(config: OptionDropdownConfig) {
    this.base = Gtk.StringList.new(config.options.map((o) => o.label));
    if (config.search) {
      this.filtered = Gtk.FilterListModel.new(this.base, null);
      const filter = Gtk.CustomFilter.new((item: any) =>
        this.query === '' || String(item.getString()).toLowerCase().includes(this.query),
      );
      this.filtered.setFilter(filter);
      this.widget = Gtk.DropDown.new(this.filtered, null);
      this.widget.setEnableSearch(true);
      this.wireSearch(filter);
    } else {
      this.widget = Gtk.DropDown.new(this.base, null);
    }
    this.widget.addCssClass('flat');
    this.ingest(config.options);

    if (config.specialLabel !== undefined) {
      const special = config.specialLabel;
      const factory = new Gtk.SignalListItemFactory();
      factory.on('setup', (li: any) => li.setChild(new Gtk.Label({ xalign: 0 })));
      factory.on('bind', (li: any) => {
        const label = li.getChild();
        const text = (li.getItem() as any).getString();
        label.setText(text);
        if (text === special) label.addCssClass('combobox-special');
        else label.removeCssClass('combobox-special');
      });
      this.widget.setFactory(factory);
    }

    this.selectValue(config.value);
    if (config.onChange) {
      const onChange = config.onChange;
      this.widget.on('notify::selected', () => { if (!this.applying) onChange(this.getValue()); });
    }
  }

  getValue(): string {
    const item = this.widget.getSelectedItem() as any;
    if (item) {
      const v = this.labelToValue.get(item.getString());
      if (v !== undefined) return v;
    }
    return this.values[0] ?? '';
  }

  setOptions(options: LaunchOption[], value: string): void {
    this.applying = true;
    this.base = Gtk.StringList.new(options.map((o) => o.label));
    if (this.filtered) this.filtered.setModel(this.base);
    else this.widget.setModel(this.base);
    this.ingest(options);
    this.selectValue(value);
    this.applying = false;
  }

  // Drive `filter` from the dropdown's built-in search entry (found by walking the
  // popup), re-filtering on each keystroke.
  private wireSearch(filter: InstanceType<typeof Gtk.CustomFilter>): void {
    const entry = findDescendant(this.widget, (w) => w instanceof Gtk.SearchEntry) as
      | InstanceType<typeof Gtk.SearchEntry>
      | null;
    if (!entry) return;
    entry.on('search-changed', () => {
      this.query = (entry.getText() ?? '').toLowerCase();
      filter.changed(Gtk.FilterChange.DIFFERENT);
    });
  }

  private ingest(options: LaunchOption[]): void {
    this.values = options.map((o) => o.value);
    this.labelToValue = new Map(options.map((o) => [o.label, o.value]));
  }

  private selectValue(value: string): void {
    const i = this.values.indexOf(value);
    this.widget.setSelected(i >= 0 ? i : 0);
  }
}

// Depth-first search of a widget's descendants (including popups, which are children in
// GTK4) for the first one matching `pred`.
function findDescendant(
  root: InstanceType<typeof Gtk.Widget>,
  pred: (w: InstanceType<typeof Gtk.Widget>) => boolean,
): InstanceType<typeof Gtk.Widget> | null {
  if (pred(root)) return root;
  for (let c = root.getFirstChild(); c; c = c.getNextSibling()) {
    const found = findDescendant(c, pred);
    if (found) return found;
  }
  return null;
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
