; Foldable nodes — block bodies (`{ … }`, `do … done`), the if / case constructs,
; subshells, array literals and heredoc bodies. Bash is keyword-delimited (no
; `} else {` continuation line), so there's no `@fold.keepFooter` — every fold is
; a plain join. See folding.md.
[
  (compound_statement)
  (do_group)
  (if_statement)
  (case_statement)
  (case_item)
  (subshell)
  (array)
  (heredoc_body)
  (comment)
] @fold
