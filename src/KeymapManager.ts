/*
 * KeymapManager — maps keystroke sequences to commands, scoped by selector.
 *
 * Ported from xedel's keymap-manager.js. A CAPTURE-phase key controller on the
 * application window receives every key press; keystrokes are normalized to
 * `Key`s and matched (supporting multi-key sequences like "ctrl-k ctrl-s")
 * against the keymaps registered for the focused widget and its ancestors. A
 * full match is dispatched through `quilx.commands`; a partial match queues the
 * keystrokes and swallows the event until the sequence completes or breaks.
 *
 * Adaptation for quilx: references the `quilx` global (window + commands)
 * instead of xedel's `xedel` global; otherwise behavior is preserved.
 */
import { Disposable } from './util/eventKit.ts';
import { Key } from './keymap/Key.ts';
import { unreachable } from './util/assert.ts';
import { parseSelector, matchesRule, elementMatchKeys, type Rule } from './util/selectors.ts';
import { getActiveElements } from './util/getActiveElements.ts';
import { GLib, Gtk } from './gi.ts';
import { quilx } from './quilx.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

const EVENT_CONTINUE         = false;
const EVENT_STOP_PROPAGATION = true;

// A binding value of `unset!` cancels keymap handling for its keystroke (the key
// falls through to the focused widget). Used to release a binding in contexts
// that need the raw key — e.g. `space` in a text entry, terminal, or insert mode.
const UNSET = 'unset!';

// How long an incomplete chord prefix is held before it's abandoned. While a
// prefix is queued every key is swallowed (so e.g. `ctrl-d` never reaches a
// terminal as long as `ctrl-d ctrl-d` might still complete); after this idle gap
// with no further key the pending state is resolved as a dead-end — any shorter
// full match runs, otherwise the keys fall through to the focused widget. Long
// enough not to fight a deliberate two-key chord, short enough that a single
// `ctrl-d` reaches the child without a noticeable lag.
const PARTIAL_MATCH_TIMEOUT_MS = 500;

const MATCH = {
  PARTIAL: 'PARTIAL',
  FULL:    'FULL',
} as const;

/** A keymap value: a command name, a command name with arguments, or an inline
 *  function. The `{ command, args }` form is how a binding passes arguments. */
export type CommandRef = { command: string; args?: unknown[] };
type Effect = string | CommandRef | ((this: Widget, event: unknown, element: Widget) => void);
type Keymap = Record<string, Effect>;
export type KeymapBySelector = Record<string, Keymap>;

type Listener = (key: Key, element: Widget | undefined, elements: Widget[]) => boolean;

/** A continuation available after the currently-queued prefix (for which-key). */
export interface PendingBinding {
  /** The remaining keystroke(s) after the queued prefix, e.g. `w` or `g l`. */
  keys: string;
  /** The command the continuation runs (empty for a function effect). */
  command: string;
}

/** A keystroke bound to more than one command for the same selector + priority. */
export interface KeymapConflict {
  selectorKey: string;
  keystroke: string;
  priority: number;
  commands: string[];
}

type PendingListener = (pending: PendingBinding[] | null) => void;

// A handler given the keystrokes of a chord prefix that timed out without
// completing, so a widget can deliver them to its child as if the keymap had
// never intercepted them (e.g. a terminal sends a lone `ctrl-d` as EOF). The
// first handler to claim the keys (return true) wins.
type FallthroughHandler = (keys: Key[]) => boolean;

/** The command name an effect targets (undefined for an inline function effect). */
function effectCommand(effect: Effect): string | undefined {
  if (typeof effect === 'string') return effect;
  if (typeof effect === 'object') return effect.command;
  return undefined;
}

interface KeymapEntry {
  rule: Rule;
  keymap: Keymap;
  priority: number;
  /** The `add()` source id this entry came from (e.g. `default-keymap`,
   *  `user-keymap`, `vim-mode-plus`) — surfaced by the keymap reference panel. */
  source: string;
  /** The original selector string this rule was parsed from (for display). */
  selector: string;
}

/** A registered keybinding, flattened for an introspection UI. */
export interface BindingInfo {
  selector: string;
  keystroke: string;
  command: string;
  source: string;
  priority: number;
}

interface KeybindingMatch {
  match: typeof MATCH.PARTIAL | typeof MATCH.FULL;
  keybinding: string;
  effect: Effect;
  element: Widget;
  priority: number;
}

export class KeymapManager {
  static MATCH = MATCH;

  listeners: Listener[] = [];

  queuedKeystrokes: Key[] = [];

  // When a queued prefix already has a complete binding but a longer sequence
  // could still match (e.g. `y` is Yank, but `y s` is Surround), we hold the
  // prefix's full match here and wait. If the next key extends the sequence we
  // use the longer match; if it breaks the chain we fall back to this. See
  // `processKeystroke`.
  deferredFullMatches: KeybindingMatch[] | null = null;

  // A GLib timeout id while a chord prefix is queued (null otherwise); fires
  // PARTIAL_MATCH_TIMEOUT_MS after the last key to abandon an unfinished chord.
  private partialMatchTimer: number | null = null;

  // Fall-through handlers (terminal EOF, etc.) for timed-out chord prefixes.
  private fallthroughHandlers: FallthroughHandler[] = [];

  // Macro recording (vim `q`): while non-null, every real non-modifier keystroke
  // is appended here (before dispatch) so `@{reg}` can replay it. `replaying`
  // keeps the synthetic keys fed during replay out of an in-progress recording.
  macroKeys: Key[] | null = null;
  private replaying = false;

  keymapsByName: Record<string, KeymapEntry[]> = {};
  keymapsBySource: Record<string, KeymapBySelector> = {};

  // which-key subscribers: notified with the pending continuations whenever a
  // prefix is queued, and with `null` when the queue clears.
  private pendingListeners: PendingListener[] = [];

  // Subscribers notified when the set of registered bindings changes (add /
  // remove / user-keymap reload), so the reference panel can refresh.
  private bindingsListeners: Array<() => void> = [];

  controller?: InstanceType<typeof Gtk.EventControllerKey>;

  initialize(): void {
    this.controller = new Gtk.EventControllerKey();
    this.controller.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    this.controller.on('key-pressed', this.onWindowKeyPressEvent);
    quilx.window!.addController(this.controller);
  }

  addListener(listener: Listener): Disposable {
    this.listeners.push(listener);
    return new Disposable(() => this.removeListener(listener));
  }

  // --- Macros (vim q / @) ----------------------------------------------------

  isRecordingMacro(): boolean {
    return this.macroKeys !== null;
  }

  startMacroRecord(): void {
    this.macroKeys = [];
  }

  /** Stop recording and return the keys, dropping the trailing key (the `q` that
   *  triggered the stop, which was recorded just before this dispatch). */
  stopMacroRecord(): Key[] {
    const keys = this.macroKeys ?? [];
    this.macroKeys = null;
    if (keys.length) keys.pop();
    return keys;
  }

  /** Dispatch one synthetic key during macro replay: run input grabs (so `f`/`r`/
   *  register prompts inside a macro still consume their next key), then the
   *  normal keymap dispatch. Marked `replaying` so it never re-records. */
  feedKey(key: Key): void {
    const wasReplaying = this.replaying;
    this.replaying = true;
    try {
      const elements = getActiveElements();
      for (const listener of this.listeners) {
        if (listener(key, elements[0], elements) === EVENT_STOP_PROPAGATION) return;
      }
      if (key.isModifier()) return;
      this.processKeystroke(key);
    } finally {
      this.replaying = wasReplaying;
    }
  }

  // --- Introspection (which-key, palette shortcuts, conflicts) ---------------

  /** Subscribe to pending-prefix changes (for a which-key hint UI). */
  onPendingChanged(listener: PendingListener): Disposable {
    this.pendingListeners.push(listener);
    return new Disposable(() => {
      this.pendingListeners = this.pendingListeners.filter((l) => l !== listener);
    });
  }

  /** Subscribe to binding-set changes (for the keymap reference panel). */
  onBindingsChanged(listener: () => void): Disposable {
    this.bindingsListeners.push(listener);
    return new Disposable(() => {
      this.bindingsListeners = this.bindingsListeners.filter((l) => l !== listener);
    });
  }

  private emitBindingsChanged(): void {
    for (const listener of this.bindingsListeners) listener();
  }

  /**
   * Every registered keybinding (one row per selector × keystroke), with the
   * source it came from and its priority — for a keymap reference panel. Not
   * focus-filtered: it's the whole registered set.
   */
  getAllBindings(): BindingInfo[] {
    const result: BindingInfo[] = [];
    const seen = new Set<string>();
    for (const entries of Object.values(this.keymapsByName)) {
      for (const entry of entries) {
        for (const [keystroke, effect] of Object.entries(entry.keymap)) {
          // A selector with multiple compound rules lands one entry per rule;
          // dedupe so a binding isn't listed twice.
          const id = `${entry.source} ${entry.selector} ${keystroke}`;
          if (seen.has(id)) continue;
          seen.add(id);
          result.push({
            selector: entry.selector,
            keystroke,
            command: effectCommand(effect) ?? '',
            source: entry.source,
            priority: entry.priority,
          });
        }
      }
    }
    return result;
  }

  /**
   * The keystroke sequences bound to `command` along the focus chain `elements`,
   * highest-priority first (so `[0]` is the primary shortcut). Used by the
   * command palette to show shortcuts.
   */
  keystrokesForCommand(command: string, elements: Widget[]): string[] {
    const found: Array<{ keystroke: string; priority: number }> = [];
    const seen = new Set<string>();
    for (const element of elements) {
      for (const entry of this.entriesFor(element)) {
        for (const [keystroke, effect] of Object.entries(entry.keymap)) {
          if (effectCommand(effect) === command && !seen.has(keystroke)) {
            seen.add(keystroke);
            found.push({ keystroke, priority: entry.priority });
          }
        }
      }
    }
    found.sort((a, b) => b.priority - a.priority);
    return found.map((f) => f.keystroke);
  }

  /**
   * Continuations available after `queue` along `elements`: every binding whose
   * keystroke extends the queued prefix, with the remaining keys and its command.
   */
  getPendingBindings(elements: Widget[], queue: Key[]): PendingBinding[] {
    const result: PendingBinding[] = [];
    const seen = new Set<string>();
    for (const element of elements) {
      for (const entry of this.entriesFor(element)) {
        for (const [keystroke, effect] of Object.entries(entry.keymap)) {
          const stack = keystroke.split(/\s+/);
          if (stack.length <= queue.length) continue;
          let extendsPrefix = true;
          for (let i = 0; i < queue.length; i++) {
            const k = Key.fromDescription(stack[i]);
            if (!k || !queue[i].equals(k)) { extendsPrefix = false; break; }
          }
          if (!extendsPrefix) continue;
          const keys = stack.slice(queue.length).join(' ');
          if (seen.has(keys)) continue;
          seen.add(keys);
          const command = effectCommand(effect);
          if (command === undefined || command === UNSET) continue;
          result.push({ keys, command });
        }
      }
    }
    result.sort((a, b) => a.keys.localeCompare(b.keys));
    return result;
  }

  /**
   * Keystrokes bound to more than one command at the same selector + priority —
   * an ambiguous binding the user probably didn't intend. Reported at load.
   */
  findConflicts(): KeymapConflict[] {
    const conflicts: KeymapConflict[] = [];
    for (const [selectorKey, entries] of Object.entries(this.keymapsByName)) {
      const byKey = new Map<string, Set<string>>();
      for (const entry of entries) {
        for (const [keystroke, effect] of Object.entries(entry.keymap)) {
          const command = effectCommand(effect);
          if (command === undefined) continue;
          const k = `${keystroke} ${entry.priority}`;
          (byKey.get(k) ?? byKey.set(k, new Set()).get(k)!).add(command);
        }
      }
      for (const [k, commands] of byKey) {
        if (commands.size <= 1) continue;
        const [keystroke, priority] = k.split(' ');
        conflicts.push({ selectorKey, keystroke, priority: Number(priority), commands: [...commands] });
      }
    }
    return conflicts;
  }

  // The keymap entries that apply to `element` (indexed under any of its keys and
  // confirmed by the full selector rule).
  private entriesFor(element: Widget): KeymapEntry[] {
    return elementMatchKeys(element)
      .flatMap((key) => this.keymapsByName[key] || [])
      .filter((entry) => matchesRule(element, entry.rule));
  }

  // Set the queued prefix and notify which-key subscribers.
  private setQueue(keystrokes: Key[]): void {
    // Reset the idle timer on every queue change: arm a fresh one while a prefix
    // is pending, drop it once the queue clears. This is the single choke point
    // for the queue, so the timer can never outlive its prefix.
    this.clearPartialMatchTimer();
    // Ordinary typing dead-ends every key with `setQueue([])` (see
    // `processKeystroke`). Skip notifying when the queue was already empty and
    // stays empty — there's no prefix change to react to, and a pending listener
    // (e.g. the keymap reference panel) would otherwise do real work on *every*
    // keystroke, blocking the main loop and stalling the UI during key repeat.
    const wasEmpty = this.queuedKeystrokes.length === 0;
    this.queuedKeystrokes = keystrokes;
    if (keystrokes.length > 0) this.schedulePartialMatchTimeout();
    if (this.pendingListeners.length === 0) return;
    if (wasEmpty && keystrokes.length === 0) return;
    const pending =
      keystrokes.length > 0 ? this.getPendingBindings(getActiveElements(), keystrokes) : null;
    for (const listener of this.pendingListeners) listener(pending);
  }

  // --- Partial-match timeout (abandon an unfinished chord) -------------------

  /** Register a fall-through handler for chord prefixes that time out. The first
   *  to claim the keys (return true) wins. Returns an unsubscribe Disposable. */
  onFallthrough(handler: FallthroughHandler): Disposable {
    this.fallthroughHandlers.push(handler);
    return new Disposable(() => {
      this.fallthroughHandlers = this.fallthroughHandlers.filter((h) => h !== handler);
    });
  }

  private schedulePartialMatchTimeout(): void {
    this.partialMatchTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, PARTIAL_MATCH_TIMEOUT_MS, () => {
      this.partialMatchTimer = null; // the source self-removes on the `false` return
      this.onPartialMatchTimeout();
      return false; // one-shot
    });
  }

  private clearPartialMatchTimer(): void {
    if (this.partialMatchTimer === null) return;
    GLib.sourceRemove(this.partialMatchTimer);
    this.partialMatchTimer = null;
  }

  // The queued chord went idle. Resolve it exactly as a dead-end keystroke would,
  // minus the new key: run a shorter prefix's deferred full match if there is
  // one, otherwise let the queued keys fall through to the focused widget (so a
  // lone `ctrl-d` reaches the terminal child as EOF).
  private onPartialMatchTimeout(): void {
    const queued = this.queuedKeystrokes;
    if (queued.length === 0) return;
    const deferred = this.deferredFullMatches;
    this.deferredFullMatches = null;
    this.setQueue([]);
    if (deferred) {
      this.dispatchFullMatches(deferred, getActiveElements());
      return;
    }
    for (const handler of this.fallthroughHandlers) {
      if (handler(queued)) return;
    }
  }

  removeListener(listener: Listener): void {
    this.listeners = this.listeners.filter(l => l !== listener);
  }

  // add: (source, keyBindingsBySelector, priority=0). Higher-priority bindings
  // win when multiple full matches resolve the same keystroke (e.g. a user
  // keymap layered over the defaults).
  add(source: string, keymapBySelector: KeymapBySelector, priority = 0): Disposable {
    Object.keys(keymapBySelector).forEach(selector => {

      const keymap = keymapBySelector[selector];
      const rules = parseSelector(selector);

      rules.forEach(rule => {
        const key = rule.key;
        if (this.keymapsByName[key] === undefined)
          this.keymapsByName[key] = [];
        this.keymapsByName[key].push({ rule, keymap, priority, source, selector });
      });
    });

    this.keymapsBySource[source] = keymapBySelector;
    this.emitBindingsChanged();

    return new Disposable(() => {
      this.removeBindingsFromSource(source);
    });
  }

  removeBindingsFromSource(source: string): void {
    const keymapBySelector = this.keymapsBySource[source];

    if (!keymapBySelector)
      return;

    Object.keys(keymapBySelector).forEach(selector => {
      const keymap = keymapBySelector[selector];
      const rules = parseSelector(selector);

      rules.forEach(rule => {
        const key = rule.key;
        if (this.keymapsByName[key] === undefined)
          return;
        this.keymapsByName[key] =
          this.keymapsByName[key].filter(k => k.keymap !== keymap);
      });
    });

    delete this.keymapsBySource[source];
    this.emitBindingsChanged();
  }

  onWindowKeyPressEvent = (keyval: number, keycode: number, state: number): boolean => {
    const key = Key.fromArgs(keyval, keycode, state);

    // Record into the active macro before dispatch — captures keys later consumed
    // by an input grab (the char after `f`, a register letter) too. Modifier-only
    // presses are skipped, matching how dispatch treats them.
    if (this.macroKeys && !this.replaying && !key.isModifier()) this.macroKeys.push(key);

    const elements = getActiveElements();

    for (const listener of this.listeners) {
      if (listener(key, elements[0], elements) === EVENT_STOP_PROPAGATION)
        return EVENT_STOP_PROPAGATION;
    }

    if (key.isModifier())
      return EVENT_CONTINUE;

    return this.processKeystroke(key);
  };

  // Match `key` (appended to any queued prefix) against the focused widget chain
  // and act on the result. Re-entrant: when a sequence dead-ends after a
  // deferred full match, the deferred command is dispatched and `key` is
  // re-processed from a clean slate (which is why elements are re-read here —
  // dispatching may have changed the mode/scope).
  private processKeystroke(key: Key): boolean {
    const elements = getActiveElements();
    const keystrokes = this.queuedKeystrokes.concat(key);
    const matches = this.collectMatches(keystrokes, elements);

    // `unset!` directive: if an unset binding is among the highest-priority
    // matches for this keystroke, cancel handling and let the key reach the
    // focused widget (e.g. type a literal space in an entry / terminal / insert
    // mode). Checked across full AND partial matches, so an unset on the `space`
    // prefix also releases the `space …` leader sequences.
    if (matches.length > 0) {
      const maxPriority = Math.max(...matches.map(m => m.priority));
      if (matches.some(m => m.priority === maxPriority && m.effect === UNSET)) {
        this.setQueue([]);
        this.deferredFullMatches = null;
        return EVENT_CONTINUE;
      }
    }
    // Drop unset markers so they are never treated as commands below.
    const active = matches.filter(m => m.effect !== UNSET);

    // Highest priority first; ties keep registration/chain order (stable sort).
    const fullMatches = active
      .filter(m => m.match === MATCH.FULL)
      .sort((a, b) => b.priority - a.priority);
    const partialMatches = active.filter(m => m.match === MATCH.PARTIAL);

    // A longer sequence may still complete — wait for the next key. Remember
    // this sequence's own complete binding (if any) as the fallback for when the
    // chain breaks, so e.g. `y` (Yank) survives even though `y s` (Surround) is
    // a longer candidate. A prefix that only extends (no full match of its own)
    // keeps the previously-remembered fallback.
    if (partialMatches.length > 0) {
      if (fullMatches.length > 0) this.deferredFullMatches = fullMatches;
      this.setQueue(keystrokes);
      return EVENT_STOP_PROPAGATION;
    }

    // The sequence is complete — dispatch its full match.
    if (fullMatches.length > 0) {
      this.setQueue([]);
      this.deferredFullMatches = null;
      return this.dispatchFullMatches(fullMatches, elements)
        ? EVENT_STOP_PROPAGATION
        : EVENT_CONTINUE;
    }

    // Dead-end: nothing matches the full sequence. If a shorter prefix had a
    // complete binding, run it now (e.g. `y` then a non-`s` key ⇒ Yank), then
    // re-process the current key from scratch so it can start a new sequence.
    const deferred = this.deferredFullMatches;
    this.deferredFullMatches = null;
    this.setQueue([]);
    if (deferred) {
      this.dispatchFullMatches(deferred, elements);
      return this.processKeystroke(key);
    }
    return EVENT_CONTINUE;
  }

  // Collect every full/partial keybinding match for `keystrokes` across the
  // focused widget and its ancestors.
  private collectMatches(keystrokes: Key[], elements: Widget[]): KeybindingMatch[] {
    const matches: KeybindingMatch[] = [];

    for (const element of elements) {
      const keymaps = elementMatchKeys(element)
        .flatMap((key) => this.keymapsByName[key] || []);

      if (keymaps.length === 0)
        continue;

      const matchingKeymaps = keymaps.filter(k => matchesRule(element, k.rule));
      const matchingKeybindings =
        matchingKeymaps.map(k => matchKeybinding(keystrokes, k.keymap, element, k.priority)).flat();

      if (matchingKeybindings.length === 0)
        continue;

      matches.push(...matchingKeybindings);
    }

    return matches;
  }

  // Dispatch the first full match (highest priority) that resolves to a command,
  // returning whether one did. String / `{ command, args }` effects are command
  // names resolved along the focus chain so a binding matched on one widget can
  // invoke a command hosted on an ancestor (e.g. the file tree's `space w` →
  // `file:save` on the window); a function effect runs on the matched element.
  private dispatchFullMatches(fullMatches: KeybindingMatch[], elements: Widget[]): boolean {
    for (const fullMatch of fullMatches) {
      const { keybinding, effect, element } = fullMatch;

      let didDispatch: boolean;
      if (typeof effect === 'function') {
        didDispatch = quilx.commands.dispatch(element, effect);
      } else if (typeof effect === 'string') {
        didDispatch = quilx.commands.dispatchAlongChain(elements, effect);
      } else {
        didDispatch = quilx.commands.dispatchAlongChain(elements, effect.command, ...(effect.args ?? []));
      }
      if (!didDispatch)
        continue;

      const label = typeof effect === 'object' ? effect.command : effect;
      console.log(`${element.getName()}: [${keybinding}]: ${label}`);
      return true;
    }
    return false;
  }
}

function matchKeybinding(queuedKeystrokes: Key[], keymap: Keymap, element: Widget, priority: number): KeybindingMatch[] {
  const keybindingKeys = Object.keys(keymap);
  const results: KeybindingMatch[] = [];

  outer: for (const keybinding of keybindingKeys) {
    const keyStack = keybinding.split(/\s+/).map(d => Key.fromDescription(d));

    if (keyStack.length < queuedKeystrokes.length)
      continue;

    for (let i = 0; i < queuedKeystrokes.length; i++) {
      const key = queuedKeystrokes[i];

      if (!keyStack[i] || !key.equals(keyStack[i]!))
        continue outer;
    }

    if (queuedKeystrokes.length < keyStack.length) {
      results.push({
        match: MATCH.PARTIAL,
        keybinding,
        effect: keymap[keybinding],
        element,
        priority,
      });
    }
    else if (keyStack.length === queuedKeystrokes.length) {
      results.push({
        match: MATCH.FULL,
        keybinding,
        effect: keymap[keybinding],
        element,
        priority,
      });
    }
    else {
      unreachable();
    }
  }

  return results;
}
