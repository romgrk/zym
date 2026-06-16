/*
 * folds — compute foldable line ranges from the tree, kept pure so it's
 * unit-testable. Two sources:
 *
 *  - **Block folds**: a grammar's `folds.scm` query (`@fold` captures — incl.
 *    multi-line comments), or, when it ships none, the `foldTypes` node-type set.
 *  - **Run folds**: a run of >= 2 consecutive same-type siblings the grammar folds
 *    as a block (import statements, line comments) — collapse to the first line.
 *
 * A range `{startRow, endRow}` keeps `startRow` visible and hides
 * `startRow+1 .. endRow-1` when folded (SyntaxController.toggleFold), so a block's
 * closing-bracket line stays visible; a run's `endRow` is the line *after* the run
 * so everything but the first line collapses. Only ranges hiding >= 1 line are
 * kept, and at most one per start line (first wins).
 */

export interface FoldRange {
  startRow: number;
  endRow: number;
}

export function computeFoldRanges(
  root: any,
  foldsQuery: any | null,
  foldTypes: Set<string>,
  runTypeRe: RegExp,
): FoldRange[] {
  const seen = new Set<number>();
  const ranges: FoldRange[] = [];
  const add = (startRow: number, endRow: number): void => {
    if (endRow - startRow >= 2 && !seen.has(startRow)) {
      seen.add(startRow);
      ranges.push({ startRow, endRow });
    }
  };

  if (foldsQuery) {
    for (const cap of foldsQuery.captures(root)) {
      add(cap.node.startPosition.row, cap.node.endPosition.row);
    }
  } else {
    walkFoldTypes(root, foldTypes, add);
  }
  walkRuns(root, runTypeRe, add);

  ranges.sort((a, b) => a.startRow - b.startRow);
  return ranges;
}

function walkFoldTypes(node: any, foldTypes: Set<string>, add: (s: number, e: number) => void): void {
  if (foldTypes.has(node.type)) add(node.startPosition.row, node.endPosition.row);
  for (const child of node.namedChildren) if (child) walkFoldTypes(child, foldTypes, add);
}

/** Fold maximal runs of >= 2 consecutive same-type siblings matching `re`. */
function walkRuns(node: any, re: RegExp, add: (s: number, e: number) => void): void {
  const children: any[] = node.namedChildren;
  let i = 0;
  while (i < children.length) {
    const c = children[i];
    if (c && re.test(c.type)) {
      let j = i;
      while (j + 1 < children.length && children[j + 1] && children[j + 1].type === c.type) j++;
      // endRow = last member's row + 1 → folding hides every line but the first.
      if (j > i) add(children[i].startPosition.row, children[j].endPosition.row + 1);
      i = j + 1;
    } else {
      if (c) walkRuns(c, re, add);
      i++;
    }
  }
}
