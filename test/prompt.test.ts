import { test } from 'node:test'
import assert from 'node:assert/strict'

import { promptYesNo } from '../src/prompt.ts'
import { EnvsError } from '../src/envs.ts'

/**
 * The two copies this replaced both failed silently without a terminal, in
 * opposite directions: `deploy` answered yes and shipped, `rollback` answered
 * no before the user could type. Neither is an answer. The only correct one is
 * a refusal that names the flag which states the intent.
 */
function withoutTTY<T>(fn: () => T): T {
  const previous = process.stdin.isTTY
  process.stdin.isTTY = false
  try {
    return fn()
  } finally {
    process.stdin.isTTY = previous
  }
}

test('no terminal to ask on is a refusal, never a silent yes or no', () => {
  assert.throws(
    () => withoutTTY(() => promptYesNo('Deploy "production"?', 'gas-app deploy production --yes')),
    (err: Error) => err instanceof EnvsError && err.message.includes('gas-app deploy production --yes')
  )
})

test('the refusal repeats the question, so the log says what was being asked', () => {
  assert.throws(
    () => withoutTTY(() => promptYesNo('Roll "production" back to 3?', 'gas-app rollback production 3 --yes')),
    /Roll "production" back to 3\?/
  )
})
