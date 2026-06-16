; CSS highlights — authored for quilx's capture palette (see `theme.syntax`;
; the highlighter does longest-prefix fallback, so unknown captures degrade
; gracefully). Compiles against tree-sitter-css (bundled by tree-sitter-wasms).

; Comments
[
  (comment)
  (js_comment)
] @comment

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

; At-rules and keyframe names
(at_keyword) @keyword
(keyframes_name) @type
(keyframes_statement "@keyframes" @keyword)
(media_statement "@media" @keyword)
(import_statement "@import" @keyword)
(charset_statement "@charset" @keyword)
(namespace_statement "@namespace" @keyword)
(supports_statement "@supports" @keyword)

; Functions
(call_expression (function_name) @function)

; Values
(string_value) @string
(color_value) @constant
(integer_value) @number
(float_value) @number
(unit) @type
(important) @keyword
(plain_value) @variable

; Units / keyword-ish operators in queries
[
  "and"
  "or"
  "not"
  "only"
] @keyword

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
  ">"
  "~"
] @operator
