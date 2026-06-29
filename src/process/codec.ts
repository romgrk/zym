/*
 * process/codec.ts — binary length-prefixed framing for the process-runner IPC.
 *
 * Deliberately not JSON: a process's stdout/stderr can be tens of MiB (a big
 * `git diff`, a file listing), and JSON.stringify would escape every byte of it
 * into a new string on each side of the pipe. Here the payloads travel as raw
 * bytes — no copy beyond the framing, no escaping, no parse.
 *
 * Wire format. Every frame is `[u32 LE body-length][body]`; the body is a packed
 * sequence of fields written/read in lock-step by the two endpoints:
 *   - u8 / u32 / i32 — fixed-width little-endian integers.
 *   - bytes — a `[u32 LE length][raw bytes]` blob.
 *   - str   — a `bytes` field decoded as UTF-8.
 *
 * Every body starts with a `u8 kind` tag (`ReqKind`/`ResKind`) so the same pipe
 * carries both the one-shot buffered exchange and the streaming one.
 *
 * Requests (client → child):
 *   RUN / STREAM: u32 id, str file, str cwd, u32 argc, argc×str arg,
 *                 u8 hasInput, (hasInput? bytes input).
 *   CANCEL:       u32 id.                                  // kill a STREAM
 * Responses (child → client):
 *   RESULT:        u32 id, u8 ok, i32 code, bytes stdout, bytes stderr.  // RUN
 *   STDOUT/STDERR: u32 id, bytes chunk.                                  // STREAM
 *   END:           u32 id, u8 ok, i32 code (-1 = killed by signal).      // STREAM
 *
 * Shared verbatim by the client (`runner.ts`) and the child (`runner-main.ts`).
 */

/** Request kind, the first `u8` of every request body. */
export const ReqKind = { RUN: 0, STREAM: 1, CANCEL: 2 } as const;
/** Response kind, the first `u8` of every response body. */
export const ResKind = { RESULT: 0, STDOUT: 1, STDERR: 2, END: 3 } as const;

/** Accumulates a frame's fields, then emits the length-prefixed frame. */
export class FrameWriter {
  private parts: Buffer[] = [];
  private len = 0;

  u8(n: number): this {
    const b = Buffer.allocUnsafe(1);
    b.writeUInt8(n & 0xff, 0);
    return this.push(b);
  }
  u32(n: number): this {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(n >>> 0, 0);
    return this.push(b);
  }
  i32(n: number): this {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32LE(n | 0, 0);
    return this.push(b);
  }
  bytes(buf: Buffer): this {
    this.u32(buf.length);
    return this.push(buf);
  }
  str(s: string): this {
    return this.bytes(Buffer.from(s, 'utf8'));
  }

  private push(b: Buffer): this {
    this.parts.push(b);
    this.len += b.length;
    return this;
  }

  /** The accumulated body prefixed with its u32 length — a complete frame. */
  frame(): Buffer {
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(this.len, 0);
    return Buffer.concat([header, ...this.parts], 4 + this.len);
  }
}

/** Sequentially reads the fields of one frame body (as written by FrameWriter). */
export class FrameReader {
  private off = 0;
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }

  u8(): number {
    const v = this.buf.readUInt8(this.off);
    this.off += 1;
    return v;
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }
  i32(): number {
    const v = this.buf.readInt32LE(this.off);
    this.off += 4;
    return v;
  }
  bytes(): Buffer {
    const n = this.u32();
    const b = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }
  str(): string {
    return this.bytes().toString('utf8');
  }
}

/** A stateful stream splitter: feed it chunks, it calls `onFrame` once per
 *  complete frame with the body (the u32 length prefix stripped). */
export function makeFrameParser(onFrame: (body: Buffer) => void): (chunk: Buffer) => void {
  let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      onFrame(buf.subarray(4, 4 + len));
      buf = buf.subarray(4 + len);
    }
  };
}
