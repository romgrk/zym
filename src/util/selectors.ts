/*
 * selectors.ts — Atom-style CSS selector matching for command/keymap rules.
 *
 * Ported from xedel's utils/selectors.js. A selector like
 * `TextEditor:not(.mini) Box` is parsed into a list of `Rule`s; `matchesRule`
 * then walks a focused widget's ancestor chain to decide whether a rule applies.
 *
 * Adaptations for zym:
 *   - an `#id` selector and a bare tag are both matched against the widget's GTK
 *     name (`getName()`); `.class` / `:not()` fragments match its CSS classes
 *     (`getCssClasses()`). A widget's name defaults to its node-gtk type name
 *     (e.g. "GtkText", "GtkSourceView"). zym components carry their identity as a
 *     CSS class instead (`widget.addCssClass('Panel')` — e.g. the editor view, a
 *     `GtkSourceView`, gets the `TextEditor` class), so the convention is to
 *     target a zym component with `.class` (`.Panel`, `.TextEditor.insert-mode`)
 *     and a raw GTK widget by its type tag (e.g. `GtkText`); `#id` still matches
 *     any widget that sets a name;
 *   - the debug `console.log` at module load was removed and `translateTag`
 *     reduced to an identity passthrough (the Atom `atom-*` tag aliases don't
 *     map onto GTK widget names) — it stays as the extension point for aliases.
 */
import { createRequire } from 'node:module';
import type { Gtk } from '../gi.ts';
import { assert, unreachable } from './assert.ts';

// postcss-selector-parser is CommonJS; load it through createRequire so this
// stays an ES module without needing esModuleInterop (same trick as gi.ts).
const parser = createRequire(import.meta.url)('postcss-selector-parser') as
  typeof import('postcss-selector-parser');

type Widget = InstanceType<typeof Gtk.Widget>;

export interface RuleNode {
  element?: string;
  id?: string;
  has: string[];
  not: string[];
  combinator?: string;
}

export interface Rule {
  element: string | undefined;
  /** The subject's `#id` (matched, like a tag, against the widget's name). */
  id?: string;
  /**
   * The single bucket this rule is indexed under: its subject's tag or `#id` if
   * it has one, else its subject's first CSS class, else `*` (the wildcard
   * bucket). See `elementMatchKeys` for the lookup side.
   */
  key: string;
  description: RuleNode[];
  /**
   * CSS-style specificity of the whole selector, encoded as one comparable
   * number so a more specific rule outranks a less specific one. Used as the
   * tiebreaker when two matching bindings share the same priority — the more
   * specific selector wins (e.g. `#Panel .foo` beats `.foo`). See
   * `computeSpecificity`.
   */
  specificity: number;
  important?: boolean;
  platform?: string;
}

const PLATFORM_PATTERN = /\.platform-(\w+)/;

export function parseSelector(input: string): Rule[] {
  const results: Rule[] = [];

  const rules = input.split(',').map(r => r.trim());

  rules.forEach(ruleInput => {
    const important = ruleInput.endsWith('!important');
    const ruleCleanedInput = important ? ruleInput.replace('!important', '') : ruleInput;

    parser((selectors: any) => {
      const root = selectors;
      root.nodes.forEach((selector: any) => {
        const rule = parseRule(selector);
        rule.important = important;

        const platformIndex = rule.description.findIndex(r => PLATFORM_PATTERN.test(descriptionToString(r)));
        if (platformIndex !== -1) {
          assert(platformIndex + 1 < rule.description.length);
          assert(rule.description[platformIndex + 1].combinator !== undefined);

          const platformString = descriptionToString(rule.description[platformIndex]);
          const m = platformString.match(PLATFORM_PATTERN)!;
          rule.platform = m[1];
          rule.description.splice(platformIndex, 2);
        }

        results.push(rule);
      });
    }).processSync(ruleCleanedInput);
  });

  return results;
}

function parseRule(selector: any): Rule {
  const elements: RuleNode[] = [];
  let current: RuleNode = { element: undefined, has: [], not: [] };
  selector.nodes.forEach((node: any) => {
    switch (node.type) {
      case 'tag': {
        current.element = translateTag(node.value);
        break;
      }
      case 'id': {
        current.id = node.value;
        break;
      }
      case 'pseudo': {
        if (node.value === ':not')
          current.not.push(getValue(node.nodes[0].nodes[0]));
        else
          console.warn('Unhandled pseudo node value: ' + node.value);
        break;
      }
      case 'attribute':
      case 'class': {
        current.has.push(getValue(node));
        break;
      }
      case 'combinator': {
        elements.push(current);
        elements.push({ combinator: node.value, has: [], not: [] });
        current = { element: undefined, has: [], not: [] };
        break;
      }
      default: {
        console.warn('Unhandled selector node type: ' + node.type);
        break;
      }
    }
  });
  elements.push(current);

  // The subject is the rightmost compound (what the focused widget must match).
  // A rule is indexed by its subject's tag, or — for class-only selectors like
  // `.Panel` — its first class; `*` is the catch-all for selectors with neither.
  const subject = elements[elements.length - 1];
  const element = subject.element;
  const key = subject.element ?? subject.id ?? subject.has[0] ?? '*';

  if (key === '*')
    console.warn('Rule with no element, id, or class: ' + selector.toString());

  return {
    element,
    id: subject.id,
    key,
    description: elements,
    specificity: computeSpecificity(elements),
  };
}

// CSS specificity of a selector's compound chain, encoded as one comparable
// integer `a·1_000_000 + b·1_000 + c` (the classic `(ids, classes, tags)`
// triple). `#id` counts as an id, each class / `:not(.x)` argument as a class,
// each tag as a type — matching CSS, where `:not()` adds nothing itself but its
// argument's specificity counts. Combinators contribute nothing. The base of
// 1_000 leaves ample room for any realistic count without one column carrying
// into the next.
function computeSpecificity(description: RuleNode[]): number {
  let ids = 0, classes = 0, tags = 0;
  for (const node of description) {
    if (node.combinator) continue;
    if (node.id) ids += 1;
    if (node.element) tags += 1;
    classes += node.has.length + node.not.length;
  }
  return ids * 1_000_000 + classes * 1_000 + tags;
}

/**
 * A widget's identity for selector matching, with its `getName()` and
 * `getCssClasses()` snapshotted once. Both are node-gtk native calls (and
 * `getCssClasses` allocates a fresh array); on the per-keystroke matching path a
 * single element is probed against many rules and re-walked as an ancestor of
 * deeper elements, so reading them once and reusing the snapshot avoids the
 * repeated native crossings that dominated typing-time CPU.
 */
export interface ElementContext {
  widget: Widget;
  name: string;
  classes: string[];
}

/** Snapshot a widget's name and CSS classes for matching. */
export function elementContext(widget: Widget): ElementContext {
  return { widget, name: widget.getName() ?? '', classes: widget.getCssClasses() };
}

/**
 * The index keys an element can match a rule under: its GTK name (`getName()` —
 * the component's JS class name when set, else the node-gtk type name), each of
 * its CSS classes, and the `*` wildcard bucket. A rule lives in exactly one
 * bucket (its `key`); at lookup, a manager probes all of an element's keys, then
 * confirms with `matchesRule`.
 */
export function elementMatchKeys(element: ElementContext): string[] {
  return [element.name, ...element.classes, '*'];
}

// Shared selector-walk core. `subject` is the rightmost compound's element; the
// walk climbs ancestors via `next` until the whole selector chain is consumed.
// Both entry points below differ only in how they produce the next ancestor:
// the hot path indexes a precomputed chain, the single-element path walks
// `getParent()` lazily.
function matchesRuleWalk(
  subject: ElementContext,
  next: (current: ElementContext) => ElementContext | null,
  rule: Rule,
): boolean {
  if (rule.element && rule.element !== subject.name)
    return false;
  if (rule.id && rule.id !== subject.name)
    return false;

  let current: ElementContext | null = subject;
  let combinator: string | undefined = undefined;
  let distance = 0;

  let i = rule.description.length - 1;
  let node: RuleNode | undefined = rule.description[i--];

  while (current && node) {

    if (node.combinator) {
      combinator = node.combinator;
      distance = 0;
      node = rule.description[i--];
    }

    if (node && matchesNode(current, node)) {
      node = rule.description[i--];
      // `>` is a direct-child combinator: the combinator branch above reset
      // `distance` to 0 at the first ancestor candidate, so a match must land
      // there (distance 0). A non-zero distance means we climbed past one or
      // more intervening elements — that's a descendant, not a direct child.
      if (combinator === '>' && distance > 0)
        return false;
      combinator = undefined;
    }
    else {
      if (current === subject)
        return false;
    }

    current = next(current);
    distance += 1;
  }

  if (node)
    return false;

  return true;
}

/**
 * Match `rule` against the element at `index` in an already-collected focus
 * chain (`getActiveElements` order: focused element first, each ancestor next).
 * The chain's tail past `index` is exactly the element's ancestors, so the
 * selector walk reuses it instead of re-calling `getParent()` per node — the
 * per-keystroke fast path.
 */
export function matchesRuleInChain(chain: ElementContext[], index: number, rule: Rule): boolean {
  let i = index;
  return matchesRuleWalk(chain[index], () => chain[++i] ?? null, rule);
}

/**
 * Match `rule` against a single widget, walking its live `getParent()` chain.
 * For callers (e.g. command resolution) that hold one element rather than a
 * precomputed chain.
 */
export function matchesRule(element: Widget, rule: Rule): boolean {
  return matchesRuleWalk(
    elementContext(element),
    current => {
      const parent = current.widget.getParent();
      return parent ? elementContext(parent) : null;
    },
    rule,
  );
}

function matchesNode(element: ElementContext, node: RuleNode): boolean {
  if (node.element && element.name !== node.element)
    return false;
  if (node.id && element.name !== node.id)
    return false;
  if (node.has.length === 0 && node.not.length === 0)
    return true;
  const classNames = element.classes;
  if (!node.has.every(c => classNames.includes(c)))
    return false;
  if (!node.not.every(c => !classNames.includes(c)))
    return false;
  return true;
}

function descriptionToString(d: RuleNode): string {
  if (d.combinator)
    return d.combinator;
  return [
    d.element,
    d.id ? `#${d.id}` : '',
    ...d.has.map(c => `.${c}`),
    ...d.not.map(c => `:not(.${c})`),
  ].join('');
}

function getValue(node: any): string {
  switch (node.type) {
    case 'class': return node.value;
    case 'attribute': return node.attribute ?? node._attribute;
    default:
      return unreachable();
  }
}

export function translateTag(tag: string): string {
  // Extension point for selector tag aliases. zym selectors use node-gtk
  // widget class names directly, so this is currently an identity mapping.
  return tag;
}
