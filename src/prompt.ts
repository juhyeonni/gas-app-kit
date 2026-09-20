/**
 * The one confirmation prompt.
 *
 * It lived here twice before, and the copies drifted into opposite bugs:
 * `deploy` read `/dev/tty` but treated a missing terminal as **yes**, so every
 * npm script and CI wrapper deployed unconfirmed; `rollback` read fd 0, which
 * `process.stdin.isTTY` has already put in non-blocking mode, so the read threw
 * EAGAIN and the prompt declined itself before the user could type.
 *
 * One rule now, for both callers: a terminal that cannot be asked is neither a
 * yes nor a silent no. It is a refusal that names the flag which states the
 * intent explicitly — which is the only thing automation can act on.
 */

import * as fs from 'node:fs'
import { EnvsError } from './envs.ts'

/**
 * Ask `question` on the controlling terminal.
 *
 * `retry` is the command to print when there is no terminal — it must be the
 * full `--yes` form of what the caller was about to do, because that message is
 * read at the moment the original command just failed.
 */
export function promptYesNo(question: string, retry: string): boolean {
  if (!process.stdin.isTTY) {
    throw new EnvsError(
      `${question}\n` +
        `There is no terminal to ask on, so the intent has to be stated explicitly. Re-run with:\n` +
        `  ${retry}\n` +
        `(or set CI=true in a pipeline, which carries the same meaning.)`
    )
  }

  process.stdout.write(`${question} [y/N] `)
  const buffer = Buffer.alloc(8)
  let bytes: number
  try {
    // Not fd 0: touching `process.stdin` above put it in non-blocking mode, so
    // `readSync(0)` throws EAGAIN before the user can type. `/dev/tty` blocks.
    const tty = fs.openSync('/dev/tty', 'r')
    try {
      bytes = fs.readSync(tty, buffer, 0, buffer.length, null)
    } finally {
      fs.closeSync(tty)
    }
  } catch {
    // "Could not ask" and "was told no" must not look the same: one is fixed by
    // passing a flag, the other by not passing one.
    throw new EnvsError(`Cannot read a confirmation from this terminal. Re-run with:\n  ${retry}`)
  }
  return /^y/i.test(buffer.toString('utf-8', 0, bytes).trim())
}
