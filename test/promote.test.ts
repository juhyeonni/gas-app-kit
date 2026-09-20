import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { promote } from '../src/promote.ts'

const ENVS = {
  staging: { scriptId: 'S_STG', deploymentId: 'AK_STG', allowLocalDeploy: true },
  production: { scriptId: 'S_PRD', deploymentId: 'AK_PRD', allowLocalDeploy: true },
  locked: { scriptId: 'S_LCK', deploymentId: 'AK_LCK', allowLocalDeploy: false },
}

/** Versions of the *source* script, and which one its deployment serves. */
const VERSIONS = [
  { versionNumber: 12, description: 'v1.2.0 (ccc3333)' },
  { versionNumber: 11, description: 'v1.1.0 (bbb2222)' },
]

function workspace(envs: unknown = ENVS) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-promote-'))
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'c', private: true }))
  fs.writeFileSync(path.join(cwd, 'envs.json'), JSON.stringify(envs))
  return cwd
}

/**
 * A clasp stand-in. `pull` writes `remote` into the config's rootDir; every
 * call is logged so the assertions can read what ran, in order.
 */
function withFakeClasp<T>(
  run: (log: string) => T,
  {
    remote = { 'Code.js': 'verified\n' },
    servedVersion = 12 as number | null,
    pushFails = false,
  } = {}
): T {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-pbin-'))
  const log = path.join(bin, 'calls.log')
  fs.writeFileSync(
    path.join(bin, 'clasp'),
    `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
const cmd = args[0]
if (cmd === 'list-versions') { console.log(JSON.stringify(${JSON.stringify(VERSIONS)})); process.exit(0) }
if (cmd === 'list-deployments') {
  const served = ${JSON.stringify(servedVersion)}
  const row = { deploymentId: 'AK_STG' }
  if (served !== null) row.versionNumber = served
  console.log(JSON.stringify([{ deploymentId: 'AKHEAD' }, row, { deploymentId: 'AK_PRD', versionNumber: 4 }]))
  process.exit(0)
}
if (cmd === 'pull') {
  const config = JSON.parse(fs.readFileSync(args[args.indexOf('--project') + 1], 'utf-8'))
  const remote = ${JSON.stringify(remote)}
  for (const [name, body] of Object.entries(remote)) fs.writeFileSync(path.join(config.rootDir, name), body)
  process.exit(0)
}
if (cmd === 'push') {
  if (${JSON.stringify(pushFails)}) { process.stderr.write('push denied\\n'); process.exit(1) }
  console.log(JSON.stringify(['Code.js']))
  process.exit(0)
}
console.log(JSON.stringify({ deploymentId: args[args.indexOf('--deploymentId') + 1] || 'AK_NEW', versionNumber: 5 }))
`,
    { mode: 0o755 }
  )
  const previous = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${previous}`
  try {
    return run(log)
  } finally {
    process.env.PATH = previous
  }
}

const calls = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n') : [])

test('promotes the version the source actually serves, and rebuilds nothing', () => {
  const cwd = workspace()
  const result = withFakeClasp((log) => {
    const r = promote('staging', 'production', { cwd, env: {}, yes: true })
    // No build ran: there is no build script in this workspace at all, and the
    // command completed. Requiring a buildable tree would defeat the purpose.
    assert.ok(calls(log).some((c) => c.startsWith('pull --versionNumber 12')))
    assert.ok(calls(log).some((c) => c.startsWith('push --force')))
    return r
  })

  assert.equal(result.sourceVersion, 12)
  assert.equal(result.targetVersion, 5, "the target's version number is its own")
  assert.match(result.description, /promoted from staging@12/)
})

test('the code pushed to the target is the source version’s, not the working tree’s', () => {
  const cwd = workspace()
  let pushedFrom = ''
  withFakeClasp(
    (log) => {
      promote('staging', 'production', { cwd, env: {}, yes: true })
      const push = calls(log).find((c) => c.startsWith('push --force'))!
      pushedFrom = push.split('--project ')[1]!.split(' ')[0]!
      return null
    },
    { remote: { 'Code.js': 'the verified bytes\n' } }
  )
  // The push config points at the temp directory the pull filled, never at cwd.
  assert.ok(!pushedFrom.startsWith(cwd), 'the target is pushed from the pulled version, not the repo')
})

test('an explicit version overrides the one being served', () => {
  const cwd = workspace()
  const result = withFakeClasp(() => promote('staging', 'production', { cwd, env: {}, version: 11, yes: true }))
  assert.equal(result.sourceVersion, 11)
  assert.match(result.description, /v1\.1\.0 .* \(promoted from staging@11\)/)
})

test('a source serving @HEAD is refused — there is nothing immutable to promote', () => {
  const cwd = workspace()
  assert.throws(
    () => withFakeClasp(() => promote('staging', 'production', { cwd, env: {}, yes: true }), { servedVersion: null }),
    /serves @HEAD, which is not a version/
  )
})

test('a version the source does not have is refused, with what it does have', () => {
  const cwd = workspace()
  assert.throws(
    () => withFakeClasp(() => promote('staging', 'production', { cwd, env: {}, version: 99, yes: true })),
    /Available: 12 \(v1\.2\.0 \(ccc3333\)\), 11/
  )
})

test('the target’s allowLocalDeploy gates it, and is checked before anything is pulled', () => {
  const cwd = workspace()
  assert.throws(
    () => withFakeClasp((log) => {
      try {
        return promote('staging', 'locked', { cwd, env: {}, yes: true })
      } finally {
        assert.deepEqual(calls(log), [], 'refused before touching clasp at all')
      }
    }),
    /allowLocalDeploy: false/
  )
})

test('promoting an environment into itself is refused', () => {
  const cwd = workspace()
  assert.throws(() => promote('staging', 'staging', { cwd, env: {}, yes: true }), /cannot be promoted into itself/)
})

test('a declined confirmation changes nothing and is not a failure', () => {
  const cwd = workspace()
  const result = withFakeClasp((log) => {
    const r = promote('staging', 'production', { cwd, env: {}, confirm: () => false })
    assert.ok(!calls(log).some((c) => c.startsWith('push')), 'nothing was pushed')
    return r
  })
  assert.equal(result.declined, true)
  assert.equal(result.targetVersion, undefined)
})

test('a failed push says the target still serves what it served', () => {
  const cwd = workspace()
  assert.throws(
    () => withFakeClasp(() => promote('staging', 'production', { cwd, env: {}, yes: true }), { pushFails: true }),
    /still serves what it served before — no version was created/
  )
})

test('an empty pull is refused rather than pushed as an empty project', () => {
  const cwd = workspace()
  assert.throws(
    () => withFakeClasp(() => promote('staging', 'production', { cwd, env: {}, yes: true }), { remote: {} }),
    /Refusing to push an empty project/
  )
})
