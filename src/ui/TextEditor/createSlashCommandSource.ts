/*
 * Slash-command completion source — for an embedded agent prompt input. When the
 * current line is a slash command (starts with `/`), it offers the agent's
 * available slash commands (from the session's `init` event); accepting one
 * completes `/comp` → `/compact`. Sending the completed line as the prompt runs
 * the command (verified: claude-code interprets `/…` user messages as commands).
 *
 * Modeled on createBufferWordsSource: a factory over a `getCommands` accessor, so
 * it stays decoupled from the conversation and tracks the live command list. The
 * `/` is already typed, so candidates insert just the command name (the typed
 * word after the slash, which the controller filters/replaces).
 */
import type { CompletionContext, CompletionItem, CompletionSource } from './CompletionSource.ts';

export function createSlashCommandSource(getCommands: () => string[]): CompletionSource {
  return {
    name: 'slash',
    // Rank above buffer-words/LSP — on a slash line, commands are what's wanted.
    priority: 100,
    // Typing `/` opens the popup immediately (with no word prefix yet). Without
    // this, the `auto` path's min-prefix gate hides it until a letter is typed,
    // and `/` is not a word char so the prefix stays empty — the popup never opens.
    triggerCharacters: ['/'],
    complete(context: CompletionContext): CompletionItem[] {
      // Only in a slash-command line (the `/` at the start, optionally indented).
      if (!context.line.trimStart().startsWith('/')) return [];
      return getCommands().map((command): CompletionItem => ({
        label: `/${command}`, // shown with the slash in the popup
        insertText: command, // the `/` is already in the buffer; insert the rest
        filterText: command, // matched against the typed word (after the slash)
        kind: 'keyword',
        detail: 'slash command',
      }));
    },
  };
}
