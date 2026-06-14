// Colors from the kyntell colorscheme.

export const THEME = {
  fg: '#C9D2E1', // Normal fg (s:fg)
} as const;

// Capture name → foreground color, keyed by the capture names Zed's queries emit
// (see grammar.ts). Values mirror kyntell.vim's tree-sitter `@capture` → group
// mapping (the `hi! link @… ` block), resolved to the group's `guifg`.
//
// Dotted captures resolve by longest-prefix fallback in the highlighter
// (syntax-controller's resolveTag): e.g. @keyword.control/.import/.declaration
// reuse `keyword`; @type.builtin/.class/.name reuse `type`; @function.method
// reuses `function`; @punctuation.bracket/.delimiter(/.jsx) and @tag.component.jsx
// reuse `punctuation`/`tag`. Only list a dotted key to give it a *distinct* color.
// Captures with no entry — @variable (NormalText), @embedded, @text.jsx, @nested —
// stay the default foreground, as kyntell links @variable → NormalText.
//
// KEY ORDER MATTERS: one tag is created per entry in this order, and GtkTextTag
// priority follows creation order (later = higher). A node can match several
// patterns at once (Zed's catch-all `(identifier) @variable` plus a specific
// `@function`/`@constant`/…, `@string` plus `@string.escape` over an escape, or a
// JSX component captured as both `@type` and `@tag.component.jsx`), and all
// matching tags apply — priority decides the winner. So more-specific / should-win
// categories come LAST: escapes after `string`; `tag` before `type` so components
// render as types; `property` before `function` so method names win.
export const COLORS: Record<string, string> = {
  comment:             '#777777', // base7 (Comment)
  operator:            '#10b1fe', // blue_main (Operator)
  punctuation:         '#10b1fe', // blue_main (Delimiter) — brackets/delimiters, incl .jsx
  'punctuation.special': '#f9c859', // string_color (DelimiterAlt) — ${}, decorators, type punct
  string:              '#f9c859', // string_color (String)
  'string.regex':      '#dd0093', // regex_color (Regexp)
  'string.escape':     '#EB05AA', // special_color (StringSpecial) — escapes inside strings
  number:              '#da8548', // orange (Number)
  boolean:             '#da8548', // orange (Boolean → number_color)
  'constant.builtin':  '#da8548', // orange (ConstBuiltin → number_color) — null/undefined
  constant:            '#91B6FF', // blue_violet (Constant) — UPPER_CASE constants
  'variable.special':  '#91B6FF', // blue_violet (VariableBuiltin) — this/super
  'variable.parameter': '#ABB7E0', // blue_desat (Argument ≈ ident_color) — function params
  attribute:           '#ECCC7B', // yellow (tag.attribute → Property) — JSX attributes
  tag:                 '#10b1fe', // blue_main (Tag → Keyword) — lowercase JSX tags
  keyword:             '#10b1fe', // blue_main (keyword_color) — incl control/import/declaration
  property:            '#ECCC7B', // yellow (Property) — incl property.name
  type:                '#e5ce5c', // yellow_main (Type) — incl type.builtin/.class/.name
  constructor:         '#DFD9A3', // fn_color (constructor → Method)
  function:            '#DFD9A3', // fn_color (Function/Method) — incl function.method
};
