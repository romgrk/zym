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
import { Gtk } from './gi.ts';
import { quilx } from './quilx.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

const EVENT_CONTINUE         = false;
const EVENT_STOP_PROPAGATION = true;

const MATCH = {
  PARTIAL: 'PARTIAL',
  FULL:    'FULL',
} as const;

type Effect = string | ((this: Widget, event: unknown, element: Widget) => void);
type Keymap = Record<string, Effect>;
type KeymapBySelector = Record<string, Keymap>;

type Listener = (key: Key, element: Widget | undefined, elements: Widget[]) => boolean;

interface KeymapEntry {
  rule: Rule;
  keymap: Keymap;
}

interface KeybindingMatch {
  match: typeof MATCH.PARTIAL | typeof MATCH.FULL;
  keybinding: string;
  effect: Effect;
  element: Widget;
}

export class KeymapManager {
  static MATCH = MATCH;

  listeners: Listener[] = [];

  queuedKeystrokes: Key[] = [];

  keymapsByName: Record<string, KeymapEntry[]> = {};
  keymapsBySource: Record<string, KeymapBySelector> = {};

  controller?: InstanceType<typeof Gtk.EventControllerKey>;

  initialize(): void {
    this.controller = new Gtk.EventControllerKey();
    this.controller.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    this.controller.on('key-pressed', this.onWindowKeyPressEvent);
    quilx.window!.addController(this.controller);
  }

  addListener(listener: Listener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: Listener): void {
    this.listeners = this.listeners.filter(l => l !== listener);
  }

  // add: (source, keyBindingsBySelector, priority=0, throwOnInvalidSelector=true)
  add(source: string, keymapBySelector: KeymapBySelector, _priority = 0, _throwOnInvalidSelector = true): Disposable {
    Object.keys(keymapBySelector).forEach(selector => {

      const keymap = keymapBySelector[selector];
      const rules = parseSelector(selector);

      rules.forEach(rule => {
        const key = rule.key;
        if (this.keymapsByName[key] === undefined)
          this.keymapsByName[key] = [];
        this.keymapsByName[key].push({ rule, keymap });
      });
    });

    this.keymapsBySource[source] = keymapBySelector;

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
  }

  onWindowKeyPressEvent = (keyval: number, keycode: number, state: number): boolean => {
    const key = Key.fromArgs(keyval, keycode, state);

    const elements = getActiveElements();

    for (const listener of this.listeners) {
      if (listener(key, elements[0], elements) === EVENT_STOP_PROPAGATION)
        return EVENT_STOP_PROPAGATION;
    }

    if (key.isModifier())
      return EVENT_CONTINUE;

    const keystrokes = this.queuedKeystrokes.concat(key);
    const matches: KeybindingMatch[] = [];

    for (const element of elements) {
      const keymaps = elementMatchKeys(element)
        .flatMap((key) => this.keymapsByName[key] || []);

      if (keymaps.length === 0)
        continue;

      const matchingKeymaps = keymaps.filter(k => matchesRule(element, k.rule));
      const matchingKeybindings =
        matchingKeymaps.map(k => matchKeybinding(keystrokes, k.keymap, element)).flat();

      if (matchingKeybindings.length === 0)
        continue;

      matches.push(...matchingKeybindings);
    }

    let didCapture = false;
    let shouldStopPropagation = true;

    const fullMatches = matches.filter(m => m.match === MATCH.FULL);

    if (fullMatches.length > 0) {
      for (const fullMatch of fullMatches) {
        const { keybinding, effect, element } = fullMatch;

        const didDispatch = quilx.commands.dispatch(element, effect);
        if (!didDispatch)
          continue;

        console.log(`${element.getName()}: [${keybinding}]: ${effect}`);

        this.queuedKeystrokes = [];
        didCapture = true;
        shouldStopPropagation = true;
        break;
      }
    }
    else if (matches.length > 0) {
      this.queuedKeystrokes = keystrokes;

      didCapture = true;
    }
    else {
      this.queuedKeystrokes = [];
    }

    return (
      didCapture && shouldStopPropagation ?
        EVENT_STOP_PROPAGATION :
        EVENT_CONTINUE
    );
  };
}

function matchKeybinding(queuedKeystrokes: Key[], keymap: Keymap, element: Widget): KeybindingMatch[] {
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
      });
    }
    else if (keyStack.length === queuedKeystrokes.length) {
      results.push({
        match: MATCH.FULL,
        keybinding,
        effect: keymap[keybinding],
        element,
      });
    }
    else {
      unreachable();
    }
  }

  return results;
}
