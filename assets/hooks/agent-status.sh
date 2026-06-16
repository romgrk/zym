#!/bin/sh
# quilx agent-status reporter — invoked by Claude Code hooks (see AgentTerminal).
#
# Writes a one-word status (idle|working|waiting) to $QUILX_STATUS_FILE, which the
# editor watches via a Gio file monitor. argv[1] is the status; "notification" is
# derived from the Notification payload's type, and "files" (from a PostToolUse
# hook) appends the edited file's path to $QUILX_STATUS_FILE.files instead. Every
# payload also carries the claude session id, captured to $QUILX_STATUS_FILE.session
# so the editor can resume / persist the conversation. Status writes are atomic
# (tmp + rename) so the monitor sees one clean change.
[ -n "$QUILX_STATUS_FILE" ] || exit 0

payload=$(cat)

# Capture the claude session id (present in every hook payload).
sid=$(printf '%s' "$payload" | sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p' | head -1)
if [ -n "$sid" ]; then
  printf '%s' "$sid" > "$QUILX_STATUS_FILE.session.tmp" 2>/dev/null &&
    mv "$QUILX_STATUS_FILE.session.tmp" "$QUILX_STATUS_FILE.session" 2>/dev/null
fi

# Capture the current permission mode (default|plan|acceptEdits|auto|dontAsk|
# bypassPermissions). Present on most events — shift-tab toggling changes it on the
# next hook, so every payload that carries it refreshes $QUILX_STATUS_FILE.mode.
mode=$(printf '%s' "$payload" | sed -n 's/.*"permission_mode":"\([^"]*\)".*/\1/p' | head -1)
if [ -n "$mode" ]; then
  printf '%s' "$mode" > "$QUILX_STATUS_FILE.mode.tmp" 2>/dev/null &&
    mv "$QUILX_STATUS_FILE.mode.tmp" "$QUILX_STATUS_FILE.mode" 2>/dev/null
fi

status="$1"

# PostToolUse(Edit/Write/…) records the touched file for change-awareness: append
# its path to $QUILX_STATUS_FILE.files (one per line), which the editor watches.
if [ "$status" = "files" ]; then
  fp=$(printf '%s' "$payload" | sed -n 's/.*"file_path":"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$fp" ] && printf '%s\n' "$fp" >> "$QUILX_STATUS_FILE.files"
  exit 0
fi

if [ "$status" = "notification" ]; then
  case "$payload" in
    *'"permission_prompt"'* | *'"elicitation'*) status=waiting ;;
    *'"idle_prompt"'*) status=idle ;;
    *) exit 0 ;; # other notifications carry no status — ignore
  esac
fi

printf '%s' "$status" > "$QUILX_STATUS_FILE.tmp" 2>/dev/null &&
  mv "$QUILX_STATUS_FILE.tmp" "$QUILX_STATUS_FILE" 2>/dev/null
exit 0
