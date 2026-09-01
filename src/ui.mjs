/**
 * Shared CLI UI helpers for the scripts in this directory.
 *
 * Conveys three things consistently:
 *   - task:    banner('setup')      → ━━━ setup ━━━
 *   - section/step: step('clasp')   → ▶ [2/5] clasp
 *   - status:  item / info / warn / error / done / fail
 *
 * Colors are emitted only on a TTY and when NO_COLOR is unset.
 */

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
}

const paint = (codes, s) => (useColor ? codes + s + C.reset : s)

// When invoked from a parent script, suppress the banner/step/done chrome so
// the child's output reads as items under the parent's current step.
const nested = process.env.UI_NESTED === '1'

export function createUI(name) {
  let total = 0
  let n = 0

  const ui = {
    banner(label = name) {
      if (nested) return
      console.log('\n' + paint(C.bold + C.cyan, `━━━ ${label} ━━━`) + '\n')
    },
    setTotal(t) {
      total = t
      return ui
    },
    step(label) {
      n += 1
      if (nested) return
      const counter = total ? `[${n}/${total}]` : `[${n}]`
      console.log(paint(C.bold + C.blue, `▶ ${counter} ${label}`))
    },
    heading(label) {
      console.log('\n' + paint(C.bold, `  ${label}`))
    },
    item(msg) {
      console.log(paint(C.green, '    ✓ ') + msg)
    },
    info(msg) {
      console.log(paint(C.dim, '    • ' + msg))
    },
    warn(msg) {
      console.log(paint(C.yellow, '    ⚠ ') + msg)
    },
    error(msg) {
      console.error(paint(C.red, '    ✗ ') + msg)
    },
    done(msg) {
      if (nested) return
      console.log('\n' + paint(C.bold + C.green, `✅ ${msg}`) + '\n')
    },
    fail(msg) {
      console.error('\n' + paint(C.bold + C.red, `❌ ${msg}`) + '\n')
      process.exit(1)
    },
  }
  return ui
}
