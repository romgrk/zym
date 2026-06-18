/*
 * nodeTypes — predicates and patterns that classify tree-sitter node *types*
 * across the grammars the editor ships. The grammars don't share a node-type
 * vocabulary, so each classification is a small union/regex tuned to cover the
 * languages we support while staying grammar-agnostic where it can.
 */

// Node types treated as "string-like" content — strings, comments, char and
// regex literals — so bracket matching skips brackets that aren't real code.
export const STRING_COMMENT_RE = /string|comment|char|regex/;

// Node types folded as a *run* of consecutive siblings (import block, comment block).
export const RUN_FOLD_RE = /comment|import/;

// Function/method node types that DON'T contain "function"/"method"/"constructor"
// in their name (Go func literals, lambdas, arrow functions, Rust closures).
const FUNCTION_NODE_TYPES = new Set([
  'func_literal',
  'lambda',
  'lambda_expression',
  'closure_expression',
  'arrow_function',
]);

/** Whether `type` is a function/method/constructor node — for the `if`/`af` text object. */
export function isFunctionNodeType(type: string): boolean {
  return /function|method|constructor/.test(type) || FUNCTION_NODE_TYPES.has(type);
}

/** Class-like *definitions* (class/interface/enum/struct/trait/impl), for the `ic`/`ac`
 *  text object — the declaration node, not its `*_body` (whose type also contains "class"). */
export function isClassNodeType(type: string): boolean {
  return /class|interface|enum|struct|trait|impl/.test(type) && !/_body$/.test(type);
}
