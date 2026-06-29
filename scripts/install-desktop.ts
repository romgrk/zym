/*
 * Desktop integration — write a freedesktop `.desktop` launcher so zym appears
 * in the application menu and as a file "Open with" target.
 *
 * Run directly to install pointing at this checkout's launcher:
 *   pnpm run install-desktop        (node scripts/install-desktop.ts)
 * After a global install (`pnpm i -g`) use `zym --install-desktop` instead, which
 * imports `installDesktopEntry` from here and points at the installed launcher.
 * See docs/install.md.
 *
 * This module is loaded only by the install path, never during editor boot, so it
 * stays GTK-free and does not use the in-app process runner
 * (docs/process-runner.md): the runner exists to avoid forking the ~1.5 GB
 * node-gtk process, which is not loaded here, so a plain best-effort spawn of
 * `update-desktop-database` is appropriate.
 */
import { execFile } from 'node:child_process';
import * as Fs from 'node:fs/promises';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** GTK application id; keep in sync with APP_ID in src/application.ts. */
const APP_ID = 'com.github.romgrk.zym';

/** `$XDG_DATA_HOME/applications` (default `~/.local/share/applications`). */
function applicationsDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || Path.join(Os.homedir(), '.local', 'share');
  return Path.join(dataHome, 'applications');
}

/** Quote a token for the `Exec` key per the freedesktop Desktop Entry spec. */
function execQuote(token: string): string {
  if (!/[\s"'\\$`]/.test(token)) return token;
  return `"${token.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * Resolve a stable absolute path to the node binary. `process.execPath` under a
 * version manager such as fnm is an ephemeral per-shell symlink (e.g. under
 * `/run/user/.../fnm_multishells/`) that will not exist for a later GUI launch;
 * `realpath` follows it to the versioned install, which is stable.
 */
async function stableNodePath(): Promise<string> {
  try {
    return await Fs.realpath(process.execPath);
  } catch {
    return process.execPath;
  }
}

/** Build the `.desktop` file contents. `exec` is the fully-formed Exec command. */
export function buildDesktopEntry(opts: { exec: string; icon?: string }): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Zym',
    'GenericName=Text Editor',
    'Comment=A modal source-code editor built with GTK 4 and GtkSourceView 5',
    `Exec=${opts.exec} %f`,
    `Icon=${opts.icon ?? APP_ID}`,
    'Terminal=false',
    'Categories=Development;TextEditor;IDE;GTK;',
    'Keywords=editor;code;text;vim;source;',
    'MimeType=text/plain;',
    // GNOME maps the running window (applicationId == APP_ID) to this entry.
    `StartupWMClass=${APP_ID}`,
    'StartupNotify=true',
    '',
  ].join('\n');
}

/** Best-effort refresh of the MIME "Open with" cache; never throws. */
function refreshDesktopDatabase(dir: string): Promise<void> {
  return new Promise((resolve) => {
    execFile('update-desktop-database', [dir], () => resolve());
  });
}

/**
 * Write the desktop entry pointing at `launcherPath` (bin/zym.mjs). The Exec line
 * bakes an absolute node path and the launcher path rather than relying on `zym`
 * being on PATH, so GUI launches work even when node lives behind a version
 * manager that only patches PATH inside interactive shells.
 *
 * Returns the absolute path of the written file.
 */
export async function installDesktopEntry(opts: { launcherPath: string }): Promise<{ path: string }> {
  const node = await stableNodePath();
  const exec = `${execQuote(node)} ${execQuote(opts.launcherPath)}`;
  const contents = buildDesktopEntry({ exec });

  const dir = applicationsDir();
  const file = Path.join(dir, `${APP_ID}.desktop`);
  await Fs.mkdir(dir, { recursive: true });
  await Fs.writeFile(file, contents, 'utf8');
  await refreshDesktopDatabase(dir);

  return { path: file };
}

// Run directly (`pnpm run install-desktop`): install pointing at this checkout's
// launcher. When imported (by bin/zym.mjs) nothing runs here — the caller invokes
// installDesktopEntry() with its own resolved launcher path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const launcherPath = fileURLToPath(new URL('../bin/zym.mjs', import.meta.url));
  const { path } = await installDesktopEntry({ launcherPath });
  console.log(`Installed desktop entry: ${path}`);
}
