/*
 * The Python plugin — Python support: file detection, a tree-sitter grammar
 * (highlighting + folding), and language servers (pyright + ruff).
 *
 * Grammar:
 *  - Uses `tree-sitter-python`, already shipped in the bundled `tree-sitter-wasms`
 *    pack (resolved by module specifier, like the Rust / C / JSON grammars). The
 *    highlights/folds queries are vendored under `queries/python/`.
 *
 * Servers:
 *  - `pyright` is the canonical type-checking language server (completion, hover,
 *    diagnostics, go-to). It ships as an npm package (`pyright`, binary
 *    `pyright-langserver`), so its `install` spec is a plain `{ via: 'npm' }`. It
 *    works per-file, so `singleFile` lets it activate on a loose script; a project
 *    root (`pyproject.toml` / `pyrightconfig.json` / …) is preferred when present.
 *    `python-lsp-server` (pylsp) is a same-group alternative at lower priority, so
 *    it only runs when pyright is absent.
 *  - `ruff` is the fast linter/formatter server (`ruff server`), additive
 *    (ungrouped) alongside pyright/pylsp.
 *
 * Install of the pip-only servers (ruff, pylsp): neither ships an npm package, and
 * the managed-install search path is only `<server>/node_modules/.bin`, so a bare
 * `pip install` elsewhere wouldn't be found. Their `install` specs use the raw
 * `{ command }` escape hatch (run in the server's managed dir) to build a
 * self-contained venv there and symlink its console script into `node_modules/.bin`
 * — staying inside the managed tree, never touching the user's global env. Needs
 * `python3`; if it (or a server) is absent, the server is simply skipped.
 */
import type { Plugin, PluginContext } from '../../src/plugin/types.ts';
import type { InstallSpec, ServerDef } from '../../src/lang/types.ts';

// Build an install spec for a pip-only server: create a venv in the managed dir,
// install the package into it, then symlink its console script into the
// `node_modules/.bin` the manager searches. Relative symlink target: from
// `<dir>/node_modules/.bin/` up to `<dir>/venv/bin/<binary>` is `../../venv/bin/…`.
function pipVenvInstall(pkg: string, binary: string): InstallSpec {
  return {
    command: ['sh', '-c',
      `python3 -m venv venv && venv/bin/pip install --upgrade ${pkg} && ` +
      `mkdir -p node_modules/.bin && ln -sf ../../venv/bin/${binary} node_modules/.bin/${binary}`],
  };
}

// Tree-sitter node types that fold when they span more than one line — suite
// bodies and bracketed collections. `foldTypes` is the fallback if a query file
// is missing; `folds.scm` is the real source (it also folds multi-line strings
// and comments).
const PYTHON_FOLD_TYPES = [
  'block', 'dictionary', 'list', 'set', 'tuple', 'argument_list',
  'parameters', 'parenthesized_expression',
];

// Markers that locate a Python project root. The usual packaging/tooling files.
const PYTHON_ROOTS = [
  'pyproject.toml', 'pyrightconfig.json', 'setup.py', 'setup.cfg',
  'requirements.txt', 'Pipfile', 'poetry.lock', '.git',
];

// pyright (https://github.com/microsoft/pyright) — Microsoft's type-checking LSP:
// completion, hover, diagnostics, go-to. Ships on npm (binary
// `pyright-langserver`), so it carries an install spec. `singleFile` lets it run
// on a loose script; a project root is preferred when found.
const PYRIGHT: ServerDef = {
  name: 'pyright',
  command: 'pyright-langserver',
  args: ['--stdio'],
  roots: PYTHON_ROOTS,
  singleFile: true,
  group: 'python-types',
  priority: 20,
  install: { via: 'npm', package: 'pyright' },
};

// python-lsp-server (pylsp) — the community plugin-host LSP, an alternative to
// pyright. A pip package (no npm), so it installs via the venv escape hatch; same
// exclusion group at lower priority, so it only runs when pyright isn't available.
const PYLSP: ServerDef = {
  name: 'pylsp',
  command: 'pylsp',
  roots: PYTHON_ROOTS,
  singleFile: true,
  group: 'python-types',
  priority: 10,
  install: pipVenvInstall('python-lsp-server', 'pylsp'),
};

// ruff (https://docs.astral.sh/ruff) — the fast linter/formatter language server.
// A pip package (no real npm package — the npm `ruff` is an unrelated library), so
// it installs via the venv escape hatch; ungrouped, so it runs additively
// alongside pyright/pylsp. Skipped if absent and not installed.
const RUFF: ServerDef = {
  name: 'ruff',
  command: 'ruff',
  args: ['server'],
  roots: PYTHON_ROOTS,
  singleFile: true,
  install: pipVenvInstall('ruff', 'ruff'),
};

export const pythonPlugin: Plugin = {
  id: 'python',
  name: 'Python',
  description: 'Python: tree-sitter grammar (highlighting + folding) and language servers (pyright, pylsp, ruff).',

  activate(ctx: PluginContext) {
    const { languages } = ctx;

    // `python` is already a valid LSP languageId, so no lspId override.
    languages.registerLanguage({
      id: 'python',
      fileTypes: ['py', 'pyi', 'pyw'],
      comments: { line: '#' },
    });
    languages.registerGrammar('python', {
      wasm: 'tree-sitter-wasms/out/tree-sitter-python.wasm',
      highlightsPath: ctx.resolve('queries/python/highlights.scm'),
      foldTypes: PYTHON_FOLD_TYPES,
      foldsPath: ctx.resolve('queries/python/folds.scm'),
    });
    languages.registerServer('python', PYRIGHT);
    languages.registerServer('python', PYLSP);
    languages.registerServer('python', RUFF);
  },
};
