/*
 * WorkbenchActionsBar — the active workbench's actions (docs/workbench.md) shown in
 * the window HeaderBar as an Adw.SplitButton: the first (default) action is the main
 * button, the rest live in the dropdown popover. A lone action is a plain button (no
 * dropdown); the widget hides when the set is empty.
 *
 * Each button shows a stop glyph only while its action is running (idle shows just
 * the label) and **toggles** on click — run when idle, stop when running (so
 * restarting is two clicks: stop, then run). The running state is the controller's
 * `isRunning`, covering both a `terminal: false` background process and a
 * `terminal: true` action's terminal command. No accent/suggested styling.
 *
 * It binds to a `WorkbenchActions` controller and is rebound when the active workbench
 * changes (HeaderBar.rebind), so it always shows the shown workbench's set.
 */
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import { CompositeDisposable, Disposable } from '../../util/eventKit.ts';
import { addStyles } from '../../styles.ts';
import { ImageIcons } from '../../icons.ts';
import type { Action } from '../../actions.ts';
import type { WorkbenchActions } from './WorkbenchActions.ts';

const ICON_SIZE = 16;

addStyles(/* css */`
  .WorkbenchActionsMenu { padding: 4px; min-width: 160px; }
  .WorkbenchActionsMenu > button { padding: 4px 8px; }
`);

export class WorkbenchActionsBar {
  readonly root: InstanceType<typeof Gtk.Box>;
  private controller: WorkbenchActions | null = null;
  // The bound controller's change/running subscriptions, re-armed on every `bind`.
  private readonly bindSubs = new CompositeDisposable();
  // The current render's button `clicked` handlers; node-gtk roots each closure, so
  // this bag is cleared per render (and on dispose) to keep them from accumulating.
  private readonly buttonSubs = new CompositeDisposable();

  constructor() {
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    this.root.addCssClass('WorkbenchActionsBar');
    this.root.setVisible(false);
  }

  /** Point the bar at a workbench's action set (or `null` to clear it). Subscribes to
   *  the controller so set / running-state changes re-render (start ⇄ stop icon). */
  bind(controller: WorkbenchActions | null): void {
    this.bindSubs.clear(); // sever the previous workbench's subscriptions
    this.controller = controller;
    if (controller) {
      this.bindSubs.add(
        new Disposable(controller.onDidChange(() => this.render())),
        new Disposable(controller.onDidChangeRunning(() => this.render())),
      );
    }
    this.render();
  }

  private render(): void {
    this.buttonSubs.clear(); // sever the previous render's button handlers
    for (let child = this.root.getFirstChild(); child; ) {
      const next = child.getNextSibling();
      this.root.remove(child);
      child = next;
    }

    const actions = this.controller?.actions ?? [];
    const [first, ...rest] = actions;
    if (first && rest.length === 0) {
      // A lone action: a plain button, no dropdown.
      const button = new Gtk.Button({ valign: Gtk.Align.CENTER });
      button.addCssClass('raised'); // not flat (the header default)
      button.setChild(this.buttonContent(first));
      button.setTooltipText(this.tooltip(first));
      this.buttonSubs.connect(button, 'clicked', () => this.toggle(first));
      this.root.append(button);
    } else if (first) {
      // First = the main button; the others live in the dropdown popover.
      const split = new Adw.SplitButton({ valign: Gtk.Align.CENTER });
      split.addCssClass('raised'); // not flat (the header default)
      split.setChild(this.buttonContent(first));
      split.setTooltipText(this.tooltip(first));
      this.buttonSubs.connect(split, 'clicked', () => this.toggle(first));
      split.setPopover(this.buildMenu(rest));
      this.root.append(split);
    }

    this.root.setVisible(actions.length > 0);
  }

  // A popover listing the non-default actions as flat, left-aligned rows (icon +
  // label); choosing one dismisses the menu and toggles it.
  private buildMenu(actions: Action[]): InstanceType<typeof Gtk.Popover> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    box.addCssClass('WorkbenchActionsMenu');
    const popover = new Gtk.Popover();
    popover.setChild(box);
    for (const action of actions) {
      const item = new Gtk.Button();
      item.addCssClass('flat');
      item.setChild(this.buttonContent(action));
      item.setTooltipText(this.tooltip(action));
      this.buttonSubs.connect(item, 'clicked', () => {
        popover.popdown();
        this.toggle(action);
      });
      box.append(item);
    }
    return popover;
  }

  // A label, prefixed with a stop glyph only while the action is running (an idle
  // action shows no icon). Left-aligned so it reads the same on the main button and in
  // the menu.
  private buttonContent(action: Action): InstanceType<typeof Gtk.Box> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6, halign: Gtk.Align.START });
    if (this.isRunning(action)) box.append(ImageIcons.MEDIA_PLAYBACK_STOP(ICON_SIZE));
    box.append(new Gtk.Label({ label: action.label }));
    return box;
  }

  // Toggle: stop a running (background) action, else run it.
  private toggle(action: Action): void {
    if (this.isRunning(action)) this.controller?.stop(action.id);
    else this.controller?.run(action);
  }

  private isRunning(action: Action): boolean {
    return this.controller?.isRunning(action.id) ?? false;
  }

  private tooltip(action: Action): string {
    if (action.terminal) return action.command;
    return `${action.command}\n(background process${this.isRunning(action) ? ' — running' : ''})`;
  }

  dispose(): void {
    this.bindSubs.dispose();
    this.buttonSubs.dispose();
  }
}
