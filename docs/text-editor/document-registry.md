# Document registry (shared buffers, multiple views)

A **Document** (the buffer + its document-level state) is split from the
**view** (`TextEditor`). A ref-counted registry keys open documents by path
and allows **N views per document** with **independent per-view cursors**.
This is what lets a see-definition peek and a split-view of the same file
share the live buffer — edits, the modified flag, and undo are shared, while
each view scrolls/navigates/folds on its own.

The shipped design is **A2: own the model, give each view its own native
`GtkSource.Buffer`** — canonical write-up in
[text-editor.md → "Document-model direction (A2)"](text-editor.md). This file
keeps the registry/Document rationale and a map of what shipped.

## Why it's needed (the crux)

To make a peek (or a second view) reflect edits + the modified dot, the two
views must share document state. A `TextEditor` that owned its own
`GtkSource.Buffer` (with "modified" = `buffer.getModified()` and one editor
per path) cannot do this.

The tempting native shortcut — two `GtkSource.View`s on **one**
`GtkSource.Buffer` — shares edits/modified/undo for free, **but renders all
buffer-level state (cursor, selection, current line, folds, tags) identically
in every view**. That dead-end forces a real model/view split rather than just
sharing the buffer.

## What shipped (A2)

Instead of sharing one buffer, each `Document` owns a **headless model buffer**
(never attached to a view) as the single source of truth for text + undo, and
hands each view its **own** `GtkSource.Buffer` kept in sync. Every view is then
natively independent — its own cursor, selection, current line, folds,
decorations — for free.

- **`Document`** (`src/ui/TextEditor/Document.ts`) owns: the headless model
  `GtkSource.Buffer` (`setEnableUndo(true)`); per-view buffers via `createView()`
  (`setEnableUndo(false)`); file I/O (load/save, plus `renameTo` to re-point at a
  new path — buffer/undo intact — after a move/rename on disk) + disk-watching; modified/dirty
  state; the **document-level LSP** (`lspDocument`) — one
  `didOpen`/`didChange`/`didClose` driven off the model's insert/delete signals,
  no per-view gating. Per-view **folding** also lives here (a fold collapses one
  view's text to a placeholder while marks track the model range it stands for —
  see the `Fold` machinery).
  - **Sync:** a native edit in a view buffer is forwarded to the model
    (`forward`); the model's change signal mirrors it to the *other* views
    (`propagate`), guarded by an `origin`/`suppress` pair so the mirror's own
    signal doesn't re-fire.
  - **Undo trick:** native buffer undo is per-buffer, so it would desync views.
    The model buffer holds the one undo stack; view buffers have native undo
    **off**. `u` → `model.undo()` → the model emits the inverse edit →
    propagates to every view.
  - **`DocumentHost`** routes the active (focused) view's reactions — cursor
    restore/focus on load, modal dialogs, toasts, disk-change banner, and the
    cursor anchor for LSP requests. A Document can have several hosts (one
    active).
- **`DocumentRegistry`** (`src/ui/TextEditor/DocumentRegistry.ts`) — app-wide
  path → `Document` table, **ref-counted**: `acquire(path)` gets-or-creates and
  bumps the ref; `release(doc)` disposes (cancels the disk monitor, `didClose`s
  the LSP doc) on the last view. Dedup keys on the document's live `currentFile`
  (falling back to the acquired path) so a "Save As" retarget keeps one entry.
  Held by `AppWindow` (`this.documents`); `openFile` calls `acquire`/`release`.
- **`TextEditor` is a view** onto a `Document`: it takes its buffer from
  `document.createView()`, delegates file I/O / modified / title / LSP, and
  registers a `DocumentHost`. The `GtkSource.View`, vim layer, decorations,
  gutters, and completion/hover UI stay view-local.
- **`EditorModel` rendering reads/writes the buffer's native insert mark**
  (`getCursorBufferPosition` → `buffer.getInsert()`, `setCursorBufferPosition`
  → `placeCursor`). That works *because each view has its own buffer*, so the
  native cursor is already per-view. A `setUndoTarget()` seam routes
  `undo`/`redo`/`transact` to the `Document` for document-backed views
  (buffer-only editors keep native buffer undo).

## What it unlocks (delivered)

- **Live see-definition peek**: when the definition's file is already open,
  `AppWindow.peekDefinition` opens a read-only 2nd view
  (`new TextEditor({ peek: true })`) on the shared `Document` — edits in the
  open tab show in the peek and vice versa; the modified dot is shared. Falls
  back to a read-only disk **snapshot slice** when the file isn't open.
  (Consumer: [inline-widgets.md](inline-widgets.md).)
- **Split view of the same file** — two panes, one document, independent
  cursors/folds, shared edits/undo.
- Per-view folding (impossible with a shared buffer's single `invisible` tag).

## Notes / known limits

- **Double parse**: each view runs its own `SyntaxController` (N parses for N
  views) — inherent to separate buffers; fine for typical 2–3 views.
- **Lifecycle**: the `Document` is ref-counted; its LSP doc/monitor are torn
  down only on the last view's release. Undo is model-level (shared); the
  modified dot reflects the shared document.
- Deferred A2 polish (undo grouping feel, IME under heavy multi-view load,
  linked split scroll) is tracked in
  [text-editor.md → "Deferred polish (A2)"](text-editor.md).

Related: [text-editor.md](text-editor.md) (widget decision + canonical A2
write-up), [inline-widgets.md](inline-widgets.md) (the peek consumer).
