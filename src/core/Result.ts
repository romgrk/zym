/*
 * Result<T> — an explicit success-or-failure value, the alternative to throwing.
 *
 * It's a discriminated union of `Ok<T>` (carries `data`) and `Err` (carries an
 * `Error`). The value-accessors are split across the two arms on purpose:
 *
 *   - `unwrap()`    lives only on `Ok`  — you can't call it until you've proven
 *                                          (via `isOk()`) that you hold a success.
 *   - `unwrapErr()` lives only on `Err` — likewise for the failure.
 *
 * Because a bare `Result<T>` has neither, every place that wants the value has to
 * branch on `isOk()` / `isErr()` first; forgetting the failure path becomes a
 * compile error rather than a runtime surprise. When you genuinely hold an
 * un-narrowed `Result<T>` and want the value anyway, `unsafe_unwrap()` throws on
 * `Err` — the deliberately ugly escape hatch.
 */

abstract class ResultBase<T> {
  abstract readonly ok: boolean

  /** True, and narrows `this` to `Ok<T>`, when this is a success. */
  isOk(): this is Ok<T> {
    return this.ok === true
  }

  /** True, and narrows `this` to `Err`, when this is a failure. */
  isErr(): this is Err {
    return this.ok === false
  }

  /** The success value, or `fallback` on `Err`. Always safe — no narrowing needed. */
  unwrapOrElse<S>(fallback: S): T | S {
    return this.ok ? (this as unknown as Ok<T>).data : fallback
  }

  /** The success value without a static `Ok` proof; throws on `Err`. Prefer
   *  narrowing with `isOk()` then `unwrap()` — reach for this only when you truly
   *  can't narrow. */
  unsafe_unwrap(): T {
    if (!this.ok)
      throw new Error('Result.unsafe_unwrap() called on an Err')
    return (this as unknown as Ok<T>).data
  }

  /** The error without a static `Err` proof; throws on `Ok`. */
  unsafe_unwrapErr(): Error {
    if (this.ok)
      throw new Error('Result.unsafe_unwrapErr() called on an Ok')
    return (this as unknown as Err).error
  }

  /** Map the success value, passing an `Err` through unchanged. */
  map<S>(fn: (value: T) => S): Result<S> {
    if (!this.ok)
      return (this as unknown as Err)
    return new Ok(fn((this as unknown as Ok<T>).data))
  }
}

class Ok<T> extends ResultBase<T> {
  readonly ok = true
  data: T
  constructor(data: T) {
    super()
    this.data = data
  }
  /** The success value. Only reachable once narrowed to `Ok`. */
  unwrap(): T {
    return this.data
  }
}

class Err extends ResultBase<never> {
  readonly ok = false
  error: Error
  constructor(error: Error) {
    super()
    this.error = error
  }
  /** The error. Only reachable once narrowed to `Err`. */
  unwrapErr(): Error {
    return this.error
  }
}

/** A success (`Ok<T>`) or a failure (`Err`). Narrow with `isOk()` / `isErr()`
 *  before reaching for `unwrap()` / `unwrapErr()`. */
type Result<T> = Ok<T> | Err

// Companion value: constructors + combinators, sharing the `Result` name with the
// type above (TypeScript keeps the type and value namespaces separate).
const Result = {
  Ok<T>(data: T): Ok<T> {
    return new Ok(data)
  },
  Err(error: Error): Err {
    return new Err(error)
  },

  /** Wrap a plain value: an `Error` becomes `Err`, anything else `Ok`. */
  from<T>(value: T | Error): Result<T> {
    if (value instanceof Error)
      return new Err(value)
    return new Ok(value)
  },

  /** Settle a promise into a `Result`: resolution → `Ok`, rejection → `Err`. */
  asPromise<N>(promise: Promise<N>): Promise<Result<N>> {
    return promise
      .then((value): Result<N> => new Ok(value))
      .catch((error): Result<N> => new Err(error))
  },

  /** Collapse an array of results: the first `Err` short-circuits, otherwise an
   *  `Ok` of every value. */
  fromArray<N>(results: Result<N>[]): Result<N[]> {
    const values: N[] = []
    for (const result of results) {
      if (result.isErr())
        return result
      values.push(result.unwrap())
    }
    return new Ok(values)
  },
}

export { Ok, Err, Result }
export default Result
