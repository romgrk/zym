/*
 * LocationBar — a thin bar pinned to the top of a (main) TextEditor showing *where you are*:
 * the current file path (shortened relative to the workspace cwd, then `~`, then absolute)
 * and a structural tree-sitter breadcrumb of the cursor's enclosing scopes (e.g. `Foo › bar`),
 * each segment painted the same color the syntax highlighter gives that token. Display-only:
 * the TextEditor drives it via setFile/setBreadcrumb on cursor move, reparse, and file change.
 * A dumb view — it owns no GObject signal handlers, so it needs no dispose() (the editor
 * detaches it on tab close).
 */
import * as Os from 'node:os';
import * as Path from 'node:path';
import { Gtk, Pango } from '../../gi.ts';
import { ICON_FONT_FAMILY } from '../../fonts.ts';
import { NERDFONT } from '../nerdfont.ts';
import { addStyles } from '../../styles.ts';
import { escapeMarkup } from '../proseMarkup.ts';
import { resolveSyntaxColor } from '../../theme/theme.ts';
import { type Crumb } from '../../syntax/breadcrumb.ts';

addStyles(`
  .LocationBar {
    padding: 1px 8px;
    background-color: var(--view-bg-color);
    border-bottom: 1px solid var(--t-ui-border);
    font-family: var(--t-font-monospace-family);
  }
  .LocationBar .path { color: var(--t-ui-text-muted); }
  .LocationBar .crumbs { color: var(--t-ui-text-muted); }
`);

// The breadcrumb separator: a Nerd Font chevron, dimmed via the .crumbs color.
const SEP = `<span font_family="${ICON_FONT_FAMILY}"> ${NERDFONT.NAV.CHEVRON_RIGHT} </span>`;

/** A file path for display: shortened to the first base that contains it — the workbench cwd
 *  (relative), then the home dir (`~/…`), else the absolute path. The workbench cwd (not
 *  `process.cwd()`) is the base so an editor in an agent worktree shortens against its own
 *  root, rather than showing the long `…/.claude/worktree/…` prefix. */
function displayPath(path: string, cwd: string): string {
  if (path === cwd) return Path.basename(path);
  if (path.startsWith(cwd + Path.sep)) return path.slice(cwd.length + 1);
  const home = Os.homedir();
  if (path === home) return '~';
  if (path.startsWith(home + Path.sep)) return '~' + path.slice(home.length);
  return path;
}

export class LocationBar {
  private readonly box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
  private readonly pathLabel = new Gtk.Label({ xalign: 0 });
  private readonly crumbsLabel = new Gtk.Label({ xalign: 0, hexpand: true });

  /** Resolves the workbench cwd to shorten paths against; read on each `setFile` so a
   *  worktree re-root (which reassigns the workbench cwd) is reflected without re-wiring. */
  private readonly cwd: () => string;

  constructor(cwd: () => string) {
    this.cwd = cwd;
    this.box.addCssClass('LocationBar');
    this.pathLabel.addCssClass('path');
    this.pathLabel.setEllipsize(Pango.EllipsizeMode.MIDDLE);
    this.crumbsLabel.addCssClass('crumbs');
    this.crumbsLabel.setEllipsize(Pango.EllipsizeMode.END);
    this.box.append(this.pathLabel);
    this.box.append(this.crumbsLabel);
  }

  get widget(): InstanceType<typeof Gtk.Widget> {
    return this.box;
  }

  /** Show the (shortened) file path, uniformly muted; hide the bar when fileless. */
  setFile(path: string | null): void {
    if (!path) {
      this.box.setVisible(false);
      return;
    }
    this.box.setVisible(true);
    this.pathLabel.setText(displayPath(path, this.cwd()));
  }

  /** Render the enclosing structural scopes, outermost first, chevron-separated and each in
   *  the color the syntax highlighter paints that token kind. A leading chevron joins them to
   *  the file path; empty when there are no scopes. */
  setBreadcrumb(crumbs: Crumb[]): void {
    const parts = crumbs.map((c) => {
      const name = escapeMarkup(c.name);
      const color = resolveSyntaxColor(c.capture);
      return color ? `<span foreground="${color}">${name}</span>` : name;
    });
    this.crumbsLabel.setMarkup(parts.length ? SEP + parts.join(SEP) : '');
  }
}
