; Foldable nodes — block bodies (functions, structs/enums, initializers) +
; multi-line comments. `foldTypes` is the fallback if this query is missing.
[
  (compound_statement)
  (field_declaration_list)
  (enumerator_list)
  (initializer_list)
  (comment)
] @fold

; --- keep-footer: an `if` whose closing line continues as `} else …`. Captured
; --- separately so the fold keeps that line on its own (matching `} else {` /
; --- `} else if … {`) instead of joining it onto the header. The final `else`
; --- block has no `alternative`, so it folds via the plain `@fold` above. See
; --- folding.md.
(if_statement
  consequence: (compound_statement) @fold.keepFooter
  alternative: (else_clause))
