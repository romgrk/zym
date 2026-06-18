; Foldable nodes — block bodies + bracketed groups + multi-line comments.
[
  (block)
  (declaration_list)
  (field_declaration_list)
  (enum_variant_list)
  (use_list)
  (match_block)
  (arguments)
  (array_expression)
  (struct_pattern)
  (block_comment)
  (line_comment)
] @fold

; --- keep-footer: an `if` whose closing line continues as `} else …`. Captured
; --- separately so the fold keeps that line on its own (matching `} else {` /
; --- `} else if … {`) instead of joining it onto the header. The final `else`
; --- block has no `alternative`, so it folds via the plain `@fold` above. See
; --- folding.md.
(if_expression
  consequence: (block) @fold.keepFooter
  alternative: (else_clause))
