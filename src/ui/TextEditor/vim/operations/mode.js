/*
 * Mode operations — the minimal set that drives normal ⇄ insert transitions.
 *
 * These are quilx-authored (vim-mode-plus splits them across misc-command.js and
 * operator-insert.js, which are vendored wholesale in later phases). Each extends
 * the vendored Base and self-registers on import, so the operation stack can run
 * it by name. They execute immediately (no motion target), simply asking the
 * VimState to change mode.
 */
import { Base } from '../base.js'

class ActivateNormalMode extends Base {
  static operationKind = 'misc-command'
  execute() {
    this.vimState.activate('normal')
  }
}
ActivateNormalMode.register()

class ActivateInsertMode extends Base {
  static operationKind = 'operator'
  execute() {
    this.vimState.activate('insert')
  }
}
ActivateInsertMode.register()

class InsertAfter extends Base {
  static operationKind = 'operator'
  execute() {
    for (const cursor of this.editor.getCursors()) cursor.moveRight()
    this.vimState.activate('insert')
  }
}
InsertAfter.register()

export { ActivateNormalMode, ActivateInsertMode, InsertAfter }
