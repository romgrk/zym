# Plan: eliminate `as any` from the vim layer

After the bulk `as any` cleanup (commit removing 317 redundant casts), ~75 casts
remain in `src/ui/TextEditor/vim/*`. They are not redundant — each marks a spot
where a shim (`EditorModel`, `Selection`, `Cursor`, `VimState`, the operation
hierarchy) diverges from the Atom `vim-mode-plus` API the ported code expects.
This plan removes them by **building the missing functionality**, not by widening
types to `any`.

See `docs/tooling.md` → "Type casts (`as any`)" and
`docs/text-editor/vim-mode.md` for background on the shim.

## Guiding principle

Most divergences are *missing-but-trivial*: the primitive already exists on the
shim, the method just wasn't surfaced. Only **folding** needs real new runtime
plumbing. So the plan front-loads pure-typing and additive-method work (provably
behavior-preserving) and quarantines the one behavior-bearing subsystem.

Each phase ends green: `pnpm run typecheck` + `pnpm run test` (988 tests at time
of writing). The two behavior-bearing items — `Selection.insertText` auto-indent
and folding — additionally need manual vim verification in the running app.

---

## Phase 1 — Util-forwarder typing (`base.ts:342–354`) · effort S · ~11 casts

Pure types, no logic. The 11 `// prettier-ignore` thunks spread `...args: any[]`
into already-typed `utils.*` functions. Replace each with the real signature,
importing `ScanOptions`, `ScanDirection`, `ScanMatchResult`, `WordOptions` from
`utils.ts`.

```ts
// before
scanEditor (...args: any[]) { return (this.utils.scanEditor as any)(this.editor, ...args) }
// after
scanEditor (direction: ScanDirection, regex: RegExp, options: ScanOptions, fn: (e: ScanMatchResult) => void) {
  return this.utils.scanEditor(this.editor, direction, regex, options, fn)
}
```

Signatures already exist: `utils.ts` `getWordBufferRangeAndKindAtBufferPosition`
(604), `scanEditor` (981), `findInEditor` (1025), `findPoint` (1046),
`trimBufferRange` (261), `isEmptyRow` (174), `getFoldStartRowForRow` (1129),
`getFoldEndRowForRow` (1134), `getRows` (201), `replaceTextInRangeViaDiff` (1269).
Mechanical; do first as a warm-up.

## Phase 2 — Additive shim methods & typed fields · effort S–M · ~30 casts

All purely additive (new methods/fields; nothing changes for existing callers).

**`EditorModel` coordinate/misc methods** — screen ≈ buffer today (no soft-wrap),
so identity + clamp; the file already documents this at `EditorModel.ts:389`:
- `getVisibleRowRange()` → `[getFirstVisibleScreenRow(), getLastVisibleScreenRow()]`
- `bufferRangeForScreenRange()` / `screenRangeForBufferRange()` → apply the
  existing point converters to range ends
- `clipScreenPosition()` → clamp via `lineLength()`
- `splitSelectionsIntoLines()` → `getSelections()` + `addSelectionForBufferRange()` per line
- `setIndentationForBufferRow(row, level)` → mirror `autoIndentBufferRow` (916)
  using `buildIndentString` (1417)

**`Cursor`** (`Cursor.ts`): `setScreenPosition()` → forward to `setBufferPosition`;
`getScreenColumn()` → `getBufferColumn()` (one-liners; swap to the real conversion
if soft-wrap ever lands).

**`Selection`** (`Selection.ts`): add `compare(other)` (delegates to
`Point.compare`), `selectRight()`, `selectByProperties({head, tail})` (delegates
to `setBufferRange`), and a typed `initialScreenRange?: Range` field (replaces the
dynamic stash at `vim-state.ts:396/407`).

**Typed state fields** — replace dynamic property bags:
- `VimState`: `recordingMacroRegister: string | null`, `lastMacroRegister: string
  | null`, and a `getList('jumpList' | 'changeList')` helper for the `[this.list]`
  access (`misc-command.ts:613`).
- `VimMode` union += `'operator-pending'` (verify `activate()` handles it —
  `vim-state.ts` only branches normal/insert/visual today, so add the case).
- `RegisterManager`: `lastBlockwiseText: string | null` field.
- `HoverManager.set(value, point?)` signature; `MANAGER_REGISTRY` typed as
  `Record<string, new (vs: VimState) => Manager>` (moves the one cast to registration).

## Phase 3 — `Selection.insertText` options (behavior-bearing) · effort M · ~10 casts

`Selection.ts:221` is currently `insertText(text)`. Add `options?: { autoIndent?:
boolean; autoIndentNewline?: boolean }` and honor it via the existing
`autoIndentBufferRow` / `suggestedIndentForBufferRow` / `buildIndentString`
primitives. Restores the single largest cast cluster (`operator-insert.ts`,
`operator-transform-string.ts`). **Needs vim manual testing** (`o`/`O`, `cc`,
surround) since auto-indent changes inserted text.

## Phase 4 — Operation-hierarchy typing · effort M · ~10 casts

The stack is `Base[]` but reaches subclass methods (`setTarget`/`setModifier`/
`execute` on `Operator`; `getRange`/`getPairInfo` on `TextObject`/`Pair`). Two moves:
1. Narrow with the predicates that **already exist** (`isOperator()`/`isMotion()`/
   `isTextObject()` on `Base`) before the subclass calls in `operation-stack.ts`
   (159/219/245/323).
2. Make `getInstance` generic so `motion.ts` (1264/1375/1396/1421) keep their
   subclass type — overload by class-name registry
   (`getInstance<K>(name: K): Registry[K]`), or a `<T extends Base>` factory. This
   is the keystone for the `getInstance(...).getPairInfo()` casts.

## Phase 5 — Folding (the one architectural piece) · effort M–L · ~6 casts

The only part touching real runtime plumbing. Today folding is
**SyntaxController-owned, region/cursor-based** (`toggleFoldAtCursor`,
`setFoldAtCursor`, `foldAll` at `syntax-controller.ts:1121–1189`); the
`FoldProvider` interface `EditorModel` consumes (`EditorModel.ts:59`) is
**read-only**. Steps:
1. `isFoldableAtBufferRow(row)` is free now — check `getFoldableRanges()` for a
   region with that header row (S).
2. Extend `FoldProvider` with row-based `foldRow` / `toggleFoldAtRow` / `foldRange`.
3. Implement them in `SyntaxController` by generalizing the existing cursor-based
   fold ops to take an explicit row/range instead of reading the cursor.
4. Wire `EditorModel.foldBufferRow` / `foldBufferRange` / `toggleFoldAtBufferRow`
   to delegate.

**Needs manual testing** (`zc`/`zo`/`zR`/`zM`, `zf`).

## Phase 6 — Long tail · effort S–M · ~6 casts

- `getURI()`: give `EditorModel` a `setDocument()` / `getURI()` returning
  `document.currentFile` (mirrors `setFoldProvider` / `setUndoTarget`). Wire in
  `TextEditor.ts`. (`register-manager.ts:187`)
- `bufferRangeForScopeAtPosition()`: needs `SyntaxController` to expose a
  tree-sitter scope-extent query — `EditorModel` only has
  `scopeDescriptorForBufferPosition`, no extent. (`text-object.ts`)
- `editorElement` / `utils.matchScopes` (`vim-state.ts:220`): Atom DOM-ism
  (`classList`); refactor `matchScopes` to take `EditorModel` + a scope query, or
  accept this one stays.
- Tiny: `text-object.ts:276` pair-finder options (TODO to type `pair-finder.ts`),
  `clipboard.ts` `GObject.TYPE_STRING`, `utils.ts:1296` `localeCompare` options
  (the cast hides a real arg-position bug worth fixing).

---

## Sequencing & payoff

| Phase | Casts | Effort | Behavior change? |
|---|---|---|---|
| 1 · util forwarders | ~11 | S | no (types only) |
| 2 · additive methods/fields | ~30 | S–M | no (additive) |
| 3 · insertText options | ~10 | M | **yes** → vim test |
| 4 · operation hierarchy | ~10 | M | no (types only) |
| 5 · folding | ~6 | M–L | **yes** → vim test |
| 6 · long tail | ~6 | S–M | mixed |

Phases 1, 2, 4 are type-only and independently shippable. Phases 1–2 alone clear
~40 casts at near-zero risk — the natural first PR. **Order: 1 → 2 → 4 → 3 → 5 →
6** (do the keystone `getInstance` generic in 4 before the behavior-bearing 3/5 so
the test churn is isolated). Rough total ~3–4 focused days; the long tail may
legitimately leave 2–3 casts (the DOM-ism, pair-finder options) until adjacent
subsystems get typed.
