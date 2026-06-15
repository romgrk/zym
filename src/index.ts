#!/usr/bin/env node
/*
 * quilx — a modal source-code editor built with GtkSourceView 5, GTK 4 and
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
 * Run with:  pnpm start [file]   (or: node src/index.ts [file])
 *
 * Structure:
 *   gi.ts             node-gtk bootstrap + typed namespace exports
 *   application.ts    Adw.Application + main-loop lifecycle
 *   editor-window.ts  the editor window UI and file operations
 *   index.ts          this entry point
 */
import * as Path from 'node:path';
import { Application } from './application.ts';
import { preloadGrammars } from './syntax/grammar.ts';

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
// restored). An explicit file arg also suppresses session restore-on-launch
// (see SessionController).
const arg = process.argv[2];
const explicitFile = Boolean(arg);
const initialFile = arg ? Path.resolve(arg) : undefined;

// Load tree-sitter grammars before the GLib main loop starts — emscripten's
// sync wasm init doesn't resolve once the loop is running.
await preloadGrammars();

new Application(initialFile, explicitFile).run();
