/*
 * eventKit.ts — zym's event/lifecycle primitives.
 *
 * A small, self-contained equivalent of the `event-kit` package: a `Disposable`
 * (an undoable action), a `CompositeDisposable` (a bag of them disposed
 * together), and an `Emitter` (named-event pub/sub returning Disposables). The
 * command/keymap managers and the vim layer all lean on these for subscription
 * cleanup, so they carry the same shape ported code expects.
 *
 * `CompositeDisposable` is the funnel for ALL teardown an owner accumulates. Its
 * acquire-and-defer helpers (`connect`, `addController`, `timer`, `adopt`) pair
 * each resource with its cleanup in a single call, so the leak-prone "I attached
 * a handler/controller and forgot to remove it" never arises (node-gtk roots a
 * connected handler's closure behind a Global handle — see
 * docs/lifecycle-and-disposal.md). Two teardown verbs:
 *   - `dispose()` runs + drops everything and SEALS the bag (later adds dispose
 *     immediately) — for an owner's end of life.
 *   - `clear()` runs + drops everything but leaves the bag REUSABLE — re-arm it
 *     each cycle for a recycled widget. `nest()` gives such a recycled scope its
 *     own child bag the owner still tears down at the end.
 * Members are disposed newest-first (LIFO), mirroring construction order.
 */

/** Anything that can be torn down once. */
export interface DisposableLike {
  dispose(): void;
}

/** A node-gtk GObject (or any emitter) exposing `.on`/`.off` signal binding. */
interface SignalSource {
  on(signal: string, handler: (...args: any[]) => unknown): unknown;
  off(signal: string, handler: (...args: any[]) => unknown): unknown;
}

/** A GTK widget (structurally) that can carry event controllers. */
interface ControllerHost<C> {
  addController(controller: C): void;
  removeController(controller: C): void;
}

export class Disposable implements DisposableLike {
  private disposed = false;
  private readonly action: () => void;

  constructor(action: () => void) {
    this.action = action;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.action();
  }
}

/**
 * A collection of disposables disposed as a unit. Adding to an already-disposed
 * composite disposes the newcomer immediately, so late subscriptions can't leak.
 */
export class CompositeDisposable implements DisposableLike {
  private disposed = false;
  private readonly disposables = new Set<DisposableLike>();

  constructor(...disposables: DisposableLike[]) {
    for (const disposable of disposables) this.add(disposable);
  }

  add(...disposables: DisposableLike[]): void {
    for (const disposable of disposables) {
      if (this.disposed) disposable.dispose();
      else this.disposables.add(disposable);
    }
  }

  /** Register a teardown function (sugar for `add(new Disposable(fn))`). */
  defer(fn: () => void): void {
    this.add(new Disposable(fn));
  }

  /** Own a child disposable, returning it for chaining. */
  use<T extends DisposableLike>(child: T): T {
    this.add(child);
    return child;
  }

  /** Acquire a value paired with its teardown; returns the value. */
  adopt<T>(value: T, onDispose: (value: T) => void): T {
    this.defer(() => onDispose(value));
    return value;
  }

  /** Connect a node-gtk GObject (or any `.on`/`.off` emitter) signal and register
   *  its disconnect, so `dispose()` releases the Global handle node-gtk would
   *  otherwise use to pin the handler closure (and everything it captures). Use
   *  for EVERY signal whose handler reaches back to a disposable owner. */
  connect<O extends SignalSource>(obj: O, signal: string, handler: (...args: any[]) => unknown): void {
    obj.on(signal, handler);
    this.defer(() => obj.off(signal, handler));
  }

  /** Attach a GTK event controller and register its removal. node-gtk roots a
   *  connected controller's handler closures behind a Global handle; removing the
   *  controller before the widget is dropped releases them. Use for EVERY
   *  controller on a widget that may be removed/recycled at runtime (in a
   *  `nest()`ed scope when the widget churns per-cycle). */
  addController<C>(widget: ControllerHost<C>, controller: C): void {
    widget.addController(controller);
    this.defer(() => widget.removeController(controller));
  }

  /** `setTimeout` whose handle is cleared on dispose; returns the id. */
  timer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(fn, ms);
    this.defer(() => clearTimeout(id));
    return id;
  }

  /** `setInterval` whose handle is cleared on dispose; returns the id. */
  interval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
    const id = setInterval(fn, ms);
    this.defer(() => clearInterval(id));
    return id;
  }

  /** A child scope owned by this composite but independently re-armable: `clear()`
   *  it each cycle for a recycled widget; the parent disposes it at end of life. */
  nest(): CompositeDisposable {
    return this.use(new CompositeDisposable());
  }

  remove(disposable: DisposableLike): void {
    this.disposables.delete(disposable);
  }

  /** Dispose and drop every member (newest first), but keep the composite usable. */
  clear(): void {
    for (const disposable of [...this.disposables].reverse()) disposable.dispose();
    this.disposables.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
  }
}

type Handler = (value?: unknown) => void;

export class Emitter {
  private readonly handlers = new Map<string, Set<Handler>>();
  // Handlers registered via `preempt`, invoked before the regular handlers.
  private readonly preemptHandlers = new Map<string, Set<Handler>>();

  on(eventName: string, handler: Handler): Disposable {
    return this.register(this.handlers, eventName, handler);
  }

  /** Like `on`, but the handler runs before all `on` handlers for the event. */
  preempt(eventName: string, handler: Handler): Disposable {
    return this.register(this.preemptHandlers, eventName, handler);
  }

  emit(eventName: string, value?: unknown): void {
    const preempt = this.preemptHandlers.get(eventName);
    if (preempt) for (const handler of [...preempt]) handler(value);
    const set = this.handlers.get(eventName);
    if (set) for (const handler of [...set]) handler(value);
  }

  private register(map: Map<string, Set<Handler>>, eventName: string, handler: Handler): Disposable {
    let set = map.get(eventName);
    if (!set) {
      set = new Set();
      map.set(eventName, set);
    }
    set.add(handler);
    return new Disposable(() => set!.delete(handler));
  }
}
