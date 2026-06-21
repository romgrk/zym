/*
 * injection — gather a parse tree's highlight captures, descending through the
 * grammar's language injections (Markdown fenced code → the fence's grammar,
 * inline spans → markdown-inline, JS/CSS-in-HTML once those ship). Returns one
 * flat list of `RawCapture` primitives: the base grammar's captures first, each
 * injected layer's after — so the paint sweep's "innermost + later-index wins"
 * lets a narrow injected token paint over the broad host region containing it.
 *
 * Captures are flattened off their tree-sitter nodes at gather time so each
 * injected tree can be freed immediately — its `SyntaxNode`s would dangle once
 * the wasm tree is deleted. See tasks/code-editing/syntax-injection.md.
 */
import { type Grammar, grammarForName } from './grammar.ts';

// How deep language injections nest before we stop (Markdown → inline / fenced
// code is depth 1; a fenced block whose grammar itself injects would be depth 2).
// A small bound guards against a pathological self-injecting grammar.
export const MAX_INJECTION_DEPTH = 3;

// One highlight capture flattened to primitives — detached from its tree-sitter
// node so injected trees can be freed before painting (their nodes would dangle).
export interface RawCapture {
  name: string;
  start: number; end: number;
  sRow: number; sCol: number; eRow: number; eCol: number;
}

// The buffer region to highlight: tree-sitter points (for range-limited queries)
// plus UTF-16 indices (for the injection off-screen check). Null = whole buffer.
export interface VisibleRange {
  startPoint: { row: number; column: number };
  endPoint: { row: number; column: number };
  startIndex: number;
  endIndex: number;
}

/**
 * Gather highlight captures for `grammar` over `root` into `out`, then recurse
 * into its language injections: for each injection match, resolve the guest
 * grammar (from a captured `@language` node's text, else the injection's static
 * `language`), parse just the `@content` range with that grammar (positions stay
 * absolute via `includedRanges`), and collect its captures too. `parserFor`
 * supplies a cached parser per guest grammar; injected trees are transient —
 * parsed, gathered, and freed here. Recursion is bounded by MAX_INJECTION_DEPTH.
 */
export function collectCaptures(
  grammar: Grammar,
  root: any,
  text: string,
  out: RawCapture[],
  depth: number,
  range: VisibleRange | null,
  parserFor: (grammar: Grammar) => any,
): void {
  const captures = range
    ? grammar.query.captures(root, range.startPoint, range.endPoint)
    : grammar.query.captures(root);
  for (const cap of captures) {
    const n = cap.node;
    out.push({
      name: cap.name,
      start: n.startIndex, end: n.endIndex,
      sRow: n.startPosition.row, sCol: n.startPosition.column,
      eRow: n.endPosition.row, eCol: n.endPosition.column,
    });
  }
  if (depth >= MAX_INJECTION_DEPTH) return;

  for (const inj of grammar.injections) {
    const matches = range
      ? inj.query.matches(root, range.startPoint, range.endPoint)
      : inj.query.matches(root);
    for (const match of matches) {
      let langName: string | undefined = inj.language;
      const contentNodes: any[] = [];
      for (const cap of match.captures) {
        if (cap.name === 'content' || cap.name === 'injection.content') contentNodes.push(cap.node);
        else if (cap.name === 'language' || cap.name === 'injection.language') langName = cap.node.text;
      }
      if (!langName || contentNodes.length === 0) continue;
      const guest = grammarForName(langName);
      if (!guest) continue; // no grammar for that fence language — leave it plain

      const parser = parserFor(guest);
      for (const node of contentNodes) {
        if (node.startIndex >= node.endIndex) continue;
        // Skip injections entirely off-screen — the big win for Markdown, where
        // there's an `inline` node per paragraph but only a few are visible.
        if (range && (node.endIndex <= range.startIndex || node.startIndex >= range.endIndex)) continue;
        const included = {
          startIndex: node.startIndex, endIndex: node.endIndex,
          startPosition: node.startPosition, endPosition: node.endPosition,
        };
        let injTree: any;
        try {
          injTree = parser.parse(text, undefined, { includedRanges: [included] });
        } catch {
          injTree = null; // a guest parse failure must never break host highlighting
        }
        if (!injTree) continue;
        collectCaptures(guest, injTree.rootNode, text, out, depth + 1, range, parserFor);
        injTree.delete();
      }
    }
  }
}

/** The min/max line span covered by a capture list, or null if empty — what the
 *  highlighter clears before its next paint. */
export function extentOf(captures: RawCapture[]): { fromLine: number; toLine: number } | null {
  if (captures.length === 0) return null;
  let fromLine = Infinity, toLine = -1;
  for (const c of captures) {
    if (c.sRow < fromLine) fromLine = c.sRow;
    if (c.eRow > toLine) toLine = c.eRow;
  }
  return { fromLine, toLine };
}
