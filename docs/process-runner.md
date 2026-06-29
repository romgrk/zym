# Process runner

`src/process/runner.ts` (+ `runner-main.ts`, `codec.ts`) is the generic spawn
broker. The long-lived ~1.5 GB node-gtk process must never `fork()`: this Node's
libuv has no `posix_spawn` fast path, so fork cost scales with RSS (tens of
ms/spawn). Instead the parent forks one tiny child once, and that child runs
every command (~1 ms each).

- `runProcess({ file, args, cwd, input }, onDone)` is async-only and **buffered**:
  one reply with the whole stdout/stderr.
- `runProcessStream(spec, { onStdout, onStderr, onDone })` **streams**: chunks arrive
  as the command runs, and the returned handle's `cancel()` kills it (no further
  callbacks). Project search uses it so matches render as they arrive and a new query
  cancels the in-flight `rg`. The wire format is kind-tagged frames (`ReqKind`/`ResKind`
  in `codec.ts`).
- IPC is **binary, length-prefixed** (no JSON): stdout/stderr cross the pipe as
  raw bytes, up to 64 MiB.
- git (`git/cli.ts`), gh (`github.ts`), and project search (ripgrep, via
  `ui/multibuffer/projectSearch.ts`) all route through it; any subsystem that
  shells out reuses the same primitive.
- A direct-spawn fallback runs the command in-process if the child is down.
- **Gotcha — the child gives every command a *pipe* on stdin** (execFile's
  default), which looks like a readable FIFO. A tool that reads stdin when it's
  not a tty will then block forever waiting on input that never comes. ripgrep
  is the classic case: with no path argument it searches stdin, so project
  search always passes an explicit `.` path (`projectSearch.ts`) to force a
  directory search. Pass `input` (closing stdin) or an explicit path/target for
  any stdin-sensitive tool.

Tested in `src/process/runner.test.ts`.
