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

; --- keep-footer: chained constructs whose closing line continues (`} else {`,
; --- `} else if … {`, `} catch (…) {`). Captured separately so the fold keeps
; --- that line on its own instead of joining it onto the header. The final
; --- `else` block (no `alternative`) folds via the plain `@fold` above. See
; --- folding.md.
(if_statement
  consequence: (compound_statement) @fold.keepFooter
  alternative: (else_clause))
(try_statement
  body: (compound_statement) @fold.keepFooter
  (catch_clause))
