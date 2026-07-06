import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Point } from '../text/Point.ts';
import { Disposable, type DisposableLike } from '../util/eventKit.ts';
import { GlobalJumpList, type GlobalJumpListDeps, type JumpEditor } from './GlobalJumpList.ts';

class FakeEditor implements JumpEditor {
  currentFile: string | null;
  cursor = new Point(0, 0);
  private handlers: Array<(p: Point) => void> = [];
  private cursorHandlers: Array<() => void> = [];
  constructor(path: string | null) {
    this.currentFile = path;
  }
  getCursorBufferPosition(): Point {
    return this.cursor;
  }
  onDidRecordJump(fn: (p: Point) => void): DisposableLike {
    this.handlers.push(fn);
    return new Disposable(() => {
      this.handlers = this.handlers.filter((h) => h !== fn);
    });
  }
  onDidChangeCursorPosition(fn: () => void): DisposableLike {
    this.cursorHandlers.push(fn);
    return new Disposable(() => {
      this.cursorHandlers = this.cursorHandlers.filter((h) => h !== fn);
    });
  }
  /** Emit a vim jump recording of the departed `row`, like a flagged/big motion. */
  recordJump(row: number, column = 0): void {
    for (const h of [...this.handlers]) h(new Point(row, column));
  }
  /** Move the caret and fire the change signal, like a real cursor move (search
   *  `*`/`n`, in-file `g d`, or a keyboard motion). */
  moveCursor(row: number, column = 0): void {
    this.cursor = new Point(row, column);
    for (const h of [...this.cursorHandlers]) h();
  }
}

function setup() {
  const editors: FakeEditor[] = [];
  const observers: Array<(e: JumpEditor) => DisposableLike | void> = [];
  const activeSubs: Array<(e: JumpEditor | null) => void> = [];
  let active: FakeEditor | null = null;
  const opened: Array<{ path: string; cursor?: [number, number] }> = [];
  const deps: GlobalJumpListDeps = {
    observeTextEditors(cb) {
      observers.push(cb);
      for (const e of editors) cb(e);
      return new Disposable(() => {});
    },
    onDidChangeActiveTextEditor(cb) {
      activeSubs.push(cb);
      return new Disposable(() => {});
    },
    getActiveTextEditor: () => active,
    openFile(path, options) {
      opened.push({ path, cursor: options?.cursor });
      // Simulate the app: reveal the file's editor and place its cursor.
      const e = editors.find((ed) => ed.currentFile === path);
      if (e) {
        active = e;
        if (options?.cursor) e.cursor = new Point(options.cursor[0], options.cursor[1]);
      }
    },
  };
  const lastOpened = () => opened[opened.length - 1];
  const list = new GlobalJumpList(deps);
  const addEditor = (path: string | null) => {
    const e = new FakeEditor(path);
    editors.push(e);
    for (const o of observers) o(e);
    return e;
  };
  const setActive = (e: FakeEditor | null) => {
    active = e;
    for (const cb of [...activeSubs]) cb(e);
  };
  return { list, addEditor, setActive, opened, lastOpened };
}

test('global jump list: walks vim jumps across editors', () => {
  const { list, addEditor, setActive, opened, lastOpened } = setup();
  const a = addEditor('/p/a.ts');
  const b = addEditor('/p/b.ts');
  setActive(a);
  a.recordJump(10); // a G-style jump in a.ts departed line 10
  a.cursor = new Point(90, 0);
  setActive(b); // tab switch records the position left in a.ts (90)
  b.recordJump(5);
  b.cursor = new Point(20, 0);

  list.goBackward(); // stashes b:20, lands on b:5
  assert.deepEqual(lastOpened(), { path: '/p/b.ts', cursor: [5, 0] });
  list.goBackward(); // crosses into a.ts at the departure point
  assert.deepEqual(lastOpened(), { path: '/p/a.ts', cursor: [90, 0] });
  list.goBackward();
  assert.deepEqual(lastOpened(), { path: '/p/a.ts', cursor: [10, 0] });
  list.goBackward(); // oldest — no-op
  assert.equal(opened.length, 3);

  list.goForward();
  assert.deepEqual(lastOpened(), { path: '/p/a.ts', cursor: [90, 0] });
  list.goForward();
  list.goForward(); // back to the stashed present in b.ts
  assert.deepEqual(lastOpened(), { path: '/p/b.ts', cursor: [20, 0] });
  list.dispose();
});

test('global jump list: navigation does not record itself as a departure', () => {
  const { list, addEditor, setActive, lastOpened } = setup();
  const a = addEditor('/p/a.ts');
  const b = addEditor('/p/b.ts');
  setActive(a);
  a.cursor = new Point(30, 0);
  setActive(b); // records a:30
  b.cursor = new Point(7, 0);

  list.goBackward(); // stash b:7, land a:30 — the app then fires a tab change
  setActive(a); // no-op: open() already re-synced lastActive
  list.goForward(); // forward history intact
  assert.deepEqual(lastOpened(), { path: '/p/b.ts', cursor: [7, 0] });
  list.dispose();
});

test('global jump list: a fresh jump mid-walk drops forward history', () => {
  const { list, addEditor, setActive, lastOpened } = setup();
  const a = addEditor('/p/a.ts');
  setActive(a);
  a.recordJump(10);
  a.recordJump(20);
  a.cursor = new Point(50, 0);

  list.goBackward(); // stash a:50, land a:20
  list.goBackward(); // land a:10
  a.recordJump(33); // a new jump — forward entries (20, 50) are dropped
  list.goForward(); // nothing newer
  assert.deepEqual(lastOpened(), { path: '/p/a.ts', cursor: [10, 0] });
  list.goBackward(); // stashes the present and returns to 33's departure
  assert.deepEqual(lastOpened(), { path: '/p/a.ts', cursor: [33, 0] });
  list.dispose();
});

test('global jump list: pathless editors (scratch/diff) never record', () => {
  const { list, addEditor, setActive, opened } = setup();
  const scratch = addEditor(null);
  const a = addEditor('/p/a.ts');
  setActive(scratch);
  scratch.recordJump(40);
  setActive(a); // departure from a pathless editor is skipped
  list.goBackward();
  assert.equal(opened.length, 0);
  list.dispose();
});

test('global jump list: a far caret move (search `*`) records without a vim jump', () => {
  const { list, addEditor, setActive, lastOpened } = setup();
  const a = addEditor('/p/a.ts');
  a.cursor = new Point(10, 2); // on a word, pre-positioned (no departure recorded)
  setActive(a);
  a.moveCursor(40, 5); // `*` seats the next match far away — no onDidRecordJump fires

  list.goBackward(); // stash 40, land back on the pre-search spot
  assert.deepEqual(lastOpened(), { path: '/p/a.ts', cursor: [10, 2] });
  list.goForward();
  assert.deepEqual(lastOpened(), { path: '/p/a.ts', cursor: [40, 5] });
  list.dispose();
});

test('global jump list: intermediary same-file jumps are all walkable', () => {
  const { list, addEditor, setActive, lastOpened, opened } = setup();
  const a = addEditor('/p/a.ts');
  const b = addEditor('/p/b.ts');
  a.cursor = new Point(10, 0);
  setActive(a);
  a.moveCursor(60, 0); // `*` #1: records 10
  a.moveCursor(120, 0); // `*` #2: records 60
  setActive(b); // cross-editor: records the spot left in a (120)

  list.goBackward(); // stash b's present, land where we left a
  assert.deepEqual(lastOpened(), { path: '/p/a.ts', cursor: [120, 0] });
  list.goBackward(); // intermediary jump — not skipped
  assert.deepEqual(lastOpened(), { path: '/p/a.ts', cursor: [60, 0] });
  list.goBackward();
  assert.deepEqual(lastOpened(), { path: '/p/a.ts', cursor: [10, 0] });
  void opened;
  list.dispose();
});

test('global jump list: a small caret move is not a jump', () => {
  const { list, addEditor, setActive, opened } = setup();
  const a = addEditor('/p/a.ts');
  a.cursor = new Point(10, 0);
  setActive(a);
  a.moveCursor(13, 0); // 3 rows — under the threshold, incremental navigation
  list.goBackward();
  assert.equal(opened.length, 0);
  list.dispose();
});

test('global jump list: a near search hint records what the distance filter misses', () => {
  const { list, addEditor, setActive, lastOpened } = setup();
  const a = addEditor('/p/a.ts');
  a.cursor = new Point(10, 0);
  setActive(a);
  // `n` lands on a match 3 lines away — too short for the caret-distance detector,
  // but the search hint records the departure anyway (order mirrors the app: the
  // caret moves, then TextEditor emits the hint).
  a.moveCursor(13, 0); // observer: 3 < threshold → no record
  a.recordJump(10); // search hint → records the departed line 10

  list.goBackward();
  assert.deepEqual(lastOpened(), { path: '/p/a.ts', cursor: [10, 0] });
  list.dispose();
});

test('global jump list: a vim-announced jump is recorded once, not twice', () => {
  const { list, addEditor, setActive, lastOpened, opened } = setup();
  const a = addEditor('/p/a.ts');
  a.cursor = new Point(10, 0);
  setActive(a);
  // A vim `G`: the caret moves far *and* the vim layer announces the same
  // departure — the two must collapse to a single entry.
  a.moveCursor(99, 0);
  a.recordJump(10);

  list.goBackward();
  assert.deepEqual(lastOpened(), { path: '/p/a.ts', cursor: [10, 0] });
  list.goBackward(); // no older entry survives — the duplicate was deduped
  assert.equal(opened.length, 1);
  list.dispose();
});

test('global jump list: caret moves in an unfocused editor never record', () => {
  const { list, addEditor, setActive, opened } = setup();
  const a = addEditor('/p/a.ts');
  const b = addEditor('/p/b.ts');
  a.cursor = new Point(5, 0);
  setActive(a);
  b.moveCursor(80, 0); // a background caret move (e.g. an agent editing b) — ignored
  list.goBackward();
  assert.equal(opened.length, 0);
  list.dispose();
});

test('global jump list: async caret restore into a reopened tab keeps forward history', () => {
  // A jump into a not-yet-loaded file (a closed tab) restores its caret
  // asynchronously — the settling move must not read as a fresh jump (which would
  // drop the forward history and break `ctrl-i`). Custom harness: b.ts is
  // "unloaded", so opening it does NOT place the caret until `bLoaded` flips.
  const a = new FakeEditor('/p/a.ts');
  const b = new FakeEditor('/p/b.ts');
  a.cursor = new Point(5, 0);
  let active: FakeEditor | null = null;
  const activeSubs: Array<(e: JumpEditor | null) => void> = [];
  const opened: Array<{ path: string; cursor?: [number, number] }> = [];
  let bLoaded = false;
  const deps: GlobalJumpListDeps = {
    observeTextEditors(cb) {
      cb(a);
      cb(b);
      return new Disposable(() => {});
    },
    onDidChangeActiveTextEditor(cb) {
      activeSubs.push(cb);
      return new Disposable(() => {});
    },
    getActiveTextEditor: () => active,
    openFile(path, options) {
      opened.push({ path, cursor: options?.cursor });
      const e = path === '/p/a.ts' ? a : b;
      active = e;
      for (const cb of [...activeSubs]) cb(e);
      // a is loaded (caret lands synchronously); b's caret lands only once loaded.
      if (options?.cursor && (e === a || bLoaded)) e.moveCursor(options.cursor[0], options.cursor[1]);
    },
  };
  const list = new GlobalJumpList(deps);
  const setActive = (e: FakeEditor | null) => {
    active = e;
    for (const cb of [...activeSubs]) cb(e);
  };
  const lastOpened = () => opened[opened.length - 1];

  setActive(a);
  a.moveCursor(80, 0); // far jump → records a:5
  setActive(b); // cross-file → records a:80
  b.moveCursor(40, 0); // far jump in b → records b:0
  setActive(a); // records b:40 ; entries: [a:5, a:80, b:40]

  b.cursor = new Point(0, 0); // b's tab closed & reopened fresh at the top
  list.goBackward(); // stash a:80, open b:40 — but b is unloaded, caret still at 0
  assert.deepEqual(lastOpened(), { path: '/p/b.ts', cursor: [40, 0] });
  bLoaded = true;
  b.moveCursor(40, 0); // the async load applies the saved caret — must NOT record

  list.goForward(); // forward history intact: back to the stashed present in a
  assert.deepEqual(lastOpened(), { path: '/p/a.ts', cursor: [80, 0] });
  list.dispose();
});
