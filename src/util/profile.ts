/*
 * profile.ts — a zero-cost-by-default timing helper for diagnosing slow paths (currently project
 * search). Enabled with `ZYM_SEARCH_PROFILE=1`; otherwise `prof` just runs the function and the
 * logs never fire. Not a general metrics system — a debug aid you reach for when something stalls.
 */
const ON = !!process.env.ZYM_SEARCH_PROFILE;

/** Run `fn`, and (when profiling is on) log how long it took if it's over ~0.5ms. */
export function prof<T>(label: string, fn: () => T): T {
  if (!ON) return fn();
  const start = process.hrtime.bigint();
  try {
    return fn();
  } finally {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (ms >= 0.5) console.log(`[search] ${label}: ${ms.toFixed(1)}ms`);
  }
}

/** Log a profiling message (no-op unless profiling is on). */
export function profLog(message: string): void {
  if (ON) console.log(`[search] ${message}`);
}
