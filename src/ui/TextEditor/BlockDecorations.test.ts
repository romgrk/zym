import { test } from 'node:test';
import assert from 'node:assert/strict';
import GLib from 'gi:GLib-2.0';
import Gtk from 'gi:Gtk-4.0';
import GtkSource from 'gi:GtkSource-5';
import { BlockDecorations } from './BlockDecorations.ts';

Gtk.init();

function pumpUntil(done: () => boolean, maxFrames = 180): void {
  const context = GLib.MainContext.default();
  for (let i = 0; i < maxFrames && !done(); i++) context.iteration(true);
}

test('widgets follow viewport residency while reservations and build-paired teardown persist', () => {
  const buffer = new GtkSource.Buffer();
  buffer.setText(Array.from({ length: 360 }, (_, line) => `line ${line}`).join('\n'), -1);
  const view = new GtkSource.View({ buffer });
  const blocks = new BlockDecorations(view);
  let builds = 0;
  let disposals = 0;
  const handles = Array.from({ length: 120 }, (_, index) => blocks.add({
    line: index * 3,
    height: 24,
    placement: 'below',
    build: () => {
      builds++;
      return new Gtk.Label({ label: `block ${index}` });
    },
    dispose: () => { disposals++; },
  }));

  const scroller = new Gtk.ScrolledWindow();
  scroller.setChild(view);
  const window = new Gtk.Window({ defaultWidth: 600, defaultHeight: 320 });
  window.setChild(scroller);
  window.present();
  const adjustment = view.getVadjustment()!;
  const lastHandle = handles[handles.length - 1];
  const declarations = [...(blocks as any).blocks] as Array<{ reserved: boolean; tag: unknown }>;
  pumpUntil(() =>
    builds > 0 &&
    adjustment.getUpper() > adjustment.getPageSize() &&
    declarations.every((block) => block.reserved && block.tag),
  );

  assert.ok(builds < handles.length / 2, `only the viewport window built (${builds}/${handles.length})`);
  assert.ok(handles[0].widget(), 'the first visible decoration is materialized');
  assert.equal(lastHandle.widget(), null, 'an offscreen decoration keeps no widget');
  assert.ok(declarations.every((block) => block.reserved && block.tag), 'every declaration keeps its reservation tag');

  const buildsAtTop = builds;
  adjustment.setValue(adjustment.getUpper() - adjustment.getPageSize());
  pumpUntil(() => builds > buildsAtTop && disposals > 0 && lastHandle.widget() != null);
  assert.ok(lastHandle.widget(), 'the bottom decoration materializes before it enters the viewport');
  assert.equal(handles[0].widget(), null, 'the top decoration recycles after leaving the overscan window');

  const bottomBlock = declarations.find((block: any) => block.widget === lastHandle.widget()) as any;
  const slot = bottomBlock.slot;
  const disposalsBeforeUpdate = disposals;
  lastHandle.update({
    build: () => {
      builds++;
      return new Gtk.Label({ label: 'replacement' });
    },
    dispose: () => { disposals++; },
    height: 24,
  });
  assert.equal(bottomBlock.slot, slot, 'a visible rekey keeps its placed overlay slot');
  assert.equal(disposals, disposalsBeforeUpdate + 1, 'visible replacement tears down the previous widget');

  blocks.dispose();
  assert.equal(disposals, builds, 'every materialized widget has exactly one teardown');
  window.destroy();
});
