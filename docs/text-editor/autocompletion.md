# Autocompletion

A source-pluggable autocompletion framework: a coordinator drives a popup
from one or more **sources** (buffer words, LSP, …). Buffer-words and LSP
sources are both built and wired in.

## Architecture

All files under `src/ui/TextEditor/`.

- **`CompletionSource.ts`** — the contract.
  - `CompletionItem`: `label`, `insertText`, `filterText`, `kind` (drives
    the icon), `detail` (right-aligned signature), `description` (dimmed
    module/import path), `documentation` (doc pane), `sortText`,
    `replaceRange` (exact buffer range to overwrite, from an LSP
    `textEdit`), `additionalEdits` (extra buffer edits on accept, e.g. an
    auto-import line), `source` (stamped by the controller), `resolve()`
    (lazily fetch `documentation`/`additionalEdits` — many servers send
    them only via `completionItem/resolve`).
  - `CompletionContext`: `prefix`, `cursor`, `replaceRange`, `line`,
    `trigger` (`auto`/`manual`/`character`), `triggerCharacter`.
  - `CompletionSource`: `name`, optional `priority` (default 0;
    higher-priority sources rank entirely above lower ones), optional
    `triggerCharacters`, and `complete(ctx)` → items, **sync or async**.
    Thrown errors/rejections are swallowed (one bad source won't break the
    rest).
  - `RankedCompletion`: an item plus the matched-character `positions` the
    popup highlights.

- **`CompletionController.ts`** — the coordinator. Triggers in **insert
  mode** only: word typing re-queries on the editor's `onDidChangeText`
  (debounced 60ms, `MIN_PREFIX = 1`); a source trigger character before the
  cursor (e.g. `.`) opens even with no prefix; Ctrl+Space forces it. Queries
  all sources and ranks with the picker's fzy scorer (`fuzzyMatch`,
  `maxTypos: 1` — a subsequence, and a single typo, still matches): source
  `priority` dominates, then fuzzy score, then `sortText`/label as
  tie-break; capped to `MAX_ITEMS` (50). **Sync sources present
  immediately**; only when a source returns a promise does it take the
  awaited path (awaiting even a resolved promise is sluggish under
  node-gtk's GLib loop; a `requestSeq` drops stale async responses).
  Prefix/column handling is codepoint-aware.

  A **capture-phase** key controller drives the popup (so it consumes keys
  only while open; vim sees them otherwise):
  - **Tab / Shift-Tab / Down / Up / Ctrl+N / Ctrl+P cycle a live
    preview**: the selected candidate is written straight into the buffer
    (popup stays open), and the cycle loops through `-1` (nothing selected
    → original typed text) back around. Tab still indents when the popup is
    closed.
  - **Enter / KP-Enter commits** — the preview is already in the buffer, so
    commit just closes the popup, then applies the item's `additionalEdits`
    (resolving them first if needed). With nothing selected, Enter falls
    through (normal newline) and closes the popup.
  - **Ctrl+E dismisses. Esc is left to vim** (it exits insert mode); the
    host dismisses on any leave-insert via `onDidActivateMode`.

  The preview machinery reconstructs each candidate against a fixed **base
  region** of the original document (`baseRange`/`baseText`), so an item's
  own `replaceRange` (LSP `textEdit`, possibly spanning the trigger `.`) is
  honored and `-1` restores the original text cleanly. Edits are guarded by
  `suppressQuery` so the resulting buffer-change event doesn't re-open the
  popup. Selecting an item lazily calls its `resolve()` to fill the doc pane
  / auto-import edits.

- **`CompletionPopup.ts`** — a keyboard-driven dropdown anchored below the
  **start of the word** being completed, via the shared `EditorPopover` (a
  chrome-less `Gtk.Popover` — the `#CompletionPopup` panel is the visual card;
  the popover positions it and slides it on-screen). Built `persistent` so it
  re-opens if GTK pops it down on a cycle's preview edit. Non-focusable
  (`setCanTarget(false)`) so the editor keeps focus and typing flows.
  Painted with the theme background; selected row uses the theme's selected
  color; rows have no min-height (a single match is one row tall). Each row:
  a fixed-width muted **kind icon** (Nerd Font codicon via
  `completionKindGlyph`), the label with fuzzy-matched chars highlighted in
  the picker's accent (`highlightMarkup`), the `detail` packed after it, and
  the `description` pinned far right. A horizontally-split **documentation
  pane** (right side, rendered from `CompletionItem.documentation` as
  markdown via `markdownToPango`, with fenced blocks tree-sitter highlighted
  like the LSP hover) opens when a selected item has docs and is **sticky**
  thereafter (to avoid flicker while cycling). The list scrolls
  (`MAX_HEIGHT_PX`) and scrolls-the-selection-into-view since the popup
  can't take focus. The popup shifts left near the editor's right edge to
  keep the doc pane on-screen. Uses `--popover-radius-small`.

- **`createBufferWordsSource.ts`** — the simplest source (name `buffer`,
  default priority). A factory over a `getText` accessor (decoupled from the
  widget, unit-tested) that tokenizes the buffer for identifier-like words
  (Unicode-aware, min length 2), dedupes, drops the partial word under the
  cursor, and emits a frequency hint via `sortText` so more-frequent words
  rank first within a prefix group. Sync.

- **`createLspCompletionSource.ts`** — the LSP source (name `lsp`,
  `priority: 100`, so language results outrank buffer words). A factory over
  the `LspManager` (narrowed to the four methods it uses) and a
  `getDocument` accessor (null for a fileless buffer → no candidates).
  Async. `triggerCharacters` is a dynamic getter (the server isn't known
  until it's up). Maps `textDocument/completion` items to `CompletionItem`
  (`toCompletionItem`): kind via `KIND_NAMES`, `labelDetails` preferred for
  `detail`/`description`, `textEdit.newText` as the preferred insert,
  `textEdit` range → `replaceRange` (codepoint coords; `InsertReplaceEdit`
  uses the `insert` range), `additionalTextEdits` → `additionalEdits`. We
  advertise no snippet support, so a snippet item falls back to inserting
  its plain label. Docs and auto-import edits that the list response omits
  are fetched lazily via `resolve` → `completionItem/resolve`.

- **Wiring** — `TextEditor` builds the controller in its overlay
  (`buildEditorArea`) and registers both sources: `createBufferWordsSource`
  over the buffer text, and `createLspCompletionSource(zym.lsp, …)` over
  the file's `lspDocument`. It passes a tree-sitter `highlightCode` callback
  for doc-pane code fences and dismisses on leave-insert. The LSP source
  no-ops for a fileless buffer or until a server is up.

## Next

- **Copilot** — inline/ghost suggestions (a different UX than the dropdown;
  likely a separate ghost-text path rather than list items).
- Buffer words could widen to **open buffers** and rank by proximity.
- **Widget polish** — flip the popup above the line when near the editor's
  bottom edge; mouse click-to-select + hover (the popup is currently
  non-targetable).
- **Behavior** — accept-on-trigger-char, snippet (`$1`-placeholder)
  insertion, per-source debounce/cancellation, and a config to tune
  eagerness (`MIN_PREFIX`, debounce, auto vs manual).
