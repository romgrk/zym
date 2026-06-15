; Markdown (block) — quilx palette + markup.* styling. Inline spans and fenced
; code are highlit by injected grammars (see the plugin's injections).

; Per-level headings (h1 biggest → h6); scale is set per level in theme.syntaxStyle.
(atx_heading (atx_h1_marker) (inline) @markup.heading.1)
(atx_heading (atx_h2_marker) (inline) @markup.heading.2)
(atx_heading (atx_h3_marker) (inline) @markup.heading.3)
(atx_heading (atx_h4_marker) (inline) @markup.heading.4)
(atx_heading (atx_h5_marker) (inline) @markup.heading.5)
(atx_heading (atx_h6_marker) (inline) @markup.heading.6)
(setext_heading (paragraph) @markup.heading.1 (setext_h1_underline))
(setext_heading (paragraph) @markup.heading.2 (setext_h2_underline))
[
  (atx_h1_marker) (atx_h2_marker) (atx_h3_marker)
  (atx_h4_marker) (atx_h5_marker) (atx_h6_marker)
  (setext_h1_underline) (setext_h2_underline)
] @punctuation.special

(fenced_code_block_delimiter) @punctuation
(info_string (language) @type)
(indented_code_block) @markup.raw

[
  (list_marker_plus) (list_marker_minus) (list_marker_star)
  (list_marker_dot) (list_marker_parenthesis)
] @markup.list
(task_list_marker_checked) @markup.strong
(task_list_marker_unchecked) @punctuation
(thematic_break) @punctuation.special

(block_quote_marker) @markup.quote
(block_continuation) @comment

(link_destination) @markup.link.url
(link_label) @markup.link
(link_title) @string
(link_reference_definition) @markup.link

(pipe_table_header) @markup.strong
(pipe_table_delimiter_row) @punctuation

(backslash_escape) @string.escape
