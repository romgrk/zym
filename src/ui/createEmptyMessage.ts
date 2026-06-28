/*
 * createEmptyMessage — a small factory wrapping `Adw.StatusPage` for "nothing here" placeholder
 * surfaces (e.g. a DiffView with no changes): a centered icon + title + optional description that
 * fills its container.
 *
 * NOTE: `Adw.StatusPage` takes a themed `icon-name` (a `*-symbolic` from the Adwaita / icon-dev-kit
 * set) — the one spot the UI uses an icon-name rather than a Nerd Font glyph (see docs/index.md),
 * because that is StatusPage's native API.
 */
import Adw from 'gi:Adw-1';

export interface EmptyMessageOptions {
  /** Symbolic icon name shown above the title (e.g. `check-plain-symbolic`). */
  icon: string;
  /** Headline (bold, centered). */
  title: string;
  /** Optional supporting line under the title. */
  description?: string;
}

/** An `Adw.StatusPage` configured as an empty/placeholder state, ready to drop into any container. */
export function createEmptyMessage(options: EmptyMessageOptions): InstanceType<typeof Adw.StatusPage> {
  const page = new Adw.StatusPage({ iconName: options.icon, title: options.title });
  if (options.description) page.setDescription(options.description);
  return page;
}
