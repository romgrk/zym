/*
 * CommandManager — registers named commands against widgets (by selector or by
 * instance) and dispatches them to the right widget along the focus chain.
 *
 * Ported from xedel's commands-manager.js. Adaptations for zym:
 *   - `getSource` is reduced to a monotonic counter: the original walked the
 *     stack to derive a "file:line" source id, but a `finally` block always
 *     overwrote it with the counter, so the stack walk was dead code;
 *   - `remove` now keeps bundles whose source DOESN'T match (the original kept
 *     the matching ones, which removed everything else — inverted).
 *
 * Commands are looked up by the widget's selector keys — its `constructor.name`
 * and its CSS classes (so a class-only selector like `.Panel` works) — and
 * dispatched as either a plain callback or a `{ didDispatch }` object, receiving
 * a `CommandEvent`.
 */
import { Emitter, Disposable } from './util/eventKit.ts';
import { parseSelector, matchesRule, elementMatchKeys, elementContext, type Rule } from './util/selectors.ts';
import { unreachable } from './util/assert.ts';
import { Gtk } from './gi.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

// Handlers receive the event, the element, then any dispatch arguments. Args are
// also available as `event.args` (handy for the `{ didDispatch }` form).
type CommandCallback = (this: Widget, event: CommandEvent, element: Widget, ...args: any[]) => void;
// A command is a plain callback, or an object carrying the callback plus optional
// metadata: `description` (a human label for the palette) and `when` (a predicate
// for whether the command is currently applicable — the palette dims commands
// whose `when` is false). `when` is a closure over live state, e.g.
// `when: () => this.activeEditor !== null`.
export type CommandEffect =
  | CommandCallback
  | { didDispatch: CommandCallback; description?: string; when?: () => boolean };
export type CommandMap = Record<string, CommandEffect>;

interface CommandBundle {
  source: string;
  rule: Rule | true;
  commands: CommandMap;
}

export class CommandManager {
  commandsByName: Record<string, CommandBundle[]> = {};
  commandsByElement = new WeakMap<Widget, CommandBundle[]>();
  sources: Record<string, Array<{ selector: string; commands: CommandMap }>> = {};
  // Human descriptions indexed by command name, harvested from the inline
  // `description` on each command as it is registered (see `add`). Descriptions
  // are declared together with the command (the `{ didDispatch, description }`
  // form) — the one idiomatic way; this index just lets name-only consumers (the
  // keymap reference, which-key) label a command without an element context,
  // including commands registered on element instances (which live in a non-
  // enumerable WeakMap and so can't be scanned on demand). Last registration wins.
  private descriptionsByName: Record<string, string> = {};
  emitter = new Emitter();

  /** The human description declared for a command name, if any. */
  descriptionFor(name: string): string | undefined {
    return this.descriptionsByName[name];
  }

  get(element: Widget, command: string): CommandEffect | undefined {
    const effect = this.resolve(element, command);
    if (effect === undefined) {
      // Identity is a CSS class now; fall back to the GTK type name for raw widgets.
      const classes = element.getCssClasses();
      const desc = classes.length ? `.${classes.join('.')}` : element.getName();
      console.warn(`Command '${command}' is not registered for ${desc}`);
    }
    return effect;
  }

  // Resolve a command for a single element without warning (so callers can probe
  // the focus chain quietly).
  private resolve(element: Widget, command: string): CommandEffect | undefined {
    for (const bundle of this.bundlesFor(element)) {
      if (bundle.rule !== true && !matchesRule(element, bundle.rule))
        continue;
      if (command in bundle.commands)
        return bundle.commands[command];
    }
    return undefined;
  }

  /**
   * Dispatch `command` to the first element of `elements` (a focus chain, most
   * specific first) that has it registered — so a keystroke matched on one
   * widget (e.g. the focused FileTree) can invoke a command hosted on an
   * ancestor (e.g. `file:save` on the window). Returns false if none handle it.
   */
  dispatchAlongChain(elements: Widget[], command: string, ...args: unknown[]): boolean {
    for (const element of elements) {
      if (this.resolve(element, command) !== undefined)
        return this.dispatch(element, command, ...args);
    }
    return false;
  }

  // All command bundles that could apply to `element`: those indexed under any
  // of its keys (type, CSS classes, wildcard) plus any registered on the element
  // instance directly. Callers still confirm each with `matchesRule`.
  private bundlesFor(element: Widget): CommandBundle[] {
    const keyed = elementMatchKeys(elementContext(element))
      .flatMap((key) => this.commandsByName[key] || []);
    return keyed.concat(this.commandsByElement.get(element) || []);
  }

  /**
   * Enumerate every command available along a focus chain (as returned by
   * `getActiveElements`), in resolution order: the first element to offer a
   * given name wins, mirroring `get`. Each entry carries the element to dispatch
   * the command back to, plus its `description` and whether it is currently
   * `enabled` (its `when` predicate, defaulting to true). Used by the palette.
   */
  getAvailableCommands(
    elements: Widget[],
  ): Array<{ name: string; element: Widget; description?: string; enabled: boolean }> {
    const seen = new Set<string>();
    const result: Array<{ name: string; element: Widget; description?: string; enabled: boolean }> = [];

    for (const element of elements) {
      const commandBundles = this.bundlesFor(element);

      for (const bundle of commandBundles) {
        if (bundle.rule !== true && !matchesRule(element, bundle.rule))
          continue;
        for (const name in bundle.commands) {
          if (seen.has(name))
            continue;
          seen.add(name);
          const effect = bundle.commands[name];
          const description =
            (typeof effect === 'object' ? effect.description : undefined) ?? this.descriptionsByName[name];
          // A throwing/odd `when` shouldn't break the palette — treat as enabled.
          let enabled = true;
          if (typeof effect === 'object' && effect.when) {
            try { enabled = effect.when(); } catch { enabled = true; }
          }
          result.push({ name, element, description, enabled });
        }
      }
    }

    return result;
  }

  add(element: string | Widget, commands: CommandMap): Disposable {
    const source = getSource();

    // Index any inline descriptions by name so name-only consumers (keymap
    // reference, which-key) can label the command without an element.
    for (const name in commands) {
      const effect = commands[name];
      if (typeof effect === 'object' && effect.description)
        this.descriptionsByName[name] = effect.description;
    }

    if (typeof element === 'string') {
      const selector = element;
      const rules = parseSelector(selector);

      rules.forEach(rule => {
        const key = rule.key;

        if (!this.commandsByName[key])
          this.commandsByName[key] = [];

        this.commandsByName[key].push({
          source,
          rule,
          commands,
        });
      });

      this.sources[source] =
        (this.sources[source] || []).concat({ selector, commands });

      return new Disposable(() => {
        this.remove(source);
      });
    }
    else if (element instanceof Gtk.Widget) {
      if (!this.commandsByElement.has(element))
        this.commandsByElement.set(element, []);

      this.commandsByElement.get(element)!.push({
        source,
        rule: true,
        commands,
      });

      return new Disposable(() => {
        this.remove(source, element);
      });
    }
    else {
      return unreachable();
    }
  }

  remove(source: string, element?: Widget): void {
    if (!element) {
      for (const name in this.commandsByName) {
        this.commandsByName[name] =
          this.commandsByName[name].filter(c => c.source !== source);
      }
      delete this.sources[source];
    }
    else {
      const bundles = this.commandsByElement.get(element) || [];
      this.commandsByElement.set(element,
        bundles.filter(k => k.source !== source)
      );
    }
  }

  dispatch(element: Widget, commandName: string | CommandCallback, ...args: unknown[]): boolean {
    const event = new CommandEvent(typeof commandName === 'string' ? commandName : '', args);
    let effect: CommandEffect | undefined;

    if (typeof commandName === 'string') {
      effect = this.get(element, commandName);
      if (!effect)
        return false;
    }
    else if (typeof commandName === 'function') {
      effect = commandName;
    }
    else {
      return unreachable();
    }

    if (typeof effect === 'function') {
      effect.call(element, event, element, ...args);
    }
    else if (typeof effect === 'object' && typeof effect.didDispatch === 'function') {
      effect.didDispatch.call(element, event, element, ...args);
    }
    else {
      return unreachable();
    }

    const didDispatch = event.aborted === false;
    if (didDispatch)
      this.emitter.emit('did-dispatch', event);
    return didDispatch;
  }

  onDidDispatch(fn: (event: CommandEvent) => void): Disposable {
    return this.emitter.on('did-dispatch', fn as (value?: unknown) => void);
  }
}

let nextId = 1;
function getSource(): string {
  return String(nextId++);
}

// FIXME: differentiate stop & stopImmediate
export class CommandEvent {
  type: string;
  /** Arguments passed to `dispatch` (or a keymap binding's `args`). */
  args: unknown[];
  stopPropagationCalled = false;
  aborted = false;

  constructor(type: string, args: unknown[] = []) {
    this.type = type;
    this.args = args;
  }

  stopPropagation(): void {
    this.stopPropagationCalled = true;
  }

  stopImmediatePropagation(): void {
    this.stopPropagationCalled = true;
  }

  abortKeyBinding(): void {
    this.aborted = true;
  }
}
