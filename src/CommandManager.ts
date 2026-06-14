/*
 * CommandManager — registers named commands against widgets (by selector or by
 * instance) and dispatches them to the right widget along the focus chain.
 *
 * Ported from xedel's commands-manager.js. Adaptations for quilx:
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
import { parseSelector, matchesRule, elementMatchKeys, type Rule } from './util/selectors.ts';
import { unreachable } from './util/assert.ts';
import { Gtk } from './gi.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

type CommandCallback = (this: Widget, event: CommandEvent, element: Widget) => void;
export type CommandEffect = CommandCallback | { didDispatch: CommandCallback };
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
  emitter = new Emitter();

  get(element: Widget, command: string): CommandEffect | undefined {
    const commandBundles = this.bundlesFor(element);

    for (let i = 0; i < commandBundles.length; i++) {
      const bundle = commandBundles[i];
      if (bundle.rule !== true && !matchesRule(element, bundle.rule))
        continue;
      if (command in bundle.commands)
        return bundle.commands[command];
    }

    console.warn(`Command '${command}' is not registered for ${element.getName()}`);
    return undefined;
  }

  // All command bundles that could apply to `element`: those indexed under any
  // of its keys (type, CSS classes, wildcard) plus any registered on the element
  // instance directly. Callers still confirm each with `matchesRule`.
  private bundlesFor(element: Widget): CommandBundle[] {
    const keyed = elementMatchKeys(element)
      .flatMap((key) => this.commandsByName[key] || []);
    return keyed.concat(this.commandsByElement.get(element) || []);
  }

  /**
   * Enumerate every command available along a focus chain (as returned by
   * `getActiveElements`), in resolution order: the first element to offer a
   * given name wins, mirroring `get`. Each entry carries the element to dispatch
   * the command back to. Used to populate the command palette.
   */
  getAvailableCommands(elements: Widget[]): Array<{ name: string; element: Widget }> {
    const seen = new Set<string>();
    const result: Array<{ name: string; element: Widget }> = [];

    for (const element of elements) {
      const commandBundles = this.bundlesFor(element);

      for (const bundle of commandBundles) {
        if (bundle.rule !== true && !matchesRule(element, bundle.rule))
          continue;
        for (const name in bundle.commands) {
          if (seen.has(name))
            continue;
          seen.add(name);
          result.push({ name, element });
        }
      }
    }

    return result;
  }

  add(element: string | Widget, commands: CommandMap): Disposable {
    const source = getSource();

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

  dispatch(element: Widget, commandName: string | CommandCallback): boolean {
    const event = new CommandEvent(typeof commandName === 'string' ? commandName : '');
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
      effect.call(element, event, element);
    }
    else if (typeof effect === 'object' && typeof effect.didDispatch === 'function') {
      effect.didDispatch.call(element, event, element);
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
  stopPropagationCalled = false;
  aborted = false;

  constructor(type: string) {
    this.type = type;
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
