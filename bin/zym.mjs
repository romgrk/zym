#!/usr/bin/env node
/*
 * zym — global launcher.
 *
 * `pnpm i -g` installs this file as the `zym` command (see package.json "bin").
 * Booting the editor needs node-gtk's `gi:` import hooks installed *before* the
 * entry module's static `import … from 'gi:…'` resolve. `pnpm start` does that
 * with `node --import ./bin/register-gtk.mjs src/index.ts`; here we replicate it
 * in-process: dynamically import `./register-gtk.mjs` first (it installs the
 * hooks and neutralizes node-gtk's GSK_RENDERER default), then dynamically import
 * the entry, so the entry's `gi:` imports resolve with the hooks active. A
 * *static* import of the register module in this same file would be hoisted above
 * that ordering — see node-gtk/register's own note — hence both are dynamic imports.
 *
 * Subcommands are handled before any GTK is touched:
 *   zym --install-desktop   write the desktop launcher (scripts/install-desktop.ts)
 *   zym --help | -h
 *   zym --version | -v
 * Anything else is treated as the optional file argument (read by src/index.ts).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const root = new URL('../', import.meta.url);

async function readVersion() {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  return pkg.version;
}

const cmd = process.argv[2];

if (cmd === '--help' || cmd === '-h') {
  process.stdout.write(
    'zym — a modal source-code editor (GTK 4 / GtkSourceView 5)\n\n' +
    'Usage:\n' +
    '  zym [file]             open the editor, optionally on a file\n' +
    '  zym --install-desktop  install the launcher into ~/.local/share/applications\n' +
    '  zym --version, -v      print the version\n' +
    '  zym --help, -h         show this help\n',
  );
} else if (cmd === '--version' || cmd === '-v') {
  process.stdout.write(`${await readVersion()}\n`);
} else if (cmd === '--install-desktop') {
  // The script is `.ts` under node_modules once installed, so strip types first.
  await import('./ts-strip-hook.mjs');
  const { installDesktopEntry } = await import(new URL('scripts/install-desktop.ts', root).href);
  const { path, icon } = await installDesktopEntry({ launcherPath: here });
  process.stdout.write(`Installed desktop entry: ${path}\nInstalled icon: ${icon}\n`);
} else {
  // Boot the editor. Order is load-bearing: strip-types hook + gi: hooks first,
  // then the entry (whose static `gi:` and `.ts` imports resolve under both).
  // register-gtk.mjs installs the gi: hooks and neutralizes node-gtk's
  // GSK_RENDERER=gl default so zym uses GTK's own renderer choice (see it).
  await import('./ts-strip-hook.mjs');
  await import('./register-gtk.mjs');
  await import(new URL('src/index.ts', root).href);
}
