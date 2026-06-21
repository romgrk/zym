/*
 * chromeStyles — the window's themeable chrome stylesheets. AppWindow installs
 * these once on construction (and could re-apply them on a future theme switch).
 * They are pure: each reads the current `theme` and writes a single keyed,
 * replaceable stylesheet via `styles.set`, so nothing here touches the window.
 */
import { styles } from '../styles.ts';
import { theme } from '../theme/theme.ts';

// Paint the window chrome (header bar, file tree, status/command bar, panel tab
// bars) plus popover surfaces (pickers) and selected entries with the theme's
// colors. Installed as a single keyed, replaceable stylesheet so a future theme
// switch can re-apply it. Themes without their own background (ui.bg unset)
// leave the chrome to the system Adwaita styling.
export function applyChromeStyles(): void {
  const { editor: { background: bg }, surface: { popover: popoverBg, selected: selectedBg } } = theme.ui;
  // A theme that follows the system scheme leaves the chrome to Adwaita.
  if (theme.followSystemScheme) {
    styles.remove('theme-chrome');
    return;
  }
  const border = theme.ui.border;
  // De-emphasized text for the empty-panel placeholder.
  const muted = theme.ui.text.muted;
  const rules = [
    `#Header, #WorkbenchList .workbench-header {
      background: ${bg};
      box-shadow: none;
      border-bottom: 1px solid ${border};
    }`,
    `#FileTree, #FileTree listview { background-color: ${bg}; }`,
    `#NotificationLog, #NotificationLog list { background-color: ${bg}; }`,
    `#KeymapPanel, #KeymapPanel viewport { background-color: ${bg}; }`,
    `#PluginManagerPanel, #PluginManagerPanel viewport { background-color: ${bg}; }`,
    `#LocationList, #LocationList list { background-color: ${bg}; }`,
    `#WorkbenchList, #WorkbenchList list { background-color: ${bg}; }`,
    `#GitPanel, #GitPanel list { background-color: ${bg}; }`,
    `#WorkbenchRow { padding: 2px 12px; }`,
    `#Panel tabbar .box,
     #Panel tabbar tabbox,
     #Panel tabbar tab { background-color: ${bg}; }`,
    `#Panel tabbar .box {
      box-shadow: none;
      padding: 0;
      min-height: 0;
    }`,
    `#Panel tabbar tabbox { padding: 0; min-height: 0; }`,
    // Square (un-rounded) tabs, separated by vertical borders.
    `#Panel tabbar tab {
      min-height: 0;
      padding: 2px 12px;
      border-radius: 0;
      border-right: 1px solid ${border};
    }`,
    `#Panel tabbar tab:first-child { border-left: 1px solid ${border}; }`,
    `#Panel tabbar tab:hover { background-color: shade(${bg}, 1.2); }`,
    `#Panel tabbar tab:selected {
      background-color: shade(${bg}, 1.6);
      box-shadow: inset 0 -2px ${border};
    }`,
    // The empty-panel placeholder blends into the app background; its text, face,
    // cat, cheatsheet and footer are all de-emphasized. The plain face brightens
    // to the foreground color when this is the active panel; the welcome state
    // stays muted throughout (the cat is a calm mascot, the rest reference text).
    // Keycaps derive their chrome from currentColor.
    `#PanelEmptyState { background-color: ${bg}; }`,
    `#PanelEmptyText, #PanelEmptyEmoticon, #PanelEmptyCat, #PanelEmptyCheatsheet, #PanelEmptyFooter { color: ${muted}; }`,
    `#PanelEmptyText.is-active, #PanelEmptyEmoticon.is-active { color: ${theme.ui.editor.foreground}; }`,
  ];

  // Popover surfaces: the picker card, its search entry, and result list.
  if (popoverBg) {
    rules.push(
      `#Picker,
       #PickerEntry,
       #PickerList,
       #PickerList list { background-color: ${popoverBg}; }`,
    );
  }

  // Selected entries in lists (file tree, picker results). The file-tree
  // selection is painted only while the tree is focused (`:focus-within`); an
  // unfocused tree drops it — see FileTree's `:not(:focus-within)` rule — so the
  // selected row reads as inactive. Pickers are always focused when shown.
  if (selectedBg) {
    rules.push(
      `#FileTree:focus-within listview row:selected,
       #PickerList row:selected,
       #WorkbenchList list row:selected { background-color: ${selectedBg}; }`,
    );
  }

  styles.set(rules.join('\n'), { key: 'theme-chrome' });
}

// Severity styling shared by the toasts and the log: each `notification-<type>`
// colors its icon, and a toast card gets a matching left accent border, so the
// severity is legible at a glance. Colors come from the theme's semantic keys
// (fatal reuses error); applied independently of the chrome so it works even
// for themes that leave the chrome to Adwaita.
export function applyNotificationStyles(): void {
  const { status: { info, success, warning, error }, text: { muted: textMuted }, surface: { popover: popoverBg }, border, shadow } = theme.ui;
  const colors: Record<string, string> = {
    trace: textMuted,
    info,
    success,
    warning,
    error,
    fatal: error,
  };

  const rules = [
    `.NotificationToast {
      background-color: ${popoverBg};
      border: 1px solid ${border};
      border-radius: 12px;
      padding: 8px 10px;
      min-width: 260px;
      box-shadow: 0 2px 8px ${shadow};
    }`,
    // Clickable toasts (default action) get a hover tint.
    `.NotificationToast.activatable:hover { background-color: shade(${popoverBg}, 1.15); }`,
  ];
  for (const [type, color] of Object.entries(colors)) {
    rules.push(`.notification-${type} .notification-icon { color: ${color}; }`);
    rules.push(`.NotificationToast.notification-${type} { border-left: 4px solid ${color}; }`);
    rules.push(`#NotificationRow.notification-${type} { border-left: 3px solid ${color}; padding-left: 6px; }`);
  }

  styles.set(rules.join('\n'), { key: 'notification-colors' });
}
