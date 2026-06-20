/*
 * Buffer-words completion source — the simplest real source: it offers the
 * identifier-like words already present in the current buffer, so re-typing a
 * name you've used before completes it (Vim's `i_CTRL-N` / an editor's
 * "complete word" behaviour). No language smarts; it just tokenizes the text.
 *
 * Built as a factory over a `getText` accessor rather than holding the editor,
 * so it stays decoupled from the widget (and is trivially unit-testable). The
 * `CompletionController` does the prefix filtering/ranking; this source only
 * supplies candidates and a frequency hint via `sortText` (more-frequent words
 * sort first among equal prefix matches).
 */
import type { CompletionContext, CompletionItem, CompletionSource } from './CompletionSource.ts';

// Identifier-like runs: a leading letter/underscore/$, then word chars. Unicode
// letters included so non-ASCII identifiers are picked up.
const WORD_RE = /[\p{L}_$][\p{L}\p{N}_$]*/gu;
const MIN_WORD_LENGTH = 2; // single chars aren't worth completing

export function createBufferWordsSource(getText: () => string): CompletionSource {
  return {
    name: 'buffer',
    complete(context: CompletionContext): CompletionItem[] {
      // A word-completion source: open on word typing (`auto`) or an explicit
      // request (`manual`), but not on a punctuation trigger it doesn't own (e.g.
      // `.` for LSP, `/` for slash commands) — otherwise every such char would pop
      // the full buffer-word list.
      if (context.trigger === 'character') return [];
      const counts = new Map<string, number>();
      const text = getText();
      WORD_RE.lastIndex = 0;
      for (let m = WORD_RE.exec(text); m !== null; m = WORD_RE.exec(text)) {
        const word = m[0];
        if (word.length < MIN_WORD_LENGTH) continue;
        counts.set(word, (counts.get(word) ?? 0) + 1);
      }
      // Don't offer the partial word currently under the cursor as its own match.
      counts.delete(context.prefix);

      const items: CompletionItem[] = [];
      for (const [word, count] of counts) {
        // Higher frequency → smaller sortText → ranked first within a prefix group.
        const freq = Math.max(0, 999999 - count).toString().padStart(6, '0');
        items.push({ label: word, kind: 'text', detail: 'buffer', sortText: `${freq}:${word}` });
      }
      return items;
    },
  };
}
