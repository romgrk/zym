# Lifecycle & disposal

How zym tears things down — load-bearing, not hygiene. A missed teardown
pins a whole subsystem (or a `TextEditor` per file ever opened) alive. Read
this before adding a component that owns a GObject, handler, timer, or child.

## Why "the GC will get it" is false here

- **GTK widgets are detached, not destroyed, on close.** Closing a tab /
  switching a diff mode / hiding a panel **unparents** the root; it does not
  emit `destroy`. So cleanup gated only on `widget.on('destroy', …)` never
  runs — teardown must come from an explicit `dispose()`.
- **node-gtk pins native objects.** It never frees GObjects from GI `.new()`
  / transfer-full returns (`romgrk/node-gtk#446`), and a handler on a
  long-lived GObject is held by a persistent handle whose closure captures
  `this` — pinning your whole graph. Signature: flat V8 heap + growing RSS,
  invisible to the JS profiler.

So **a subscription to a global/long-lived object is a strong ref that
outlives the widget tree, and must be cut by hand.**

## Primitives — `src/util/eventKit.ts`

`Disposable(action)` (idempotent), `CompositeDisposable` (a bag; adding after
dispose disposes immediately, so late subs can't leak), `Emitter` (returns
`Disposable`s). Track a component's subs in one `CompositeDisposable` and
dispose it as a unit.

`CompositeDisposable` is the **funnel for all teardown** an owner accumulates.
Its acquire-and-defer helpers pair each resource with its cleanup in one call, so
the leak-prone "attached a handler/controller and forgot to remove it" can't
arise — prefer them over raw GTK calls:

- `defer(fn)` — register a teardown closure.
- `connect(obj, sig, handler)` — `obj.on(sig, handler)` now, `obj.off(...)` on
  dispose (for any node-gtk GObject signal whose handler reaches back to a
  disposable owner). Replaces the old per-class `connect` helpers.
- `addController(widget, controller)` — `widget.addController(c)` now,
  `widget.removeController(c)` on dispose (rule 9). **Never** raw `addController`.
- `timer(fn, ms)` / `interval(fn, ms)` — auto-cleared (rule 7).
- `adopt(value, onDispose)` / `use(child)` — own a value / child disposable.

Two teardown verbs: `dispose()` runs + drops everything and **seals** the bag
(later adds dispose at once) — an owner's end of life; `clear()` runs + drops but
keeps the bag **reusable** — re-arm it each cycle for a recycled widget.
`nest()` gives such a recycled scope its own child bag the owner still tears down
at the end. Members dispose newest-first (LIFO).

## The rules

1. **`dispose()` is idempotent** — guard
   `if (this.disposed) return; this.disposed = true`.
2. **Disconnect *every* GObject signal handler in `dispose()`**, never gated on
   `destroy` alone — the `.on(...)` twin of rule 9 (node-gtk roots the closure even
   on the owner's own buffer/view, so leaving it connected pins the graph). Route
   signals through `disposables.connect(obj, sig, fn)` (or store the disconnect as a
   field, e.g. `detachStyleScheme`); for a `Gio.FileMonitor`, pair `connect` with a
   `defer(() => m.cancel())` — `.off()` releases node-gtk's handle, `cancel()` the OS watch.
3. **`widget.on('destroy', () => this.dispose())` is a safety net, not the
   path** — always also dispose explicitly from the owner.
4. **Own what you build** — dispose every child component/editor you
   construct.
5. **No GObject churn in poll/hot paths** — caching one long-lived object or
   shelling out beats `<Type>.new()` per tick (which grows the heap unbounded
   → growing GC hangs).
6. **Detach overlay children by hide+pool, never `unparent`**
   (`gtk_text_view_remove` is a no-op; forcing it → snapshot CRITICAL). See
   [text-editor/inline-widgets.md](text-editor/inline-widgets.md).
7. **Clear timers** in `dispose()` (`setTimeout`/`setInterval` ids).
8. **Prefer `WeakMap` for per-widget side tables** — a missed disposal
   degrades to dead data, not a pinned widget.
9. **Remove event controllers from recycled/removed widgets.** node-gtk roots a
   controller's signal-handler closures (persistent handles) while it is
   connected, so a controller left on a widget that is then removed from the
   list/tree and dropped pins that widget's whole subtree (row → box → labels)
   forever — even an empty handler, and even when the entire tree is dropped.
   Attach **every** controller through `disposables.addController(widget, c)` (or
   `connect` for a raw `.on` handler that captures the owner) and sever it by
   disposing the bag before the widget drops. For a widget that **churns**
   (rebuilt per keystroke / poll / re-diff), put its controllers in a
   `disposables.nest()` scope and `clear()` it each cycle (e.g. `GitPanel` rows,
   `HeaderBands` bands via `BlockDecorationSpec.dispose`). Either `removeController`
   *or* disconnecting the handler releases the rooted closure — both are proven in
   `src/util/eventKit.gtk.test.ts`. (`observeControllers().nItems` counts but can't
   enumerate them in this node-gtk build, so the bag remembers them.)

## Reference — `TextEditor.dispose()`

`src/ui/TextEditor/TextEditor.ts`, in order: guard `disposed`;
`detachStyleScheme()` (global `Adw.StyleManager`, rule 2); remove the `map`
handler; dismiss hover/signature popovers; `syntax.dispose()` (buffer/view
handlers + tree-sitter tree); detach from the shared `Document` (the registry
disposes it only when the **last** view releases it — disposal often needs
ref-counting, not blind teardown); dispose diagnostics + inlay renderers.

## Hunting a leak

Inspector on the live process (`kill -SIGUSR1 <pid>` or `--inspect`), drive
CDP: `HeapProfiler.takeHeapSnapshot`, count live objects **by constructor**
(climbing `TextEditor`/`GtkLabel`/`Ggit*` = the leak; two post-GC snapshots
seconds apart prove retention vs GC lag), then trace the shortest retainer
path — `(Global handles) → closure → … → your object` is a node-gtk-pinned
handler (rule 2). Native leak = `app.run()` frame dominates CPU with JS idle
+ flat heap + growing RSS.

## Incidents

- **StyleManager handler → a `TextEditor` per file** — disconnected only on
  `destroy`, which tab-close never fires. Fixed via `detachStyleScheme` in
  `dispose()` (rule 2).
- **Git poll → libgit2 GObject leak → growing hangs** — fixed by moving
  `src/git.ts` off `Ggit` to the `git` CLI (rule 5). See
  [git/index.md](git/index.md).
- **Overlay-child `unparent` crash** — fixed with the hide+pool slot pattern
  (rule 6).
- **List-row controller closures → multi-GB idle RSS** — every Picker/Combobox
  match row carried a select-on-hover `EventControllerMotion` whose
  `() => listBox.selectRow(row)` closure node-gtk rooted; removing a surplus row
  (per keystroke) without removing the controller pinned the row → box → labels
  subtree. The file picker churns the most, so ~77k detached `GtkLabel`s
  accumulated with nothing open. A live CDP bisection isolated it: a row removed
  with the controller survived GC, the same row with `removeController` was
  collected (true for both list-churn and whole-card drop). Resolved by **dropping
  select-on-hover** (selection is keyboard/click-only now), so those rows carry no
  controller at all. `GitPanel`'s rows keep a real double-click `GestureClick` and
  rebuild on every poll, so they use `trackController`/`detachControllers`
  (rule 9). Same class, still open: `NotificationToasts` (toast card click) and
  other recycled widgets with controllers.
- **Project-search results view → whole editor graph leaked per query** —
  `SearchResultsView.installNavigation` attached `enter` / double-click
  `EventController`s to its source view with raw `addController`, and `dispose()`
  never removed them. Each handler closure captures `this`, so node-gtk's
  rooted-closure pin (the toggle-ref never downgrades when a connected handler's
  closure references its own object — romgrk/node-gtk#455) kept the entire view
  alive: the editor, every `Document` acquired from the registry, their buffers,
  the ~24 highlight `GtkTextTag`s per buffer, and the excerpt-header rows.
  `ProjectSearchView` rebuilds the whole `SearchResultsView` on every search run,
  so the residue grew unbounded — RSS climbed ~0.4 GB → 3.3 GB while the V8 heap
  stayed flat; heap snapshots showed the survivors rooted at depth 1 by
  `(Global handles)`. Found via live CDP (post-GC snapshot diffs + the allocation
  sampling profiler, which named `new SearchResultsView` under the rg-result
  callback). Fixed by tracking the controllers (`trackController`) and severing
  them in `dispose()` (`detachControllers(this.editor.sourceView)`) — rule 9.
- **Virtual-text annotations churned native GObjects on every keystroke —
  resolved upstream (node-gtk#446 fixed).** A *different* class from the
  controller-pin leaks: `VirtualText.setAnnotations` rebuilds its set with
  `GtkSource.Annotation.new()` per item on every call, and its producers (inlay
  hints, git blame, error-lens diagnostics) re-push their full list on every edit /
  cursor move / fold / LSP re-fetch. node-gtk *used to* pin every transfer-full
  `.new()` return with a persistent handle and never free it, so the running editor
  leaked `GtkSourceAnnotation` at ~100/min while editing (live: +501 over 5 min,
  all rooted at `(Global handles)` depth 1; isolated repro: 1000/1000 `.new()`
  returns survived forced GC). **node-gtk#446 has since been fixed**: re-running the
  repro against the rebuilt binary collects 0/1000 (including the `addAnnotation →
  removeAll → drop` path), so the churn is no longer a permanent leak and the
  app-level diff-and-skip workaround was reverted. Rule 5 still stands as guidance
  (churning `.new()` in a hot path is needless native-alloc/GC pressure even when it
  no longer leaks) but the catastrophic permanent-pin consequence is gone. See
  `LEAK.md` Investigation #4.
- **The controller-pin leak was systemic — ~13 sites, one per component** — an
  audit of every `addController` call found that only the two already-patched
  components severed their controllers; the rest (`DiffView`, `CompletionController`,
  `HeaderBands`, `SearchBar`, `Terminal`, `FloatingCard`, `Combobox`, `Panel`,
  `QuestionCard`, `buildDefinitionPeek`, `NotificationToasts`, the per-agent focus
  controller) leaked their whole graph when their widget dropped. A live in-process
  bisection confirmed the rule (raw `addController` + `.on`, no sever → 300/300
  survive GC; handler `.off()` *or* `removeController` first → 0/300), and a real
  app path (`NotificationToasts` `replaceKey` reuse) leaked +80 `GtkGestureClick` at
  `(Global handles)` per 80 reuses. Resolved by funnelling **all** controllers/
  handlers through `CompositeDisposable`'s `addController`/`connect` (rule 9 +
  Primitives), adding a `dispose()` to the classes that lacked one and invoking it
  at each widget's drop point, using `nest()` for churned widgets (`GitPanel` rows,
  `HeaderBands` bands via the new `BlockDecorationSpec.dispose`), and retiring the
  per-class `connect` helper + the `widgetControllers.ts` `trackController`/
  `detachControllers` shim (folded into the bag). The full hunt + per-site table is
  in `LEAK.md` Investigation #3.
- **GtkTreeListModel child models freed under the tree → GC-timed segfault —
  resolved upstream (node-gtk 4.1.0, #482; dep now `^4.1.1`).** The `FileTree`
  create-func returns a fresh `sortedDirectory` model per directory row; that
  return is `(transfer full)` — the tree takes ownership — but node-gtk ≤ 4.0.1
  never added the ownership ref, so each child model's only ref was the toggle
  ref of a wrapper JS never kept. The first GC finalized the child models under
  the live tree, and the next tree teardown (a `rebuild()`-discarded tree
  collected later, or a row collapse) disconnected `items-changed` from the freed
  instances: paired `GLib-GObject-CRITICAL`s (`disconnect_matched` + `unref` on
  `'(null)'`) then SIGSEGV in `g_type_check_instance` — timed by GC, so it
  presented far from the cause (while opening the git commit box). Diagnosed from
  the coredump (`GObjectTeardownIdle → g_object_remove_toggle_ref →
  gtk_tree_list_model_clear_node_children → g_signal_handlers_disconnect_matched`)
  and reproduced standalone (autoexpanded `TreeListModel`, JS create-func, 2×GC →
  same criticals + SIGSEGV on 4.0.1, clean on 4.1.1). Lesson: a JS callback
  return handed to GTK is an ownership transfer like any other — if the wrapper
  is collectable but the native side must outlive it, suspect the transfer.
- **The same pin class via raw `.on()` *signal handlers* — the controller sweep's
  blind spot (~30 sites)** — #3 funnelled every `addController` but never the raw
  `obj.on('signal', …)` handlers on buffers/adjustments/`Gio.FileMonitor`s/buttons.
  Decisively, `EditorModel` (every editor) had **no `dispose()`** and four
  un-disconnected `this.buffer.on(...)` handlers, and `Document` (per file)
  `cancel()`'d its monitor without `.off()` — so the editor/Document graph #2/#3
  targeted was *still* pinned. Resolved by routing each through
  `disposables.connect` (rule 2), per-render `nest()`/`clear()` bags for churned
  content, a `dispose()` for the classes that lacked one (`EditorModel`/`Peek`/
  `Transcript`/`PluginManagerPanel`), and `connect` + `defer(cancel)` for the session /
  document file monitors. Found by static audit; regression in `eventKit.gtk.test.ts`.
  Per-site table in `LEAK.md` Investigation #5.
