; HTML — quilx palette (Zed capture names). Only the markup structure is styled
; here; the contents of <script> and <style> are re-highlit by the injected
; JavaScript / CSS grammars (see the plugin's injections).

(tag_name) @tag
(erroneous_end_tag_name) @tag

(attribute_name) @attribute
[
  (attribute_value)
  (quoted_attribute_value)
] @string

(comment) @comment
(doctype) @constant

; Character references (`&amp;`, `&#x1F600;`).
(entity) @constant.character

[
  "<"
  ">"
  "</"
  "/>"
  "<!"
] @punctuation.bracket

"=" @punctuation.delimiter
