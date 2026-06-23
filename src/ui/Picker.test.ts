import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk } from '../gi.ts';
import {
  openPicker,
  rank,
  highlightMarkup,
  highlightSegment,
  escapeMarkup,
  HIGHLIGHT_COLOR,
  type PickerItem,
} from './Picker.ts';

Gtk.init();

function item(text: string, extra: Partial<PickerItem> = {}): PickerItem {
  return { value: text, text, ...extra };
}

// Walk the overlay's widget tree for the picker's list box, then read each row's
// name (PickerRow / PickerEmpty / PickerError / PickerAction) and its label text.
function findListBox(root: any): any {
  let found: any = null;
  const walk = (w: any) => {
    if (found || !w) return;
    if (w instanceof Gtk.ListBox) {
      found = w;
      return;
    }
    let c = w.getFirstChild?.();
    while (c && !found) {
      walk(c);
      c = c.getNextSibling();
    }
  };
  walk(root);
  return found;
}

function rows(host: any): Array<{ name: string; text: string }> {
  const listBox = findListBox(host);
  const out: Array<{ name: string; text: string }> = [];
  let row = listBox?.getFirstChild?.();
  while (row) {
    const child = row.getChild();
    const label = child instanceof Gtk.Label ? child : child?.getFirstChild?.();
    out.push({ name: child?.getName?.() ?? '', text: label?.getText?.() ?? '' });
    row = row.getNextSibling();
  }
  return out;
}

test('rank with no query keeps insertion order', () => {
  const items = [item('alpha'), item('beta'), item('gamma')];
  const ranked = rank('', items);
  assert.deepEqual(
    ranked.map((r) => r.item.value),
    ['alpha', 'beta', 'gamma'],
  );
  // No query → no highlight positions.
  assert.deepEqual(ranked[0].positions, []);
});

test('rank with no query floats weighted items up, stably', () => {
  const items = [item('a'), item('b'), item('c')];
  const weight = (it: PickerItem) => (it.value === 'c' ? 5 : 0);
  const ranked = rank('', items, weight);
  assert.equal(ranked[0].item.value, 'c');
});

test('rank filters out non-matches and orders by score', () => {
  const items = [item('readme.md'), item('package.json'), item('readline.c')];
  const ranked = rank('read', items);
  const values = ranked.map((r) => r.item.value);
  // package.json doesn't contain the subsequence "read" → filtered out.
  assert.ok(!values.includes('package.json'));
  assert.ok(values.includes('readme.md'));
  assert.ok(values.includes('readline.c'));
});

test('rank returns matched character positions into item.text', () => {
  const ranked = rank('rm', [item('readme')]);
  assert.equal(ranked.length, 1);
  // Positions index into the matched text; highlighting them reproduces the query.
  const chars = ranked[0].positions.map((p) => 'readme'[p]).join('');
  assert.equal(chars, 'rm');
});

test('rank boosts matches after boostFrom (filename over directory)', () => {
  // Both contain "util"; one has it in the directory, one in the filename.
  const inDir = item('util/helpers.ts', { boostFrom: 'util/'.length });
  const inName = item('src/util.ts', { boostFrom: 'src/'.length });
  const ranked = rank('util', [inDir, inName]);
  // The filename match (after boostFrom) should outrank the directory match.
  assert.equal(ranked[0].item.value, 'src/util.ts');
});

test('rank applies the weight bonus on top of the fuzzy score', () => {
  const items = [item('aaa'), item('aab')];
  const noWeight = rank('aa', items).map((r) => r.item.value);
  // Without weight the order is score-driven; with a strong weight on 'aab' it wins.
  const weighted = rank('aa', items, (it) => (it.value === 'aab' ? 100 : 0));
  assert.equal(weighted[0].item.value, 'aab');
  assert.ok(noWeight.includes('aab'));
});

test('highlightMarkup wraps matched chars in a coloured span', () => {
  const out = highlightMarkup('abc', [1]);
  assert.equal(out, `a<span foreground="${HIGHLIGHT_COLOR}" weight="bold">b</span>c`);
});

test('highlightMarkup coalesces adjacent matches into one span', () => {
  const out = highlightMarkup('abc', [0, 1]);
  assert.equal(out, `<span foreground="${HIGHLIGHT_COLOR}" weight="bold">ab</span>c`);
});

test('highlightMarkup escapes Pango markup metacharacters', () => {
  const out = highlightMarkup('a<b>&', []);
  assert.equal(out, 'a&lt;b&gt;&amp;');
});

test('highlightMarkup escapes a matched metacharacter inside the span', () => {
  const out = highlightMarkup('<', [0]);
  assert.equal(out, `<span foreground="${HIGHLIGHT_COLOR}" weight="bold">&lt;</span>`);
});

test('highlightSegment slices the text and remaps positions into the slice', () => {
  // "src/util.ts" — highlight the "ut" within the filename segment [4, 11).
  const text = 'src/util.ts';
  const out = highlightSegment(text, 4, text.length, [4, 5]);
  assert.equal(out, `<span foreground="${HIGHLIGHT_COLOR}" weight="bold">ut</span>il.ts`);
});

test('highlightSegment ignores positions outside the slice', () => {
  const text = 'src/util.ts';
  // Position 0 is in the directory part, outside the [4, end) filename slice.
  const out = highlightSegment(text, 4, text.length, [0]);
  assert.equal(out, 'util.ts');
});

test('escapeMarkup escapes only the three metacharacters', () => {
  assert.equal(escapeMarkup('&'), '&amp;');
  assert.equal(escapeMarkup('<'), '&lt;');
  assert.equal(escapeMarkup('>'), '&gt;');
  assert.equal(escapeMarkup('x'), 'x');
});

test('escapeMarkup escapes every occurrence in a multi-char string', () => {
  // Whole-string callers (the location pickers) pass slices like a matched `<div>`;
  // every metacharacter must be escaped or Pango rejects the markup (blank row).
  assert.equal(escapeMarkup('a <div> & <b>'), 'a &lt;div&gt; &amp; &lt;b&gt;');
});

test('openPicker renders one row per item', () => {
  const host = new Gtk.Overlay();
  const picker = openPicker({ host, items: ['alpha', 'beta'], onSelect: () => {} });
  assert.deepEqual(rows(host), [
    { name: 'PickerRow', text: 'alpha' },
    { name: 'PickerRow', text: 'beta' },
  ]);
  picker.close();
});

test('openPicker shows the empty-state row when there are no items', () => {
  const host = new Gtk.Overlay();
  const picker = openPicker({ host, items: [], onSelect: () => {} });
  assert.deepEqual(rows(host), [{ name: 'PickerEmpty', text: 'No entries' }]);
  picker.close();
});

test('the error option opens straight into the error state', () => {
  const host = new Gtk.Overlay();
  const picker = openPicker({ host, items: ['x'], onSelect: () => {}, error: 'Not a git repository' });
  assert.deepEqual(rows(host), [{ name: 'PickerError', text: 'Not a git repository' }]);
  picker.close();
});

test('setError replaces the matches; setItems clears the error', () => {
  const host = new Gtk.Overlay();
  const picker = openPicker({ host, items: ['alpha', 'beta'], onSelect: () => {} });

  picker.setError('boom');
  assert.deepEqual(rows(host), [{ name: 'PickerError', text: 'boom' }]);

  picker.setItems(['gamma']);
  assert.deepEqual(rows(host), [{ name: 'PickerRow', text: 'gamma' }]);
  picker.close();
});

test('setLoading shows the loading placeholder while empty', () => {
  const host = new Gtk.Overlay();
  const picker = openPicker({ host, items: [], onSelect: () => {}, loading: true });
  assert.deepEqual(rows(host), [{ name: 'PickerEmpty', text: 'Loading…' }]);
  picker.close();
});

test('match rows are recycled across rebuilds (no churn), growing and shrinking', () => {
  const host = new Gtk.Overlay();
  const picker = openPicker({ host, items: ['a', 'b'], onSelect: () => {} });
  const listBox = findListBox(host);
  const firstRow = listBox.getRowAtIndex(0);

  // Same count, new content: the leading row container is reused in place.
  picker.setItems(['c', 'd']);
  assert.equal(listBox.getRowAtIndex(0), firstRow);
  assert.deepEqual(
    rows(host).map((r) => r.text),
    ['c', 'd'],
  );

  // Grow then shrink: row count tracks the data.
  picker.setItems(['e', 'f', 'g']);
  assert.equal(rows(host).length, 3);
  picker.setItems(['h']);
  assert.deepEqual(rows(host), [{ name: 'PickerRow', text: 'h' }]);
  picker.close();
});

// Match rows must carry no event controllers. The old select-on-hover affordance
// added a hover `EventControllerMotion` per row, whose handler closure node-gtk
// roots — a row removed from the pool then pinned its whole subtree forever (the
// multi-GB idle-RSS leak). Selection is now keyboard- and click-driven only, so
// rows hold no controllers and nothing leaks. `observeControllers().nItems`
// counts the controllers on a widget.
const controllerCount = (w: any): number => w.observeControllers().nItems as number;

test('match rows carry no event controllers (select-on-hover removed, no leak)', () => {
  const host = new Gtk.Overlay();
  const picker = openPicker({ host, items: ['a', 'b', 'c', 'd', 'e'], onSelect: () => {} });
  const listBox = findListBox(host);

  for (let i = 0; i < 5; i++) {
    assert.equal(controllerCount(listBox.getRowAtIndex(i)), 0, `match row ${i} has no event controller`);
  }

  // Growing and shrinking the pool must not introduce controllers either.
  picker.setItems(['a', 'b', 'c', 'd', 'e', 'f']);
  picker.setItems(['a']);
  assert.equal(controllerCount(listBox.getRowAtIndex(0)), 0, 'reused row has no event controller');
  picker.close();
});
