/*
 * nerdfont.ts — curated Nerd Font glyph catalog, grouped by purpose.
 *
 * Each value is the literal glyph from the bundled "Symbols Nerd Font Mono"
 * (see fonts.ts), so it renders monochrome and follows the theme foreground.
 * Use these glyphs as label text; render with `iconLabel` from icons.ts.
 *
 * Keys are descriptive (not the upstream nf-* names); the trailing comment keeps
 * the codepoint and original Nerd Font name for greppability. Curated, not
 * exhaustive — add what you need. Bulk file-tree icons live in fileIcons.ts.
 */

export const NERDFONT = {
  STATUS: {
    INFO:    '', // U+F05A nf-fa-info_circle
    SUCCESS: '', // U+F058 nf-fa-check_circle
    WARNING: '', // U+F071 nf-fa-exclamation_triangle
    ERROR:   '', // U+F06A nf-fa-exclamation_circle
    FATAL:   '', // U+F057 nf-fa-times_circle
    HINT:    '', // U+F0EB nf-fa-lightbulb_o
    BUG:     '', // U+F188 nf-fa-bug
    CHECK:   '', // U+F00C nf-fa-check
    CROSS:   '', // U+F467 nf-oct-x
    DOT:     '', // U+F444 nf-oct-dot_fill
    NEUTRAL: '', // U+F11A nf-fa-meh_o
    SYNC:    '󱥸', // U+F1978 nf-md-cog_sync (agent working spinner)
    STOP:    '', // U+F28D nf-fa-stop_circle (interrupted)
  },
  TASK: {
    DONE:   '', // U+F046 nf-fa-check_square_o
    ACTIVE: '', // U+F138 nf-fa-caret_square_o_right (in progress)
    OPEN:   '', // U+F096 nf-fa-square_o
  },
  GIT: {
    BRANCH:       '', // U+F418 nf-oct-git_branch
    COMMIT:       '', // nf-oct-git_commit
    MERGE:        '', // U+F419 nf-oct-git_merge
    PULL_REQUEST: '', // U+F407 nf-oct-git_pull_request
    STASH:        '', // U+F187 nf-fa-archive
    TAG:          '', // U+F02B nf-fa-tag
  },
  NAV: {
    CHEVRON_UP:    '', // U+F077 nf-fa-chevron_up
    CHEVRON_DOWN:  '', // U+F078 nf-fa-chevron_down
    CHEVRON_LEFT:  '', // U+F053 nf-fa-chevron_left
    CHEVRON_RIGHT: '', // U+F054 nf-fa-chevron_right
    SIDEBAR:       '', // U+EBF5 nf-cod-layout_sidebar_left
  },
  EDITOR: {
    COMMENT:  '', // U+F075 nf-fa-comment
    FOLDER:   '', // U+F07B nf-fa-folder
    SEARCH:   '', // U+F002 nf-fa-search
    SYMBOL:   '', // U+EA8B nf-cod-symbol_namespace
    TERMINAL: '', // U+F120 nf-fa-terminal
    SERVER:   '', // U+F233 nf-fa-server
  },
  ACTION: {
    CLOSE: '', // U+F00D nf-fa-times
    EDIT:  '', // U+F040 nf-fa-pencil
    TRASH: '', // U+F1F8 nf-fa-trash
    COPY:  '', // U+F0C5 nf-fa-copy
  },
  DIFF: {
    UNIFIED:      '', // U+F039 nf-fa-align_justify
    SIDE_BY_SIDE: '', // U+F0DB nf-fa-columns
  },
  SOCIAL: {
    GITHUB: '', // U+F09B nf-fa-github
    USER:   '', // U+F007 nf-fa-user
  },
  TOOL: {
    READ:     '', // U+F15C nf-fa-file_text
    WRITE:    '', // U+F0C7 nf-fa-floppy_o (save)
    EDIT:     '', // U+F044 nf-fa-pencil_square_o
    GLOB:     '', // U+F07C nf-fa-folder_open
    WEB:      '', // U+F0AC nf-fa-globe
    SUBAGENT: '', // U+F0C0 nf-fa-users (Task)
    TODO:     '', // U+F0AE nf-fa-tasks (checklist)
    NOTEBOOK: '', // U+F02D nf-fa-book
    MCP:      '', // U+F1E6 nf-fa-plug
    GENERIC:  '', // U+F013 nf-fa-cog (default)
    SKILL:    '', // U+F12E nf-fa-puzzle_piece
    QUESTION: '', // U+F059 nf-fa-question_circle
    WORKFLOW: '', // U+F0E8 nf-fa-sitemap
    CLOCK:    '', // U+F017 nf-fa-clock_o (ScheduleWakeup)
    CALENDAR: '', // U+F073 nf-fa-calendar (Cron)
    MONITOR:  '', // U+F06E nf-fa-eye (Monitor)
    TRIGGER:  '', // U+F0E7 nf-fa-bolt (RemoteTrigger)
    BELL:     '', // U+F0F3 nf-fa-bell (PushNotification)
    COGS:     '', // U+F085 nf-fa-cogs (background task)
    STOP:     '', // U+F04D nf-fa-stop (TaskStop)
    DESIGN:   '', // U+F1FC nf-fa-paint_brush (DesignSync)
    PLAN:     '', // U+F022 nf-fa-list_alt (plan mode)
    WORKTREE: '', // U+F126 nf-fa-code_fork (worktree)
  },
} as const;
