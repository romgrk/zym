; Bash / shell highlights — authored for quilx's capture palette (see `theme.syntax`;
; the highlighter does longest-prefix fallback, and the per-character winner is the
; highest-priority capture, so unknown captures degrade gracefully). Compiles
; against tree-sitter-bash (bundled by tree-sitter-wasms).

; Comments
(comment) @comment

; Commands — the invoked program (builtin or external) reads as a function call.
(command_name) @function

; Function definitions
(function_definition
  name: (word) @function)

; Variables — assignment targets and the names inside `$VAR` / `${VAR}` / `${arr[i]}`.
; Plain variables use @variable (no palette key → default fg, like the other
; languages); the special parameters ($1, $@, $?, $#, …) get @variable.special.
(variable_name) @variable
(variable_assignment
  name: (variable_name) @variable)
(simple_expansion
  (variable_name) @variable)
(expansion
  (variable_name) @variable)
(subscript
  name: (variable_name) @variable)
(special_variable_name) @variable.special

; Expansion sigils — the `$`, `${`, `}` framing a parameter expansion.
(simple_expansion
  "$" @punctuation.special)
(expansion
  "${" @punctuation.special
  "}" @punctuation.special)

; Literals
(number) @number
(file_descriptor) @number

; Strings — capture the inner content (not the whole `string` node) so embedded
; expansions keep their own colors. Single-quoted and $'…' strings hold no
; expansions, so they're captured whole.
(string
  (string_content) @string)
[
  (raw_string)
  (ansi_c_string)
  (translated_string)
] @string
(heredoc_content) @string

; Heredoc delimiter markers (the `EOF` words bracketing the body).
[
  (heredoc_start)
  (heredoc_end)
] @constant

; Regular expressions — `[[ $x =~ … ]]` and `${var/re/repl}` patterns.
(regex) @string.regex

; Keywords — control flow.
[
  "if" "then" "else" "elif" "fi"
  "case" "esac" "in"
  "for" "select" "while" "until" "do" "done"
  "function"
] @keyword

; Keywords — declaration builtins.
[
  "declare" "typeset" "export" "readonly" "local" "unset"
] @keyword

; Operators — logical / pipe / assignment / comparison / redirection, plus the
; `-d`/`-f`/`-z`/`=` test operators inside `[ … ]` / `[[ … ]]`.
[
  "&&" "||" "|" "|&" "&"
  "==" "!=" "=~" "=" "!"
  ">" ">>" "<" "<<" "<<<" "<<-"
  ">&" "<&" "&>" "&>>"
] @operator
(test_operator) @operator

; Punctuation — grouping brackets and statement delimiters.
[
  "(" ")" "((" "))"
  "[" "]" "[[" "]]"
  "{" "}"
] @punctuation.bracket
[
  ";" ";;" ";&" ";;&"
] @punctuation.delimiter
