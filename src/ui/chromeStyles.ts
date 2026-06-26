/*
 * chromeStyles — the window's themeable chrome stylesheets. AppWindow installs
 * these once on construction (and could re-apply them on a future theme switch).
 * They are pure: each reads the current `theme` and writes a single keyed,
 * replaceable stylesheet via `styles.set`, so nothing here touches the window.
 */
import { styles } from '../styles.ts';
import { theme } from '../theme/theme.ts';

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
      border: 1px solid var(--border-color);
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
    rules.push(`.NotificationRow.notification-${type} { border-left: 3px solid ${color}; padding-left: 6px; }`);
  }

  styles.set(rules.join('\n'), { key: 'notification-colors' });
}
