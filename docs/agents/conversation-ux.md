# AgentConversation — UX review & rework advice

A UX critique of the native (`acp`) conversation view
(`src/ui/AgentConversation.ts` + `src/ui/conversation/*`) with prioritized,
concrete recommendations for the UI rework. Each item names what exists today,
the gap, the fix, and the code that owns it. Nothing here is a code change yet —
it's the design backlog the rework should pull from.

## Where it stands

The view is clean and information-dense, and the bones are good: one scrollable
`Transcript` clamped to an 820px reading measure, user turns as right-aligned
accent bubbles (`Message.is-user`), assistant turns as background-blended prose
(`Message.is-assistant`, no bubble), tool activity as collapsible icon rows
(`ToolRow`) with consecutive file-tool/subagent runs grouped, sticky Tasks /
Subagents / Monitors panels, and a rounded input card whose footer carries the
status icon, permission-mode dropdown, and a context-token ring.

Because user bubbles are accent-tinted (`--user-bubble-bg`), the `MarkdownRenderer`
draws every block fill (blockquote, code block, table header) as a **neutral wash**
— the view foreground at low opacity — never an opaque or accent-tinted surface
color, so the fills composite cleanly over any bubble background instead of clashing.
The colors are owned by the renderer (`src/ui/markdown/MarkdownRenderer.ts`); the
model just flags whether a block has a background.

The weaknesses are almost all **discoverability and in-the-moment control**: the
view assumes a keyboard-fluent user who already knows the chords, and it gives
few on-screen affordances for the actions a user reaches for most (send, stop,
retry, copy, jump-to-latest). The rework's biggest wins are cheap.

## Tier 1 — high impact, low cost (do these first)

1. **A visible Stop control while working.** Interrupt is `ctrl-c` only
   (`conversation:interrupt`), and the only "working" signal is a small
   `Thinking…` spinner buried in the footer (`refreshThinking`). Every mature
   agent UI shows a prominent Stop button while generating. Recommendation: while
   `status === 'working'`, swap the prompt's submit affordance (see #2) for a
   Stop button wired to `session.interrupt()`. This also makes the otherwise
   invisible interrupt feature discoverable.

2. **A Send button in the input card.** Submission is enter-only
   (`conversation:submit-prompt`); there is no clickable send, and nothing tells
   the user that `enter` sends / `alt-enter` newlines. Add a send button at the
   trailing edge of the footer (it becomes the Stop button while working, #1).
   Mouse users and newcomers currently have no path to send.

3. **Inline Retry/Resume on error and exit.** A mid-turn API failure (common on
   long sessions per acp.md) drops an `addErrorRow` / exit
   `conversation-system` row and disables the prompt — but the user must leave
   for the workbench list (`r`) to restart. Put a **Restart** / **Resume** button
   right on the error/exit row (it already knows the agent is `exited`; resume is
   a restart for this kind). Recovery should be where the failure is.

4. **Per-message copy affordance.** `MarkdownView.getMarkdown()` exists precisely
   for copy-to-clipboard, but nothing renders a copy control. Add a hover/“⋯”
   copy button on assistant bubbles (and ideally per code block). This is the
   single most-requested chat affordance and the plumbing is already there.

5. **Scroll-to-latest button.** `Transcript` auto-sticks to the bottom but
   releases the moment the user scrolls up to read history (`setupAutoScroll`),
   with no way back except manual scrolling while new content streams in. Add a
   floating “↓ jump to latest” pill (an `Adw`/overlay child) shown only when
   `stickToBottom` is false; click → `scrollToBottom(true)`.

## Tier 2 — meaningful, moderate cost

> **Implemented so far:** #7 (per-tool-row running spinner), #8 (elapsed time in
> the footer indicator), and #14 (editable/cancellable queued message). The rest
> remain open.

6. **Richer permission prompt: escalate + steer.** *(escalate done)* The prompt now
   REPLACES the input while the agent waits (`cards.ts:permissionPrompt`, shown in
   AgentConversation's warning-ringed interaction slot — see acp.md) with
   raised actions **Accept / Deny / Switch to auto**, plus **Allow edits** for edit
   tools only — the mode-switch actions flip the permission mode in place
   (`setPermissionMode('acceptEdits' | 'auto')`) *and* allow. Still open: (a) **Deny
   with a message** — let the user type a steering note on denial (the headless
   channel already round-trips a deny *message* for `AskUserQuestion`, so the carrier
   exists), and (b) keyboard accelerators on the actions (`y`/`n`).

7. **Per-tool-row running state.** *(done)* A live Bash/generic tool row now spins
   from tool-use until its result lands: `ToolRow.setRunning` swaps the glyph for
   an `Adw.Spinner` in the leading slot; `toolRows.ts` arms it on a `live` row and
   clears it in `onResult`, and `setStatus` stops any row still spinning when the
   turn ends (interrupt/crash). Replayed and subagent-page rows pass `live: false`
   so a captured-but-resultless row never spins forever.

8. **Surface elapsed time, not just tokens.** *(done)* The footer indicator now
   reads `Thinking… (1.2k tokens · 1m 05s)` — a 1s tick (`startThinkingTimer` +
   `formatElapsed`) folds the turn's elapsed time in beside the token count, reset
   on each working transition.

9. **Orient the empty / fresh conversation.** A new agent opens to an empty
   transcript and a bare prompt — no model, cwd/worktree, or mode shown until you
   look at the footer ring/dropdown. Render a light header or placeholder card on
   the empty state: model · working directory (or worktree) · current permission
   mode, plus maybe 2–3 example prompts. This also gives auto-naming’s `…`
   placeholder somewhere natural to live.

10. **On-screen affordance hints.** Everything is a hidden chord: `shift-tab`
    (mode), `ctrl-c` (interrupt), `alt-enter` (newline), `ctrl-d ctrl-d` (close),
    `/` (slash commands). New users discover none of them. Add tooltips to the
    footer controls (each permission mode; the mode dropdown’s `shift-tab`) and a
    one-line muted hint under the prompt (“⏎ send · alt-⏎ newline · / commands”),
    dismissible or shown only while empty.

## Tier 3 — polish & larger bets

11. **Turn delineation.** Assistant turns have no surface and tool rows indent
    further (`transcript-entry-tool`, 6× spacing). The result reads clean but
    turn boundaries blur in a long back-and-forth. Consider a subtle assistant
    left-edge marker or a faint per-turn separator — enough rhythm to scan,
    without re-introducing heavy bubbles.

12. **Context-limit warning.** The context ring (`ModelContext`/`ContextRing`)
    fills silently toward the window cap with no warning as it nears compaction.
    Tint the ring and/or surface a one-time notice as it approaches the limit.

13. **In-conversation search / turn jumping.** Long sessions have no find or
    turn-to-turn navigation. A lightweight find-in-transcript (reusing the
    editor’s search idiom) would help once sessions get long.

14. **Queued-message editing.** *(done)* The “Pending” bubble carries **Edit** and
    **Cancel** controls: Edit (`editPending`) pulls the queued text back into the
    prompt (ahead of anything already typed) and clears the queue; Cancel
    (`cancelPending`) discards it. Both route through `setPendingText`.

15. **Alignment on wide columns.** The transcript clamps to 820px pinned left
    (`halign START`), so on a wide agent sidebar user bubbles sit mid-column with
    dead space to the right, while on a narrow sidebar it’s full-width. Sanity-
    check both extremes; consider centering the clamp or letting bubbles track the
    true right edge.

## Guiding principle for the rework

The current design optimizes for a power user who already knows the keymap. The
rework should keep that ceiling but raise the floor: **make the three or four
actions a user takes every turn — send, stop, retry, copy — visible and
clickable**, without turning the clean transcript into chrome. Most of Tier 1 is
a day's work and removes the sharpest edges.
