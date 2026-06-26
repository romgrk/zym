/*
 * WelcomePanel — the welcome surface shown in any empty panel (see Panel's empty
 * state), styled after Vim/Nvim's start screen: a sleeping cat (our "logo") above
 * a centered, monospace keybinding cheatsheet — the binding (canonical form) on
 * the left, the action on the right — and a charitable callout below. Everything
 * stays muted (colors come from the theme chrome); the cat is a calm mascot.
 *
 * Purely presentational and stateless (no controllers/handlers/timers), so it's a
 * plain `welcomePanel()` builder rather than a class — the host just parents the
 * returned widget and drops it on close; there's nothing to dispose.
 */
import { Gtk } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { ImageIcons } from '../icons.ts';
import { keycap } from './Keycap.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

// Structural styles only (layout + type scale + the cat's muted opacity); the
// keycap badge brings its own chrome (see Keycap.ts) and colors come from the
// theme chrome.
addStyles(/* css */`
  /* The cat is a calm, de-emphasized mascot — muted (theme chrome) and a touch
     translucent so it never competes with the text. */
  .PanelEmptyCat { opacity: 0.6; }
  .PanelEmptyCheatsheet,
  .PanelEmptyFooter {
    font-family: var(--t-font-monospace-family, monospace);
  }
  .PanelEmptyCheatsheet { margin-top: 6px; font-size: 1.1em; }
  /* The charitable callout is a quiet footnote: title a line above the link. */
  .PanelEmptyFooter { margin-top: 26px; font-size: 1.05em; }
  .PanelEmptyFooter .cheat-footer-hint { margin-top: 5px; }
`);

// The sleeping cat "logo": a bundled symbolic SVG from the `ImageIcons` catalog,
// recolored to the text color like any symbolic icon (and muted via
// .PanelEmptyCat's opacity).
const CAT_ICON_SIZE = 52;

// A handful of high-value commands. `keys` is the binding in its canonical form —
// the exact keystroke string from the default keymap (see keymaps/default.ts) —
// shown as a single badge (e.g. `space f f`).
const WELCOME_SHORTCUTS: ReadonlyArray<{ action: string; keys: string }> = [
  { action: 'Command palette', keys: 'space space' }, // command-palette:toggle
  { action: 'Find a file', keys: 'space o' }, // file:find
  { action: 'Search in project', keys: 'space /' }, // project:search
  { action: 'File tree', keys: 'space f f' }, // file-tree:focus
  { action: 'Source control', keys: 'space g g' }, // git-panel:focus
  { action: 'New terminal', keys: 'space t' }, // terminal:new
  { action: 'New agent', keys: 'space a n n' }, // agent:new
  { action: 'Show all keybindings', keys: 'space ?' }, // keymap:show
];

// A charitable callout under the cheatsheet, in the spirit of Vim/Nvim's start
// screen (`:help Kuwasha`). Kuwasha supports the Kibaale Community Centre in
// Uganda; the link opens its child-sponsorship page.
const HELP_CHILDREN_TITLE = 'Help children in Uganda';
const HELP_CHILDREN_URL = 'https://www.kuwasha.net/sponsorship/';
const HELP_CHILDREN_LINK = 'kuwasha.net';

/**
 * Build the welcome surface: a centered, self-contained widget hosting the cat,
 * the keybinding cheatsheet, and the charitable callout. The returned box expands
 * to claim its area then centers within it, so a host can parent it directly.
 */
export function welcomePanel(): Widget {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  box.setHexpand(true);
  box.setVexpand(true);
  box.setHalign(Gtk.Align.CENTER);
  box.setValign(Gtk.Align.CENTER);

  const cat = ImageIcons.CAT_SLEEPING(CAT_ICON_SIZE);
  cat.addCssClass('PanelEmptyCat');
  cat.setMarginBottom(20);
  box.append(cat);

  // Two columns, like nvim's "type :cmd   description": the binding badge
  // right-aligned in column 0, the action left-aligned in column 1, so a clean
  // gutter runs down the middle.
  const grid = new Gtk.Grid();
  grid.addCssClass('PanelEmptyCheatsheet');
  grid.setRowSpacing(7);
  grid.setColumnSpacing(16);
  grid.setHalign(Gtk.Align.CENTER);

  WELCOME_SHORTCUTS.forEach((shortcut, row) => {
    const badge = keycap(shortcut.keys); // one unified badge holding the whole binding
    badge.setHalign(Gtk.Align.END);
    grid.attach(badge, 0, row, 1, 1);

    const action = new Gtk.Label({ label: shortcut.action });
    action.addCssClass('cheat-action');
    action.setHalign(Gtk.Align.START);
    action.setHexpand(true);
    grid.attach(action, 1, row, 1, 1);
  });

  box.append(grid);
  box.append(buildHelpChildren());
  return box;
}

// The charitable callout (cf. nvim's `:help Kuwasha`): a heading over a line with
// a clickable link to Kuwasha's sponsorship page (GtkLabel opens the URI itself).
function buildHelpChildren(): InstanceType<typeof Gtk.Box> {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  box.addCssClass('PanelEmptyFooter');
  box.setHalign(Gtk.Align.CENTER);

  const title = new Gtk.Label({ label: HELP_CHILDREN_TITLE });
  title.addCssClass('cheat-footer-title');
  box.append(title);

  const link = new Gtk.Label();
  link.addCssClass('cheat-footer-hint');
  link.setUseMarkup(true);
  link.setMarkup(`visit  <a href="${HELP_CHILDREN_URL}">${HELP_CHILDREN_LINK}</a>  to help`);
  box.append(link);

  return box;
}
