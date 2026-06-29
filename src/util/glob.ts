/*
 * Generic glob matching, shared across the app (the LSP file-watchers in
 * `src/lsp/glob.ts`, the diff file filter, …). Supports the common subset: `**`
 * (any path segments), `*` (within a segment), `?` (one non-separator char), and
 * `{a,b}` alternation. Paths compare with forward slashes.
 */
const REGEX_SPECIALS = /[.+^$()|[\]\\]/g;

/** Escape a literal run for inclusion in a RegExp source. */
export function escapeLiteral(text: string): string {
  return text.replace(REGEX_SPECIALS, '\\$&');
}

/** Convert a glob to an (unanchored) regex source matching a forward-slash path. */
export function globBody(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?'; // `**/` → zero or more path segments
        } else {
          out += '.*'; // `**` → anything, across separators
        }
      } else {
        out += '[^/]*'; // `*` → within one segment
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        out += '\\{';
      } else {
        out += `(?:${glob.slice(i + 1, end).split(',').map(escapeLiteral).join('|')})`;
        i = end;
      }
    } else {
      out += escapeLiteral(c);
    }
  }
  return out;
}

/** Compile a glob to an anchored RegExp matching a (relative) forward-slash path. */
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globBody(glob.replace(/\\/g, '/'))}$`);
}

/** A compiled comma-separated glob filter (see `compileGlobFilter`). */
export interface GlobFilter {
  /** Whether `path` is selected by the filter. */
  test(path: string): boolean;
  /** No terms were parsed (a blank pattern) — `test` always returns false. */
  isEmpty: boolean;
}

interface Term {
  re: RegExp;
  negate: boolean;
  /** Match the whole relative path (a `/` in the term) vs. just the basename. */
  full: boolean;
}

/**
 * Compile a **comma-separated** glob pattern into a path filter. Each term is a
 * glob; a `!` prefix negates it. A term containing `/` matches the whole relative
 * path; one without (e.g. `*.ts`) matches the basename at any depth — so `*.ts`
 * catches `src/ui/x.ts` the way users expect.
 *
 * A path is selected when it matches at least one positive term (or there are no
 * positive terms — only exclusions) AND no negative term. So `*.ts, !*.test.ts`
 * is "every .ts except tests", and `!*.md` is "everything but markdown".
 */
export function compileGlobFilter(pattern: string): GlobFilter {
  const terms: Term[] = [];
  for (const raw of pattern.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const negate = trimmed[0] === '!';
    const glob = (negate ? trimmed.slice(1) : trimmed).trim();
    if (!glob) continue;
    terms.push({ re: globToRegExp(glob), negate, full: glob.includes('/') });
  }
  const positives = terms.filter((t) => !t.negate);
  const negatives = terms.filter((t) => t.negate);
  const test = (path: string): boolean => {
    const p = path.replace(/\\/g, '/');
    const base = p.slice(p.lastIndexOf('/') + 1);
    const hit = (t: Term) => t.re.test(t.full ? p : base);
    if (negatives.some(hit)) return false; // an exclusion always wins
    return positives.length === 0 ? negatives.length > 0 : positives.some(hit);
  };
  return { test, isEmpty: terms.length === 0 };
}
