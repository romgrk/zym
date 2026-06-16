; Foldable nodes — block bodies (functions, structs/enums, initializers) +
; multi-line comments. `foldTypes` is the fallback if this query is missing.
[
  (compound_statement)
  (field_declaration_list)
  (enumerator_list)
  (initializer_list)
  (comment)
] @fold
