/*
 * ModelContext — the conversation footer's model + context-window segment: the
 * model name (left) paired with a "123k" token count and circular fill gauge
 * (right) that opens a detailed token/cost breakdown popover.
 *
 * It owns all of the model / cost / usage state and the composed widgets
 * (ContextRing + ContextPopover), so AgentConversation just forwards session
 * events to the setters and appends `widget` to the footer.
 */
import { Gtk } from '../../gi.ts';
import { ContextRing } from './ContextRing.ts';
import { ContextPopover } from './ContextPopover.ts';
import type { ContextUsage } from '../../agents/claude-sdk/SdkSession.ts';

export class ModelContext {
  readonly widget: InstanceType<typeof Gtk.Box>;

  private readonly modelLabel: InstanceType<typeof Gtk.Label>;
  private readonly tokensLabel: InstanceType<typeof Gtk.Label>;
  private readonly button: InstanceType<typeof Gtk.MenuButton>;
  private readonly ring = new ContextRing();
  private readonly popover = new ContextPopover();

  private model: string | null = null;
  private costUsd: number | null = null;
  private tokens: number | null = null;
  private window = 1_000_000; // refined from result.modelUsage[model].contextWindow
  private usage: ContextUsage | null = null;

  constructor() {
    this.modelLabel = new Gtk.Label({ xalign: 0, hexpand: true });
    this.modelLabel.addCssClass('quilx-conversation-footer-label');

    // The gauge: token count + circular fill, in a MenuButton opening the popover.
    this.tokensLabel = new Gtk.Label({ xalign: 1 });
    this.tokensLabel.addCssClass('quilx-conversation-footer-label');
    const gauge = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    gauge.append(this.tokensLabel);
    gauge.append(this.ring.widget);
    this.button = new Gtk.MenuButton();
    this.button.addCssClass('flat');
    this.button.setChild(gauge);
    this.button.setPopover(this.popover.widget);

    this.widget = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 14, hexpand: true });
    this.widget.append(this.modelLabel); // left, hexpand pushes the gauge to the right edge
    this.widget.append(this.button);
    this.render();
  }

  setModel(model: string | null): void { this.model = model; this.render(); }
  setCost(costUsd: number): void { this.costUsd = costUsd; this.render(); }
  setWindow(window: number): void { this.window = window; this.render(); }
  setUsage(usage: ContextUsage): void { this.tokens = usage.tokens; this.usage = usage; this.render(); }

  private render(): void {
    this.modelLabel.setText(this.model ? this.model.replace(/^claude-/, '') : '');

    if (this.tokens != null) {
      const fraction = this.tokens / this.window;
      this.tokensLabel.setText(`${(this.tokens / 1000).toFixed(0)}k`);
      this.ring.setFraction(fraction);
      this.button.setTooltipText(`${Math.round(fraction * 100)}% of context window used`);
      this.button.setVisible(true);
    } else {
      this.button.setVisible(false);
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
