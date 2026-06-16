; SCSS highlights — authored for quilx's capture palette. A CSS superset: adds
; `$variables`, `#{interpolation}`, `%placeholders`, and the SCSS at-rules
; (`@mixin`/`@include`/`@function`/`@if`/`@each`/`@use`/…). Compiles against the
; vendored tree-sitter-scss grammar (./grammars/tree-sitter-scss.wasm).

; Comments
[
  (comment)
  (js_comment)
] @comment

; Variables & interpolation
(variable) @variable.special
(argument (variable) @variable.special)
(interpolation) @punctuation.special
(placeholder) @attribute

; Selectors
(tag_name) @tag
(universal_selector) @tag
(nesting_selector) @tag

(class_selector (class_name) @attribute)
(id_selector (id_name) @attribute)
(pseudo_class_selector (class_name) @attribute)
(pseudo_element_selector (tag_name) @attribute)
(attribute_selector (attribute_name) @attribute)

; Properties
(declaration (property_name) @property)
(feature_name) @property

; SCSS control-flow & module at-rules (the keyword glyph lives in the statement node)
(include_statement (identifier) @function)
(mixin_statement name: (identifier) @function)
(function_statement name: (identifier) @function)
(call_expression (function_name) @function)

[
  "@mixin"
  "@include"
  "@function"
  "@return"
  "@if"
  "@else"
  "@each"
  "@for"
  "@while"
  "@use"
  "@forward"
  "@extend"
  "@at-root"
  "@import"
  "@media"
  "@charset"
  "@namespace"
  "@supports"
  "@keyframes"
  "@debug"
  "@warn"
  "@error"
] @keyword

(at_keyword) @keyword
(keyframes_name) @type

; Control-flow operator keywords (`from`/`to` are named nodes in this grammar)
[
  (from)
  (to)
] @keyword

[
  "through"
  "in"
  "and"
  "or"
  "not"
  "only"
] @keyword

; Values
(string_value) @string
(color_value) @constant
(integer_value) @number
(float_value) @number
(unit) @type
(important) @keyword
(plain_value) @variable

; Punctuation
[
  ","
  ":"
  ";"
] @punctuation.delimiter

[
  "{"
  "}"
  "("
  ")"
  "["
  "]"
] @punctuation.bracket

[
  "="
  "*"
  "+"
  "-"
  "/"
  "%"
  ">"
  "~"
  "=="
  "!="
  "<"
  ">="
  "<="
] @operator
