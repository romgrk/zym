; Python highlights — authored for quilx's capture palette (see `theme.syntax`;
; the highlighter does longest-prefix fallback, so unknown captures degrade
; gracefully). Compiles against tree-sitter-python (bundled by tree-sitter-wasms).

; Identifiers
(identifier) @variable

; Constants — SCREAMING_SNAKE_CASE identifiers
((identifier) @constant
  (#match? @constant "^_*[A-Z][A-Z\\d_]*$"))

; Types — UpperCamelCase identifiers + the dedicated type contexts
((identifier) @type
  (#match? @type "^_*[A-Z][a-z]"))
(class_definition
  name: (identifier) @type)
(type (identifier) @type)

; Attributes (member access)
(attribute
  attribute: (identifier) @property)

; Functions
(function_definition
  name: (identifier) @function)
(call
  function: (identifier) @function)
(call
  function: (attribute
    attribute: (identifier) @function.method))

; Decorators
(decorator) @function.macro

; Parameters
(parameters (identifier) @variable.parameter)
(lambda_parameters (identifier) @variable.parameter)
(default_parameter name: (identifier) @variable.parameter)
(typed_parameter (identifier) @variable.parameter)
(typed_default_parameter name: (identifier) @variable.parameter)
(keyword_argument name: (identifier) @variable.parameter)

; self / cls
((identifier) @variable.special
  (#match? @variable.special "^(self|cls)$"))

; Literals
[
  (true)
  (false)
] @boolean
(none) @constant.builtin
(integer) @number
(float) @number
[
  (string)
  (concatenated_string)
] @string
(escape_sequence) @string.escape
(interpolation) @none

; Comments
(comment) @comment

; Punctuation
[
  "("
  ")"
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

[
  ","
  "."
  ";"
  ":"
  "->"
  "@"
] @punctuation.delimiter

[
  "+"
  "-"
  "*"
  "/"
  "//"
  "%"
  "**"
  "="
  "=="
  "!="
  "<"
  ">"
  "<="
  ">="
  "&"
  "|"
  "^"
  "~"
  "<<"
  ">>"
  "+="
  "-="
  "*="
  "/="
  ":="
] @operator

; Keywords
[
  "and"
  "as"
  "assert"
  "async"
  "await"
  "break"
  "class"
  "continue"
  "def"
  "del"
  "elif"
  "else"
  "except"
  "exec"
  "finally"
  "for"
  "from"
  "global"
  "if"
  "in"
  "is"
  "lambda"
  "nonlocal"
  "not"
  "or"
  "pass"
  "print"
  "raise"
  "return"
  "try"
  "while"
  "with"
  "yield"
  "match"
  "case"
] @keyword

[
  "import"
  "from"
] @keyword.import
