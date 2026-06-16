; C highlights — authored for quilx's capture palette (see `theme.syntax`; the
; highlighter does longest-prefix fallback, so unknown captures degrade
; gracefully, and the theme's per-capture priority resolves overlaps). Compiles
; against tree-sitter-c (bundled by tree-sitter-wasms).

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

; A macro name and the header it includes
(preproc_def
  name: (identifier) @constant)
(preproc_function_def
  name: (identifier) @function)
(preproc_call
  directive: (preproc_directive) @keyword.import)
(system_lib_string) @string
(preproc_include
  path: (string_literal) @string)

; Function definitions and calls
(function_declarator
  declarator: (identifier) @function)
(call_expression
  function: (identifier) @function)
(call_expression
  function: (field_expression
    field: (field_identifier) @function.method))

; Types
(primitive_type) @type.builtin
(sized_type_specifier) @type.builtin
(type_identifier) @type
(enum_specifier
  name: (type_identifier) @type)
(struct_specifier
  name: (type_identifier) @type)
(union_specifier
  name: (type_identifier) @type)

; Fields and parameters
(field_identifier) @property
(field_expression
  field: (field_identifier) @property)
(parameter_declaration
  declarator: (identifier) @variable.parameter)
(parameter_declaration
  declarator: (pointer_declarator
    (identifier) @variable.parameter))

; Statement labels (goto targets)
(labeled_statement
  label: (statement_identifier) @label)
(goto_statement
  label: (statement_identifier) @label)

; Enum members and ALL_CAPS identifiers read as constants
(enumerator
  name: (identifier) @constant)
((identifier) @constant
  (#match? @constant "^[A-Z][A-Z0-9_]*$"))

; Literals
(string_literal) @string
(char_literal) @string
(escape_sequence) @string.escape
(number_literal) @number
[
  (true)
  (false)
] @boolean
(null) @constant.builtin
(comment) @comment

; Storage / type keywords
[
  "const"
  "volatile"
  "extern"
  "static"
  "register"
  "inline"
  "restrict"
  "sizeof"
] @keyword

[
  "struct"
  "union"
  "enum"
  "typedef"
] @keyword.declaration

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
] @keyword.control

; Operators and punctuation
[
  "+" "-" "*" "/" "%"
  "++" "--"
  "==" "!=" "<" ">" "<=" ">="
  "&&" "||" "!"
  "&" "|" "^" "~" "<<" ">>"
  "=" "+=" "-=" "*=" "/=" "%=" "&=" "|=" "^=" "<<=" ">>="
  "->" "." "?"
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
