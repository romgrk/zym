# Memory leak investigation

Status: **ROOT CAUSE FOUND, FIXED, AND VALIDATED.** Durable write-up lives in
`docs/lifecycle-and-disposal.md` (rule 9 + incident). This file is the
investigation log.

## Symptom

The long-running editor grew to multiple GB of RSS and never gave it back, even
with nothing open. Flat JS heap (`heapUsed` ≈ 183 MB) + huge RSS (≈ 4.6 GB) +
77,576 detached `GtkLabel` wrappers surviving forced GC = a native node-gtk
pinning leak, not a JS-heap leak.

## Root cause (decisive)

Per-list-row **event controllers whose signal closures node-gtk roots**. Each
match row carried a hover controller:

```ts
const hover = new Gtk.EventControllerMotion();
hover.on('enter', () => listBox.selectRow(row));   // node-gtk roots this closure
row.addController(hover);
```

node-gtk keeps a persistent (global) handle on the closure for as long as the
controller stays connected. When a row is removed from the list (the file picker
pops surplus rows on **every keystroke**) without removing the controller, the
rooted closure pins the whole `row → box → labels` subtree forever. The file
picker churns the most rows, so its leaked rows dominate the 77k labels.

## How it was proven (live CDP, GLib loop running)

Built `Gtk.ListBox` rows in the live process, removed them, dropped all JS refs,
forced GC (`HeapProfiler.collectGarbage`), checked survivors via `WeakRef`:

| Variant | Survivors | Verdict |
|---|---|---|
| row removed, **no** controller | 0 / 300 | collected |
| row removed, hover controller (current code) | 300 / 300 | **leak** |
| row removed, then `removeController` | 0 / 300 | **fix works** |
| whole tree dropped, detach **only** rows (ancestor controller left) | 0 / 200 | fix works on close too |

Notes that corrected earlier theories:
- It is **not** CompletionPopup: its rows carry no controllers, so they collect
  fine (the decisive experiment showed 0 survivors). It churns widgets but does
  not leak them.
- The "800 controllers vs 77k labels" paradox: the closure captures `row`+
  `listBox`, not `hover`, so most `EventControllerMotion` *wrappers* get
  collected (native objects survive on the leaked rows) and undercount.
- The leak isn't observable under `node --test` (no GLib loop → node-gtk's
  toggle-ref collection never runs; even genuinely-free rows read as alive), so
  the regression test asserts controller removal directly, not collection.

## Fix

Two parts:

1. **Dropped select-on-hover.** The Picker (match + action rows) and Combobox
   rows only had controllers to implement "hover moves the selection". That
   affordance was removed — selection is keyboard- and click-driven (`row-
   activated`) — so those rows now carry **no controller at all** and can't leak.
2. **`src/util/widgetControllers.ts`** (`trackController` / `detachControllers`,
   WeakMap-tracked; `observeControllers()` can't be enumerated in this node-gtk
   build) for the controllers that legitimately remain on churned rows:
   `src/ui/GitPanel.ts` rebuilds rows carrying a double-click `GestureClick` on
   every git poll, and detaches them before removal.

Regression test: `src/ui/Picker.test.ts` — "match rows carry no event controllers
(select-on-hover removed, no leak)", using `observeControllers().nItems`.

## Same class, still open (follow-up)

`NotificationToasts` (toast card `GestureClick` pinned when the revealer is
removed; `fillCard` reuse stacks controllers on replaceable toasts), and any
other recycled/removed widget that carries a controller. The card *shell* of a
closed FloatingCard may also linger via its own focus controller — bounded (one
panel per close), not the row subtrees, which the fix collects.

---

# Investigation #2: project-search results view churns native GObjects

Status: **FIXED.** Distinct from investigation #1. Same leak *class* (a connected
controller's closure node-gtk roots), different site. Hunt performed live against
the running editor instance (PID `3500205`) via the Node inspector (`SIGUSR1` →
CDP on `127.0.0.1:9229`). Upstream node-gtk bug filed: **romgrk/node-gtk#455**.

## Summary

`ProjectSearchView.runSearch()` rebuilds the **entire** results view on every
search run (`swapResults(new SearchResultsView(...))`). The new `SearchResultsView`
attaches Enter / double-click `EventController`s to its editor's source view
(`installNavigation`) with raw `view.addController(...)`, and `dispose()` never
removes them. Each handler closure captures `this`, and node-gtk keeps a connected
handler's closure **strong-rooted** — so the disposed-but-not-detached view stays
pinned: its editor, every `Document` it acquired from the registry, those
documents' buffers, the ~24 highlight `GtkTextTag`s per buffer, and the
excerpt-header rows. One leaked graph per search ⇒ unbounded RSS growth.

> **Corrected from the first draft of this note:** the leak is *not* the
> `.new()`-never-freed bug (#446). A standalone repro (`/tmp/zym-leak/ngtk-repro*.cjs`)
> showed bare `new Gtk.TextTag()` / `new Gtk.ListBoxRow()` — even a row carrying a
> controller — collect cleanly after GC. The leak fires **only when the handler
> closure captures the object**; the tags/rows are collateral, pinned because their
> owning view is pinned. See node-gtk#455.

Observed: RSS climbed **412 MB → ~3300 MB** over a few minutes while the V8 heap
stayed small and flat — the classic node-gtk "flat JS heap, fat native RSS"
signature.

## Where

- `src/ui/ProjectSearchView.ts`
  - `runSearch()` → `swapResults(new SearchResultsView({ excerpts, … }))` (≈ line 257)
    builds a brand-new view on each run (re-query / toggle / re-open).
- `src/ui/SearchResultsView.ts`
  - constructor `new TextEditor({ … })` (line 121) → new editor per rebuild.
  - `installNavigation()` adds raw `view.addController(keys)` / `addController(click)`
    (lines 396 / 407) whose closures capture `this`.
  - `dispose()` (line 435) disposes the editor + releases sources but **never
    `removeController`s** the navigation controllers (rule 9 hazard).
- GObjects leaked per rebuild:
  - `new Gtk.TextTag()` highlight vocabulary, ~24 per editor —
    `src/syntax/highlightTags.ts:46`, `src/syntax/syntax-controller.ts:220`.
  - `new Gtk.ListBoxRow()` excerpt headers via BlockDecorations —
    `src/ui/LocationList.ts:130`.

## Proof chain

| Signal | Evidence |
|---|---|
| Native-pin shape | RSS **412 → 3300 MB** while V8 `heapUsed` stayed ~60–130 MB and `external` flat at 51 MB. |
| Steady growth (passive 90 s, app idle) | `GtkTextTag +155`, `GtkListBoxRow +200`, plus `CompositeDisposable +30`, `didDispatch +57`, and the string `"TextEditor: [alt-j]: vim-mode-plus:move-down"` 2 → 48 (vim editors created + freed, tags/command artifacts left behind). |
| Detached but pinned | Retainer paths: every sampled `GtkTextTag` / `GtkListBoxRow` is rooted at **depth 1 by `(Global handles)`** with no widget-tree path to the window. |
| Stable JS, growing native | `TextEditor` count steady at 24 while `GtkTextTag` went 590 → 1523 → tags **outlive their editors** (≈ 24 new tags ≈ one editor vocabulary every ~15 s). |
| Allocator (sampling profiler, caught a burst) | `new SearchResultsView` (`SearchResultsView.ts:97`) ← `ProjectSearchView.ts:245` ← `runProjectSearch` callback (`multibuffer/projectSearch.ts:116`) ← runner IPC stream. Children: `attachVim`, `DocumentSyntax.reparse` (tags), `LocationList.buildRow` / `BlockDecorations.add` (rows). |

The churn is **bursty** (a rebuild per search run, not a per-frame loop): RSS
jumps sharply when a search runs and drips slowly between runs.

## Root cause (decisive)

A connected controller whose closure captures its own object keeps the object
strong-rooted in node-gtk until the controller is removed (node-gtk#455, proven by
standalone repro: capturing closure → 500/500 survive GC; `removeController` first
→ 0/500). `SearchResultsView.installNavigation` leaves such controllers on the
source view, and `dispose()` never removes them — so each disposed view is pinned
via its captured `this`, dragging the whole editor + acquired-`Document` graph
(and their buffers / tags / rows) with it. `runProjectSearch` runs `rg` once per
run (`multibuffer/projectSearch.ts:105–127`); each re-query rebuilds and leaks one
more graph. Confirmed by counts across snapshots ~3 min apart: `TextEditor`
24→42, `Document` 15→64, `GtkSourceBuffer` 25→92, `GtkTextTag` 590→1526.

## Fix (done)

`src/ui/SearchResultsView.ts`:

1. `installNavigation()` now attaches the Enter / double-click controllers via
   `trackController(view, …)` instead of raw `view.addController(…)`.
2. `dispose()` calls `detachControllers(this.editor.sourceView)` **before**
   `this.editor.dispose()` (while the view still exists), severing the rooted
   closures so the view — and the editor / Documents / buffers / tags / rows it
   holds — becomes collectable.

This breaks the captured-`this` cycle (mirrors the repro's `removeController`
case → 0 survivors). `pnpm run typecheck` passes. Live verification needs an
editor restart (the running instance still has the old code).

Optional follow-up (not required for the fix): have `ProjectSearchView` reuse one
persistent `SearchResultsView` and update excerpts in place (rule 5 — avoid the
per-query editor churn entirely), and add a regression test asserting the source
view carries no tracked controllers after `dispose()` (cf. `Picker.test.ts`).

When fixed, add this to `docs/lifecycle-and-disposal.md` Incidents.

## Reproduction / tooling

Scratch tooling lives in `/tmp/zym-leak/` (ephemeral):

- `cdp.mjs` — minimal CDP driver (Node global `WebSocket`):
  - `WS=ws://… node cdp.mjs eval '<expr>'`
  - `WS=… node cdp.mjs snapshot <file>` (GC + `HeapProfiler.takeHeapSnapshot`)
  - `WS=… node cdp.mjs sample <seconds>` (allocation sampling profiler → top frames + stacks)
- `analyze.mjs <snap>` / `analyze.mjs <a> <b>` — aggregate a heapsnapshot by
  constructor, or diff two (biggest growers).
- `retain.mjs <snap> count|path <Ctor>` — count instances; trace retainer paths
  up to a GC root (reverse-BFS over the heap graph).

Recipe:

```sh
kill -SIGUSR1 <editor-pid>                 # opens inspector on 127.0.0.1:9229
WS=$(curl -s 127.0.0.1:9229/json/list | jq -r '.[0].webSocketDebuggerUrl')
WS=$WS node cdp.mjs snapshot a.heapsnapshot
WS=$WS node cdp.mjs eval '(async()=>{await new Promise(r=>setTimeout(r,90000))})()'
WS=$WS node cdp.mjs snapshot b.heapsnapshot
node analyze.mjs a.heapsnapshot b.heapsnapshot   # biggest growers
node retain.mjs b.heapsnapshot path GtkTextTag   # → "(Global handles)" depth 1
WS=$WS node cdp.mjs sample 60                     # names the allocating call stack
```

Notes:
- The inspector left open on PID `3500205` closes when the editor restarts.
- The running instance is at ~3.3 GB; a restart reclaims it.
