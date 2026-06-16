; Foldable nodes — block bodies (functions, classes/structs/enums, namespaces,
; initializers) + multi-line comments. `foldTypes` is the fallback if missing.
[
  (compound_statement)
  (field_declaration_list)
  (enumerator_list)
  (initializer_list)
  (declaration_list)
  (comment)
] @fold
