// Minimal dependency-free CDP client: node cdp.mjs <port> <js-expression>
// Evaluates the expression in the inspected app (awaits promises) and prints the result JSON.
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.argv[2]);
const expression = process.argv[3];

const list = await new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject);
});
const wsUrl = new URL(list[0].webSocketDebuggerUrl);

const key = crypto.randomBytes(16).toString('base64');
const sock = net.connect(Number(wsUrl.port), '127.0.0.1');
await new Promise((r) => sock.on('connect', r));
sock.write(
  `GET ${wsUrl.pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
  `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
);

let buf = Buffer.alloc(0);
let handshaken = false;
const messages = [];
let onMessage = null;

sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (!handshaken) {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    handshaken = true;
    buf = buf.subarray(end + 4);
  }
  while (buf.length >= 2) {
    const len7 = buf[1] & 0x7f;
    let off = 2;
    let len = len7;
    if (len7 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
    else if (len7 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) return;
    const payload = buf.subarray(off, off + len);
    buf = buf.subarray(off + len);
    const opcode = buf === null ? 0 : undefined; // (opcode from first byte below)
    const op = 0x0f & (payload.__op ?? 0); // placeholder, real opcode read next line
    void opcode; void op;
    const text = payload.toString('utf8');
    try {
      const msg = JSON.parse(text);
      messages.push(msg);
      onMessage?.(msg);
    } catch { /* control frame / non-JSON — ignore */ }
  }
});

function send(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  sock.write(Buffer.concat([header, mask, masked]));
}

function call(method, params) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const prev = onMessage;
    onMessage = (msg) => {
      if (msg.id === id) { onMessage = prev; resolve(msg); }
      else prev?.(msg);
    };
    send({ id, method, params });
    setTimeout(() => reject(new Error('CDP call timeout')), 30000);
  });
}

const res = await call('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
  replMode: true,
});
const r = res.result;
if (r?.exceptionDetails || res.error) {
  console.error(JSON.stringify(r?.exceptionDetails ?? res.error));
  process.exit(1);
}
console.log(JSON.stringify(r?.result?.value ?? r?.result ?? null));
sock.destroy();
process.exit(0);
