/*
 * tags — find the tag-name range(s) of the JSX/HTML element enclosing a position,
 * so both halves of a tag pair can be renamed together (`tag:rename`). Pure (over
 * a tree-sitter node) so it's unit-testable.
 */

export interface TagName {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
  text: string;
}

// jsx_element / element wrap an opening + closing tag; the self-closing forms are
// their own tag. (Names handle members/namespaces; fragments have no name.)
const ELEMENT_TYPES = /^(jsx_element|jsx_self_closing_element|element|self_closing_tag)$/;
const TAG_TYPES = /opening_element|closing_element|start_tag|end_tag/;

/**
 * The tag-name ranges of the element enclosing `(row, column)`: the opening and
 * closing names (renamed together), or the single name of a self-closing tag.
 * Null when not on/inside a tag element, or a nameless fragment (`<></>`).
 */
export function tagNamesAt(root: any, row: number, column: number): TagName[] | null {
  let node: any = root.descendantForPosition({ row, column });
  while (node && !ELEMENT_TYPES.test(node.type)) node = node.parent;
  if (!node) return null;

  const names: TagName[] = [];
  const push = (n: any): void => {
    if (n) {
      names.push({
        startRow: n.startPosition.row, startColumn: n.startPosition.column,
        endRow: n.endPosition.row, endColumn: n.endPosition.column, text: n.text,
      });
    }
  };

  if (/self_closing/.test(node.type)) {
    push(node.childForFieldName('name'));
  } else {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && TAG_TYPES.test(c.type)) push(c.childForFieldName('name'));
    }
  }
  return names.length ? names : null;
}
