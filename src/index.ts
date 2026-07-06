#!/usr/bin/env node
/*
 * zym — a modal source-code editor built with GtkSourceView 5, GTK 4 and
 * Adwaita, on node-gtk.
 *
 * Features:
 *   - Vim-style modal editing (GtkSource.VimIMContext) with a status line
 *   - Syntax highlighting with language auto-detection
 *   - Adwaita light/dark style schemes that follow the system preference,
 *     plus a toolbar toggle to force dark mode
 *   - Open / Save / Save-As via the native Gtk.FileDialog
 *   - A source-map (minimap) gutter on the right
 *   - Keyboard shortcuts: Ctrl+O open, Ctrl+S save, Ctrl+Shift+S save-as,
 *     Ctrl+Q quit
 *
 * Run with:  pnpm start [file]
 *   (directly: node --import ./bin/register-gtk.mjs src/index.ts [file] — the
 *    flag installs node-gtk's `gi:` import hooks before the static graph resolves,
 *    and neutralizes node-gtk's GSK_RENDERER default; see docs/install.md)
 *
 * Structure:
 *   application.ts    Adw.Application + main-loop lifecycle
 *   editor-window.ts  the editor window UI and file operations
 *   index.ts          this entry point
 *
 * GObject namespaces are imported directly via the `gi:` scheme
 * (`import Gtk from 'gi:Gtk-4.0'`); node-gtk's own API (e.g. `getGType`) imports
 * from the `node-gtk` package by name.
 */
import * as Path from 'node:path';
import { Application } from './application.ts';
import { preloadGrammars } from './syntax/grammar.ts';
import { plugins, registerBuiltinPlugins, loadUserPlugins, disabledPluginIds } from './plugin/index.ts';
import { installGitBlame } from './ui/TextEditor/GitBlameController.ts';

// node-gtk drains Node's microtask queue inside the GLib main loop, so a stray
// rejected promise would otherwise terminate the whole editor. The known offender
// is vscode-jsonrpc: writing to a language server whose stdio was destroyed (it
// crashed or failed to spawn) re-throws the write failure inside an async Promise
// executor — an unhandled rejection the caller can't catch. Such transport errors
// are benign (the server is simply gone), so swallow them; log anything else so
// real bugs stay visible, but never let a stray rejection crash the app.
process.on('unhandledRejection', (reason) => {
  if ((reason as { code?: string } | null)?.code === 'ERR_STREAM_DESTROYED') return;
  console.error('Unhandled promise rejection:', reason);
});

// With no file argument, open no file (an empty window, unless a session is
const arg = process.argv[2];
const initialFile = arg ? Path.resolve(arg) : undefined;

// Activate the bundled plugins before anything reads the language registry: a
// plugin's `activate` is what contributes its languages, grammars and LSP
// servers (the TypeScript plugin populates the whole TS/JS family). Done before
// `preloadGrammars` so the grammars to preload are already registered.
registerBuiltinPlugins();
await loadUserPlugins();
const disabled = disabledPluginIds();
await plugins.activateAll(disabled);

// Current-line git blame is a built-in that plugs into the editor-observer seam (like the
// decoration plugins) rather than being wired into TextEditor — install it once here.
installGitBlame();

// Load tree-sitter grammars before the GLib main loop starts — emscripten's
// sync wasm init doesn't resolve once the loop is running.
await preloadGrammars();

new Application(initialFile).run();
