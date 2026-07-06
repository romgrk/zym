/*
 * ModelMenu — the conversation footer's model/context segment: a `Gtk.MenuButton`
 * whose gauge shows a "123k" token count + circular context-fill ring, and which
 * opens a `ModelPopover` holding the agent's config-option controls (model /
 * reasoning effort / … — handed in via `setConfig`) plus a detailed token/cost
 * breakdown.
 *
 * It owns all of the model / cost / usage state and the composed widgets
 * (ContextRing + ModelPopover), so AgentConversation just forwards session events
 * to the setters, feeds the config controls through `setConfig`, and appends
 * `widget` to the footer. The gauge shows a muted "…" placeholder (no ring) until
 * the first usage lands, then the "123k" count + ring; the config options ride
 * along inside its popover throughout.
 */
import Gtk from 'gi:Gtk-4.0';
import { ContextRing } from './ContextRing.ts';
import { ModelPopover } from './ModelPopover.ts';
import type { ContextUsage } from '../../agents/session.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

export class ModelMenu {
  readonly widget: InstanceType<typeof Gtk.Box>;

  private readonly tokensLabel: InstanceType<typeof Gtk.Label>;
  private readonly button: InstanceType<typeof Gtk.MenuButton>;
  private readonly ring = new ContextRing();
  private readonly popover = new ModelPopover();

  private model: string | null = null;
  private costUsd: number | null = null;
  private tokens: number | null = null;
  private window = 1_000_000; // refined from result.modelUsage[model].contextWindow
  private usage: ContextUsage | null = null;

  constructor() {
    // The gauge: token count + circular fill, in a MenuButton opening the popover.
    this.tokensLabel = new Gtk.Label({ xalign: 1 });
    this.tokensLabel.addCssClass('conversation-footer-label');
    const gauge = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    gauge.append(this.tokensLabel);
    gauge.append(this.ring.widget);
    this.button = new Gtk.MenuButton();
    this.button.addCssClass('flat');
    this.button.setChild(gauge);
    this.button.setPopover(this.popover.widget);

    this.widget = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 14 });
    this.widget.append(this.button);
    this.render();
  }

  setModel(model: string | null): void { this.model = model; this.render(); }
  setCost(costUsd: number): void { this.costUsd = costUsd; this.render(); }
  setWindow(window: number): void { this.window = window; this.render(); }
  setUsage(usage: ContextUsage): void { this.tokens = usage.tokens; this.usage = usage; this.render(); }

  /** Replace the agent's config-option controls (built + owned by AgentConversation);
   *  they render inside the popover, above the token/cost breakdown. */
  setConfig(controls: Widget[]): void {
    this.popover.setConfig(controls);
  }

  private render(): void {
    this.ring.widget.setVisible(this.tokens != null); // no ring until a count is loaded
    if (this.tokens != null) {
      const fraction = this.tokens / this.window;
      this.tokensLabel.setText(`${(this.tokens / 1000).toFixed(0)}k`);
      this.ring.setFraction(fraction);
      this.button.setTooltipText(`${Math.round(fraction * 100)}% of context window used`);
    } else {
      // No context number yet: a muted "…" placeholder stands in for the count.
      this.tokensLabel.setText('…');
      this.button.setTooltipText('Context not yet reported');
    }

    const usage = this.usage;
    this.popover.update({
      model: this.model,
      window: this.window,
      costUsd: this.costUsd,
      tokens: this.tokens ?? 0,
      input: usage?.input ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheCreation: usage?.cacheCreation ?? 0,
      output: usage?.output ?? 0,
    });
  }
}
