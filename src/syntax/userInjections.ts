/*
 * User-configured language injections — parse a high-level `editor.languageInjections`
 * config entry into an `InjectionRule`, and compile a rule (user- OR plugin-contributed)
 * into the same `InjectionDef` (a tree-sitter query + a guest language) the built-in
 * grammars declare, so it rides the existing injection engine (see
 * docs/text-editor/syntax-injection.md) with no special-casing downstream.
 *
 * The motivating case is the JS/TS "comment-tagged template literal": a block- or
 * line-comment naming a language (a `css` comment) marking the following backtick
 * string as that language, plus the tagged-template form (a `css` or `styled.div`
 * tag) that styled-components / lit-html / graphql-tag use. Both compile to a query
 * with a predicate (`#match?` / `#eq?`, applied by web-tree-sitter 0.20.x) and a
 * STATIC guest `language` — we never capture the marker as `@injection.language`
 * (its node text is the whole comment, not a language id). A raw `query` form is the
 * escape hatch for any other host/shape.
 *
 * This module is pure (no tree-sitter, no GTK): it produces query *strings*;
 * `grammar.ts` compiles them against each host grammar (defensively — a malformed
 * query is skipped, never breaks the host's own highlighting). The `InjectionRule`
 * shape itself lives in `../lang/types.ts` (shared with plugin contributions).
 */
import type { InjectionDef, InjectionRule } from '../lang/types.ts';

export type { InjectionRule };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A non-empty trimmed string, or null. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** Normalize a rule's required `host` field (string | string[]) to a non-empty list,
 *  or null if missing/malformed. A host is never defaulted — every rule names one (or
 *  several, e.g. `["typescript", "tsx"]` for the JS/TS family). */
function hostsOf(v: unknown): string[] | null {
  if (typeof v === 'string') return str(v) ? [v.trim()] : null;
  if (Array.isArray(v)) {
    const hosts = v.map(str).filter((h): h is string => h !== null);
    return hosts.length ? hosts : null;
  }
  return null;
}

/** Validate + normalize one config entry, or null if it's malformed (caller warns). */
function parseRule(entry: unknown): InjectionRule | null {
  if (!isObject(entry)) return null;
  const comment = str(entry.comment);
  const tag = str(entry.tag);
  const query = str(entry.query);
  // Exactly one matcher.
  if ([comment, tag, query].filter((m) => m !== null).length !== 1) return null;

  // `host` is required (one or more language ids) — never defaulted.
  const hosts = hostsOf(entry.host);
  if (!hosts) return null;

  // `language` defaults to the marker keyword for the comment/tag forms; the raw
  // query form has no keyword to default from, so it must name a `language`.
  const language = str(entry.language) ?? comment ?? tag;
  if (!language) return null;

  if (comment) return { hosts, language, comment };
  if (tag) return { hosts, language, tag };
  return { hosts, language, query: query! };
}

/**
 * Parse the raw `editor.languageInjections` value into normalized rules, dropping
 * (with a warning) any malformed entry so one bad rule can't sink the rest.
 */
export function parseInjectionRules(raw: unknown): InjectionRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: InjectionRule[] = [];
  for (const entry of raw) {
    const rule = parseRule(entry);
    if (rule) rules.push(rule);
    else console.warn('[injection] ignoring invalid editor.languageInjections entry:', JSON.stringify(entry));
  }
  return rules;
}

/**
 * Escape regex metacharacters in a keyword, DOUBLING each backslash so it survives
 * the tree-sitter query-string unescape (a literal backslash pair becomes one)
 * before reaching the (JS) regex engine `#match?` runs.
 */
function escapeRegexForQuery(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&');
}

/** Escape a string for a tree-sitter query string literal (backslash and quote). */
function escapeStringForQuery(s: string): string {
  return s.replace(/[\\"]/g, '\\$&');
}

/**
 * Query for the comment-prefix form: a line- or block-comment whose body is
 * `keyword`, immediately followed by a template literal — inject the literal's text
 * fragments. The `#match?` regex (after query-string unescaping) anchors the comment
 * opener, optional whitespace, the keyword, optional whitespace, and an optional
 * block-comment closer; so a `css` line comment and a `css` block comment (with or
 * without inner spaces) all match.
 */
function commentInjectionQuery(keyword: string): string {
  const kw = escapeRegexForQuery(keyword);
  const re = `^(//+|/\\\\*)\\\\s*${kw}\\\\s*(\\\\*/)?$`;
  return `((comment) @_marker .`
    + ` (template_string (string_fragment) @injection.content)`
    + ` (#match? @_marker "${re}"))`;
}

/**
 * Query for the tagged-template form: a `tag` template or a `tag.member` template
 * (the root identifier must equal `tag`) — inject the template's text fragments.
 * Captures the tag under `@_tag` purely for the `#eq?` predicate; the engine ignores
 * it (only `@injection.content` / `@injection.language` are read).
 */
function tagInjectionQuery(tag: string): string {
  const t = escapeStringForQuery(tag);
  return `((call_expression`
    + ` function: [(identifier) @_tag (member_expression object: (identifier) @_tag)]`
    + ` arguments: (template_string (string_fragment) @injection.content))`
    + ` (#eq? @_tag "${t}"))`;
}

/** The tree-sitter query string a rule contributes to a host grammar. */
export function injectionQueryFor(rule: InjectionRule): string {
  if (rule.query !== undefined) return rule.query;
  if (rule.comment !== undefined) return commentInjectionQuery(rule.comment);
  return tagInjectionQuery(rule.tag!);
}

/**
 * The `InjectionDef`s (query string + static guest language) `rules` contribute to
 * one host language. `grammar.ts` compiles each query against the host grammar.
 */
export function injectionDefsFor(rules: InjectionRule[], hostLangId: string): InjectionDef[] {
  const defs: InjectionDef[] = [];
  for (const rule of rules) {
    if (!rule.hosts.includes(hostLangId)) continue;
    defs.push({ query: injectionQueryFor(rule), language: rule.language });
  }
  return defs;
}
