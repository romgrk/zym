; C++ highlights — authored for quilx's capture palette (see `theme.syntax`; the
; highlighter does longest-prefix fallback, so unknown captures degrade
; gracefully, and the theme's per-capture priority resolves overlaps). Compiles
; against tree-sitter-cpp (bundled by tree-sitter-wasms), a C superset, so the C
; rules are repeated here with the C++ additions (namespaces, templates, classes).

; Preprocessor directives (#include / #define / #ifdef / …)
[
  "#include"
  "#define"
  "#if"
  "#ifdef"
  "#ifndef"
  "#elif"
  "#else"
  "#endif"
  (preproc_directive)
] @keyword.import

(preproc_def
  name: (identifier) @constant)
(preproc_function_def
  name: (identifier) @function)
(system_lib_string) @string
(preproc_include
  path: (string_literal) @string)

; Function definitions and calls
(function_declarator
  declarator: (identifier) @function)
(function_declarator
  declarator: (field_identifier) @function.method)
(function_declarator
  declarator: (qualified_identifier
    name: (identifier) @function))
(call_expression
  function: (identifier) @function)
(call_expression
  function: (field_expression
    field: (field_identifier) @function.method))
(call_expression
  function: (qualified_identifier
    name: (identifier) @function))

; Types
(primitive_type) @type.builtin
(sized_type_specifier) @type.builtin
(type_identifier) @type
(namespace_identifier) @type
(enum_specifier
  name: (type_identifier) @type)
(struct_specifier
  name: (type_identifier) @type)
(union_specifier
  name: (type_identifier) @type)
(class_specifier
  name: (type_identifier) @type.class)
(auto) @type.builtin

; Fields and parameters
(field_identifier) @property
(field_expression
  field: (field_identifier) @property)
(parameter_declaration
  declarator: (identifier) @variable.parameter)
(parameter_declaration
  declarator: (pointer_declarator
    (identifier) @variable.parameter))
(parameter_declaration
  declarator: (reference_declarator
    (identifier) @variable.parameter))

; Enum members and ALL_CAPS identifiers read as constants
(enumerator
  name: (identifier) @constant)
((identifier) @constant
  (#match? @constant "^[A-Z][A-Z0-9_]*$"))

; Literals
(string_literal) @string
(raw_string_literal) @string
(char_literal) @string
(escape_sequence) @string.escape
(number_literal) @number
[
  (true)
  (false)
] @boolean
; `nullptr` parses as a (null) node, so this covers both
(null) @constant.builtin
(this) @variable.special
(comment) @comment

; Storage / type keywords
[
  "const"
  "constexpr"
  "volatile"
  "extern"
  "static"
  "register"
  "inline"
  "mutable"
  "explicit"
  "friend"
  "virtual"
  "override"
  "final"
  "sizeof"
] @keyword

[
  "struct"
  "union"
  "enum"
  "typedef"
  "class"
  "namespace"
  "template"
  "typename"
  "using"
] @keyword.declaration

[
  "public"
  "private"
  "protected"
] @keyword

[
  "break"
  "case"
  "continue"
  "default"
  "do"
  "else"
  "for"
  "goto"
  "if"
  "return"
  "switch"
  "while"
  "try"
  "catch"
  "throw"
  "co_await"
  "co_return"
  "co_yield"
] @keyword.control

[
  "new"
  "delete"
  "operator"
] @keyword.operator

; Operators and punctuation
[
  "+" "-" "*" "/" "%"
  "++" "--"
  "==" "!=" "<" ">" "<=" ">="
  "&&" "||" "!"
  "&" "|" "^" "~" "<<" ">>"
  "=" "+=" "-=" "*=" "/=" "%=" "&=" "|=" "^=" "<<=" ">>="
  "->" "." "?" "::"
] @operator

[
  "("
  ")"
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

[
  ";"
  ","
  ":"
] @punctuation.delimiter
