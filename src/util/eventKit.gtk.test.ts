// GTK-backed regression tests for CompositeDisposable's controller helpers — the
// fix for the node-gtk controller-pin leak class (docs/lifecycle-and-disposal.md
// rule 9). These need real widgets, so they live apart from the pure eventKit
// tests. `observeControllers().nItems` is the only enumerable handle on a widget's
// controllers in this node-gtk build (cf. Picker.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gtk } from '../gi.ts';
import { CompositeDisposable } from './eventKit.ts';

Gtk.init();

const nControllers = (w: any): number => w.observeControllers().nItems as number;

test('addController attaches a real controller and dispose() removes it', () => {
  const widget = new Gtk.Box({});
  const cd = new CompositeDisposable();
  cd.addController(widget, new Gtk.GestureClick());
  assert.equal(nControllers(widget), 1, 'controller attached');
  cd.dispose();
  assert.equal(nControllers(widget), 0, 'controller removed on dispose — nothing left for node-gtk to pin');
});

test('a nested scope re-arms across cycles (the recycled-widget pattern)', () => {
  const widget = new Gtk.Box({});
  const owner = new CompositeDisposable();
  const scope = owner.nest();

  scope.addController(widget, new Gtk.EventControllerKey());
  assert.equal(nControllers(widget), 1);

  scope.clear(); // recycle: drop this cycle's controller, keep the scope usable
  assert.equal(nControllers(widget), 0);

  scope.addController(widget, new Gtk.EventControllerFocus());
  assert.equal(nControllers(widget), 1, 'scope re-armed for the next cycle');

  owner.dispose(); // end of life tears down the child scope too
  assert.equal(nControllers(widget), 0);
});
