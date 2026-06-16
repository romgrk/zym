; CSS — quilx palette (Zed capture names). Registered as an injection-only grammar
; so HTML <style> blocks get highlit; a future CSS plugin can add `.css` detection
; on top of this same grammar with no change here.

(comment) @comment

; Selectors
(tag_name) @tag
(class_name) @attribute
(id_name) @attribute
(attribute_name) @attribute
(pseudo_class_selector (class_name) @attribute)
(pseudo_element_selector (tag_name) @attribute)
(nesting_selector) @attribute
(universal_selector) @punctuation.special

; Declarations
(property_name) @property
(feature_name) @property
((property_name) @variable
  (#match? @variable "^--"))
((plain_value) @variable
  (#match? @variable "^--"))

(function_name) @function
(namespace_name) @namespace

; Values
(string_value) @string
(color_value) @string.special
(integer_value) @number
(float_value) @number
(unit) @type
(important) @keyword

; At-rules
[
  "@media"
  "@import"
  "@charset"
  "@namespace"
  "@supports"
  "@keyframes"
] @keyword

(keyword_query) @keyword
[
  "and"
  "or"
  "not"
  "only"
] @keyword.operator

; Punctuation & operators
[
  "{"
  "}"
  "("
  ")"
  "["
  "]"
] @punctuation.bracket

[
  ","
  ":"
  "::"
  ";"
  "."
  "#"
] @punctuation.delimiter

[
  "*"
  "+"
  "-"
  "/"
  "~"
  ">"
  "="
] @operator
