# Memory-leak investigation log

Five hunts into the editor's unbounded RSS growth. All **fixed / resolved**; the
durable rules live in `docs/lifecycle-and-disposal.md` (rules 2 + 9, Incidents).
This file is the history.

**Two mechanisms, both node-gtk native pins** (signature: flat JS heap, fat RSS):

- **#455 — closure pin.** node-gtk keeps a Global handle on a *connected*
  signal/controller closure. If the closure captures its widget/owner and is never
  disconnected before the widget drops, the whole graph is pinned forever. Released
  by `.off()` (handler) or `removeController`. Covers #1, #2, #3, #5.
- **#446 — `.new()` pin.** Transfer-full `<Type>.new()` returns were never freed.
  Covers #4. **Fixed upstream.**

The leak is invisible under `node --test` (no GLib loop → toggle-ref collection
never runs), so regression tests assert *disconnection* directly
(`src/util/eventKit.gtk.test.ts`), not collection. Live proof used CDP heap
snapshots + `WeakRef` survival counts (tooling at the end).

---

## #1 — File-picker row controllers (#455) · FIXED

Each picker/combobox match row carried a select-on-hover `EventControllerMotion`
whose `() => listBox.selectRow(row)` closure node-gtk rooted. The file picker pops
surplus rows on every keystroke without removing the controller → `row → box →
labels` pinned. Idle editor reached ~4.6 GB RSS with 77k detached `GtkLabel`.

**Fix:** dropped select-on-hover entirely — selection is keyboard/click only, so
rows carry no controller. `GitPanel`'s real double-click controllers (rebuilt per
poll) track + detach instead. Proven live: row + controller → 300/300 survive GC;
`removeController` first → 0/300.

## #2 — Project-search results view (#455) · FIXED

`ProjectSearchView` rebuilds the whole `SearchResultsView` per search; its
Enter/double-click controllers on the source view weren't removed in `dispose()`,
pinning the editor + every acquired `Document` + buffers + ~24 tags/buffer per
query (RSS 0.4 → 3.3 GB). Filed node-gtk#455.

**Fix:** track the controllers, detach them in `dispose()` before the editor drops.

## #3 — The controller-pin class is systemic (#455) · FIXED

An audit of ~30 `addController` sites found only #2's two severed theirs; ~13
leaked when their widget dropped. **Discriminator (proven live):** a site is safe
iff the handler is `.off()`'d *or* the controller removed before the widget drops.

**Fix:** funnel every controller + handler through `CompositeDisposable`'s
acquire-and-defer helpers (`connect` / `addController` / `timer` / `nest`); add a
`dispose()` where missing and invoke it at each widget's drop point; `nest()` for
churned widgets; retired the old `widgetControllers.ts` shim. Regression:
`eventKit.gtk.test.ts`.

## #4 — `GtkSource.Annotation.new()` churn (#446) · RESOLVED UPSTREAM

Different class. `VirtualText.setAnnotations` rebuilds its set with
`GtkSource.Annotation.new()` per item on every edit / cursor move / diagnostics
push, and node-gtk *used to* pin every transfer-full `.new()` return (~100/min
while editing).

**Resolution:** node-gtk#446 fixed upstream — `.new()` returns now free once JS
drops them (re-proven: 0/1000 survive). The app-level workaround was reverted.
Rule 5 (no `.new()` churn in hot paths) still stands as perf guidance.

## #5 — The raw-`.on()` twin of #3 (#455) · FIXED

#3 swept `addController` but never the raw `obj.on('signal', …)` *handlers* on
buffers / adjustments / file monitors / buttons — ~30 sites (static audit, no live
instance this round). **Decisive:** `EditorModel` (every editor) had no `dispose()`
and four un-disconnected `this.buffer.on(...)` handlers, and `Document` (per file)
`cancel()`'d its monitor without `.off()` — so the editor/Document graph #2/#3
targeted was *still* leaking.

**Fix (mirrors #3):** route each `.on` through `disposables.connect`; `nest()` /
`clear()` bags for per-render / per-page churn; add `dispose()` where missing,
invoked at the drop point (`TextEditor.dispose`, `AgentConversation.dispose`,
AppWindow `tabCloseHandlers`); file monitors pair `connect` (the `.off()`) with
`defer(() => m.cancel())`. Sites by area:

- **Editor core:** `EditorModel`, `Document`, `Peek`.
- **Conversation:** `Transcript`, `AgentConversation`, `ToolRow`, `MarkdownView`,
  `ActionsBar`, `MonitorView`, `SubagentView`, `cards.ts`, `QuestionCard`.
- **Pickers:** `Picker.openPicker` (one helper → ~20 picker files).
- **Per-tab:** `GitLogView`, `ProjectSearchView`, `FileTree`, `Terminal`, `AgentTerminal`.
- **Sessions:** `SdkSession`, claude-tui `ClaudeSession`.
- **Panels:** `PluginManagerPanel`, `KeymapPanel`, `NotificationLog`, `WorkbenchList`, `ConfigEditor`.

Regression: `eventKit.gtk.test.ts`.

---

## Tooling (ephemeral, `/tmp/zym-leak/`)

```sh
kill -SIGUSR1 <editor-pid>                       # inspector on 127.0.0.1:9229
WS=$(curl -s 127.0.0.1:9229/json/list | jq -r '.[0].webSocketDebuggerUrl')
WS=$WS node cdp.mjs snapshot a.heapsnapshot      # GCs first; repeat minutes later → b
node analyze.mjs a.heapsnapshot b.heapsnapshot   # biggest growers by constructor
node retain.mjs b.heapsnapshot path GtkTextTag   # retainer path to a GC root
WS=$WS node cdp.mjs sample 60                     # allocation sampling → names the call stack
```

A growing count rooted at `(Global handles)` depth 1 with no widget-tree path = a
node-gtk pin. `cdp.mjs` / `analyze.mjs` / `retain.mjs` + the `probe-controllers.mjs`
A/B/C bisection live in `/tmp/zym-leak/`.
