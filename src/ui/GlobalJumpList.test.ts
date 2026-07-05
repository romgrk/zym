import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Point } from '../text/Point.ts';
import { Disposable, type DisposableLike } from '../util/eventKit.ts';
import { GlobalJumpList, type GlobalJumpListDeps, type JumpEditor } from './GlobalJumpList.ts';

class FakeEditor implements JumpEditor {
  currentFile: string | null;
  cursor = new Point(0, 0);
  private handlers: Array<(p: Point) => void> = [];
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
  /** Emit a vim jump recording of the departed `row`, like a flagged/big motion. */
  recordJump(row: number, column = 0): void {
    for (const h of [...this.handlers]) h(new Point(row, column));
  }
}

function setup() {
  const editors: FakeEditor[] = [];
  const observers: Array<(e: JumpEditor) => DisposableLike | void> = [];
  let active: FakeEditor | null = null;
  const opened: Array<{ path: string; cursor?: [number, number] }> = [];
  const deps: GlobalJumpListDeps = {
    observeTextEditors(cb) {
      observers.push(cb);
      for (const e of editors) cb(e);
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
    list.activeEditorChanged();
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
