; Markdown inline — quilx palette + markup.* styling.
(code_span) @markup.raw
[ (emphasis_delimiter) (code_span_delimiter) ] @punctuation
(emphasis) @markup.emphasis
(strong_emphasis) @markup.strong
(strikethrough) @markup.strikethrough
(html_tag) @tag
[ (link_destination) (uri_autolink) ] @markup.link.url
[ (link_text) (image_description) ] @markup.link
(link_label) @markup.link
[ (backslash_escape) (hard_line_break) ] @string.escape
(image ["!" "[" "]" "(" ")"] @punctuation)
(inline_link ["[" "]" "(" ")"] @punctuation)
(shortcut_link ["[" "]"] @punctuation)
