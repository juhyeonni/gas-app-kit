import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { runGate, brokenLinks } from '../src/gate.ts'

const PASS = 'node -e "process.exit(0)"'
const FAIL = 'node -e "process.exit(1)"'

function consumer(scripts: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-gate-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'c', private: true, scripts }, null, 2))
  return dir
}

/** Install a scoped dependency as a symlink pointing nowhere. */
function breakLink(cwd: string, scope: string, name: string) {
  const dir = path.join(cwd, 'node_modules', scope)
  fs.mkdirSync(dir, { recursive: true })
  fs.symlinkSync(path.join(cwd, 'does', 'not', 'exist'), path.join(dir, name), 'dir')
}

const statusOf = (result: ReturnType<typeof runGate>, name: 'typecheck' | 'test') =>
  result.checks.find((c) => c.name === name)?.status

test('--skip-checks bypasses the gate and says so', () => {
  const cwd = consumer({ typecheck: FAIL, test: FAIL })
  const result = runGate({ cwd, skipChecks: true, env: {} })

  assert.equal(result.ran, false)
  assert.equal(result.skippedBecause, 'flag')
  assert.equal(result.passed, true)
})

test('CI=true skips both checks', () => {
  const cwd = consumer({ typecheck: FAIL, test: FAIL })
  const result = runGate({ cwd, env: { CI: 'true' } })

  assert.equal(result.skippedBecause, 'ci')
  assert.equal(result.checks.length, 0)
})

test('CI=true and --skip-checks together are not a conflict', () => {
  const cwd = consumer({ typecheck: FAIL })
  const result = runGate({ cwd, skipChecks: true, env: { CI: 'true' } })
  assert.equal(result.skippedBecause, 'flag', 'the explicit flag is reported')
  assert.equal(result.passed, true)
})

test('a failing typecheck fails the gate', () => {
  const cwd = consumer({ typecheck: FAIL, test: PASS })
  const result = runGate({ cwd, env: {} })

  assert.equal(statusOf(result, 'typecheck'), 'failed')
  assert.equal(result.passed, false)
})

test('both checks passing passes the gate', () => {
  const cwd = consumer({ typecheck: PASS, test: PASS })
  const result = runGate({ cwd, env: {} })

  assert.equal(statusOf(result, 'typecheck'), 'passed')
  assert.equal(statusOf(result, 'test'), 'passed')
  assert.equal(result.passed, true)
})

test('checks run sequentially — typecheck completes before tests start', () => {
  const cwd = consumer({
    typecheck: `node -e "require('fs').appendFileSync('order.txt','tc-start;');setTimeout(()=>require('fs').appendFileSync('order.txt','tc-end;'),60)"`,
    test: `node -e "require('fs').appendFileSync('order.txt','test;')"`,
  })
  runGate({ cwd, env: {} })

  assert.equal(fs.readFileSync(path.join(cwd, 'order.txt'), 'utf-8'), 'tc-start;tc-end;test;')
})

test('a broken linked dependency degrades typecheck but still runs tests', () => {
  const cwd = consumer({ typecheck: FAIL, test: PASS })
  breakLink(cwd, '@gws-emul', 'core')

  const result = runGate({ cwd, env: {} })

  assert.equal(statusOf(result, 'typecheck'), 'degraded')
  assert.match(result.checks[0]!.reason ?? '', /@gws-emul\/core/)
  assert.equal(statusOf(result, 'test'), 'passed')
  assert.equal(result.passed, true, 'a structurally impossible typecheck is not a failure')
})

test('a degraded typecheck does not excuse failing tests', () => {
  const cwd = consumer({ typecheck: FAIL, test: FAIL })
  breakLink(cwd, '@gws-emul', 'core')

  const result = runGate({ cwd, env: {} })

  assert.equal(statusOf(result, 'typecheck'), 'degraded')
  assert.equal(result.passed, false)
})

test('a stale broken link does not disable a typecheck that actually works', () => {
  // Measured in this consumer's main checkout: a dead `@gas-task/core` link
  // left over from a merged package, alongside a typecheck that passes.
  const cwd = consumer({ typecheck: PASS, test: PASS })
  breakLink(cwd, '@gas-task', 'core')

  const result = runGate({ cwd, env: {} })

  assert.equal(statusOf(result, 'typecheck'), 'passed', 'typecheck must still run and be trusted')
  assert.equal(result.passed, true)
})

test('a real type error with no broken links is a hard failure, never degraded', () => {
  const cwd = consumer({ typecheck: FAIL, test: PASS })
  const result = runGate({ cwd, env: {} })

  assert.equal(statusOf(result, 'typecheck'), 'failed')
  assert.equal(result.passed, false)
})

test('an intact symlink is not treated as broken', () => {
  const cwd = consumer({ typecheck: PASS, test: PASS })
  const target = path.join(cwd, 'real-package')
  fs.mkdirSync(target)
  fs.mkdirSync(path.join(cwd, 'node_modules', '@scope'), { recursive: true })
  fs.symlinkSync(target, path.join(cwd, 'node_modules', '@scope', 'pkg'), 'dir')

  assert.deepEqual(brokenLinks(cwd), [])
  assert.equal(statusOf(runGate({ cwd, env: {} }), 'typecheck'), 'passed')
})

test('a consumer with no linked dependencies never triggers the degrade path', () => {
  const cwd = consumer({ typecheck: PASS, test: PASS })
  fs.mkdirSync(path.join(cwd, 'node_modules', 'plain-dep'), { recursive: true })

  assert.deepEqual(brokenLinks(cwd), [])
})

test('broken links inside workspace packages are found too', () => {
  const cwd = consumer({ typecheck: PASS, test: PASS })
  const nested = path.join(cwd, 'packages', 'appscript', 'node_modules', '@gws-emul')
  fs.mkdirSync(nested, { recursive: true })
  fs.symlinkSync(path.join(cwd, 'nowhere'), path.join(nested, 'core'), 'dir')

  assert.deepEqual(brokenLinks(cwd), ['@gws-emul/core'])
})

test('missing typecheck or test scripts are reported as absent, not failures', () => {
  const cwd = consumer({})
  const result = runGate({ cwd, env: {} })

  assert.equal(statusOf(result, 'typecheck'), 'absent')
  assert.equal(statusOf(result, 'test'), 'absent')
  assert.equal(result.passed, true)
})
