; Foldable nodes — rule/at-rule/mixin/control-flow bodies + multi-line comments.
; SCSS nests every body (rule sets, `@mixin`, `@if`, `@each`, …) in a `block`.
[
  (block)
  (keyframe_block_list)
  (comment)
] @fold
