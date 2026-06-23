// Exercises style hot-reload end to end: a fixture file installs CSS via the real
// `addStyles`, gets watched, and editing it swaps the sheet — while a syntax error
// mid-edit rolls back to the last working version. The flow (caller detection →
// chokidar watch → debounce → cache-busted re-import → provider swap / rollback)
// is observed through the `[styles]` console output, so nothing private is poked.
// The display is absent under `node --test`, so providers are created but not
// attached — fine, the swap/rollback logic is what matters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Gtk } from './gi.ts';
import { styles, installStyles } from './styles.ts';
import { tmpDir } from './util/testTmp.ts';

Gtk.init(); // idempotent

const STYLES_URL = pathToFileURL(fileURLToPath(new URL('./styles.ts', import.meta.url))).href;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wait until `predicate()` holds, polling briefly. Real FS watching + debounce
// makes the reload asynchronous, so we poll rather than sleep a fixed time.
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) await sleep(20);
  return predicate();
}

test('hot-reload swaps a watched file’s styles, and rolls back on a load error', async (t) => {
  const dir = tmpDir('styles-hot-reload');
  const fixture = Path.join(dir, 'fixture.ts');
  const probe = (color: string) =>
    `import { addStyles } from ${JSON.stringify(STYLES_URL)};\n` +
    `addStyles('#HotReloadProbe { color: ${color}; }');\n`;

  // Capture the manager's reload logging.
  const logs: string[] = [];
  const info = console.info, warn = console.warn;
  console.info = (...a: unknown[]) => { logs.push(`info ${a.join(' ')}`); };
  console.warn = (...a: unknown[]) => { logs.push(`warn ${a.join(' ')}`); };
  t.after(() => { console.info = info; console.warn = warn; styles.stopHotReload(); });

  const reloaded = () => logs.some((l) => l.startsWith('info') && l.includes('reloaded'));
  const failed = () => logs.some((l) => l.startsWith('warn') && l.includes('hot-reload failed'));

  // Activate the manager (starts the watcher) and import the fixture, whose
  // addStyles call gets the fixture file tracked and watched.
  installStyles();
  Fs.writeFileSync(fixture, probe('rgb(1, 1, 1)'));
  await import(pathToFileURL(fixture).href);
  await sleep(200); // let chokidar arm the watch

  // 1) A valid edit reloads.
  logs.length = 0;
  Fs.writeFileSync(fixture, probe('rgb(2, 2, 2)'));
  assert.ok(await waitFor(reloaded), `expected a reload, got: ${JSON.stringify(logs)}`);

  // 2) A syntax error rolls back: it warns and reports no success.
  await sleep(150);
  logs.length = 0;
  Fs.writeFileSync(fixture, 'export const broken = ;\n');
  assert.ok(await waitFor(failed), `expected a rollback warning, got: ${JSON.stringify(logs)}`);
  assert.ok(!reloaded(), 'a failed reload must not report success');

  // 3) Fixing the file reloads again (recovery).
  await sleep(150);
  logs.length = 0;
  Fs.writeFileSync(fixture, probe('rgb(3, 3, 3)'));
  assert.ok(await waitFor(reloaded), `expected recovery reload, got: ${JSON.stringify(logs)}`);
});
