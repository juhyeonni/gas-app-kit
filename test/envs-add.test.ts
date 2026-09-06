import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { addEnv } from '../src/envs-add.ts'
import { loadEnvs, EnvsError, ENVS_ENV_VAR } from '../src/envs.ts'

/**
 * Every test here uses the `--script-id` path, which reaches no subprocess.
 * The create path talks to Google and is verified once, by hand, against a
 * throwaway project — see the bolt's Test stage.
 */
function workspace(registry?: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-add-'))
  if (registry) fs.writeFileSync(path.join(dir, 'envs.json'), JSON.stringify(registry, null, 2))
  return dir
}

test('registers an existing project without creating anything', () => {
  const cwd = workspace()
  const { entry, created } = addEnv('staging', { scriptId: 'S_STG', cwd, env: {} })

  assert.equal(created, false)
  assert.equal(entry.scriptId, 'S_STG')
  assert.equal(loadEnvs({ cwd, env: {} }).staging?.scriptId, 'S_STG')
})

test('creates envs.json when the repo has none yet', () => {
  const cwd = workspace()
  addEnv('dev', { scriptId: 'S_DEV', cwd, env: {} })
  assert.ok(fs.existsSync(path.join(cwd, 'envs.json')))
})

test('refuses to overwrite an existing entry without --force', () => {
  const cwd = workspace({ dev: { scriptId: 'OLD' } })
  assert.throws(
    () => addEnv('dev', { scriptId: 'NEW', cwd, env: {} }),
    (err: Error) => err instanceof EnvsError && err.message.includes('--force')
  )
  assert.equal(loadEnvs({ cwd, env: {} }).dev?.scriptId, 'OLD')
})

test('--force overwrites the scriptId but keeps the rest of the entry', () => {
  const cwd = workspace({ dev: { scriptId: 'OLD', deploymentId: 'D_KEEP', allowPrerelease: true } })
  addEnv('dev', { scriptId: 'NEW', force: true, cwd, env: {} })

  const entry = loadEnvs({ cwd, env: {} }).dev!
  assert.equal(entry.scriptId, 'NEW')
  assert.equal(entry.deploymentId, 'D_KEEP', 'the live deployment is not orphaned by a re-register')
  assert.equal(entry.allowPrerelease, true)
})

test('existing keys keep their position; a new env is appended', () => {
  const cwd = workspace({ dev: { scriptId: 'A' }, production: { scriptId: 'B' } })
  addEnv('staging', { scriptId: 'C', cwd, env: {} })

  assert.deepEqual(Object.keys(loadEnvs({ cwd, env: {} })), ['dev', 'production', 'staging'])
})

test('the written file is valid input for the loader, flags included', () => {
  const cwd = workspace()
  addEnv('dev', { scriptId: 'S', cwd, env: {} })

  const raw = JSON.parse(fs.readFileSync(path.join(cwd, 'envs.json'), 'utf-8'))
  assert.deepEqual(raw.dev, {
    scriptId: 'S',
    deploymentId: '',
    allowPrerelease: false,
    allowLocalDeploy: false,
  })
  assert.ok(!('name' in raw.dev), 'the derived name field is not serialized')
})

test('refuses when the registry comes from the environment variable', () => {
  const cwd = workspace()
  assert.throws(
    () => addEnv('dev', { scriptId: 'S', cwd, env: { [ENVS_ENV_VAR]: '{}' } }),
    (err: Error) => err.message.includes(ENVS_ENV_VAR)
  )
  assert.equal(fs.existsSync(path.join(cwd, 'envs.json')), false)
})

test('an empty --script-id is rejected rather than written as blank', () => {
  const cwd = workspace()
  assert.throws(() => addEnv('dev', { scriptId: '  ', cwd, env: {} }))
})

test('a nameless call is rejected', () => {
  const cwd = workspace()
  assert.throws(() => addEnv('', { scriptId: 'S', cwd, env: {} }))
})

test('the consumer repo’s .clasp.json and appsscript.json are untouched', () => {
  const cwd = workspace()
  fs.writeFileSync(path.join(cwd, '.clasp.json'), '{"scriptId":"REPO"}')
  fs.writeFileSync(path.join(cwd, 'appsscript.json'), '{"timeZone":"Asia/Tokyo"}')

  addEnv('staging', { scriptId: 'S_STG', cwd, env: {} })

  assert.equal(fs.readFileSync(path.join(cwd, '.clasp.json'), 'utf-8'), '{"scriptId":"REPO"}')
  assert.equal(fs.readFileSync(path.join(cwd, 'appsscript.json'), 'utf-8'), '{"timeZone":"Asia/Tokyo"}')
})

/**
 * A fake `clasp` on PATH, exercising the create path (--type reaches only
 * `create-script`). Same shape as deploy.test.ts's fakeClasp.
 */
function fakeClasp(dir: string): string {
  const bin = path.join(dir, 'fakebin')
  fs.mkdirSync(bin, { recursive: true })
  const log = path.join(dir, 'clasp-calls.txt')
  fs.writeFileSync(
    path.join(bin, 'clasp'),
    `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
const cmd = args[0]
if (cmd === '--version') { process.exit(0) }
if (cmd === 'show-authorized-user') { console.log(JSON.stringify({ user: 'test' })); process.exit(0) }
if (cmd === 'create-script') { fs.writeFileSync('.clasp.json', JSON.stringify({ scriptId: 'S_NEW' })); process.exit(0) }
process.exit(0)
`,
    { mode: 0o755 }
  )
  return log
}

const calls = (log: string): string[] =>
  fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : []

/** Run with the fake clasp first on PATH. */
function withFakeClasp<T>(cwd: string, fn: () => T): T {
  const previous = process.env.PATH
  process.env.PATH = `${path.join(cwd, 'fakebin')}:${previous ?? ''}`
  try {
    return fn()
  } finally {
    process.env.PATH = previous
  }
}

test('--type is passed through to clasp create-script when given', () => {
  const cwd = workspace()
  const log = fakeClasp(cwd)

  withFakeClasp(cwd, () => addEnv('dev', { type: 'sheets', cwd, env: {} }))

  const createCall = calls(log).find((c) => c.startsWith('create-script'))
  assert.match(createCall!, /--type sheets/)
})

test('--type is omitted from clasp create-script when not given', () => {
  const cwd = workspace()
  const log = fakeClasp(cwd)

  withFakeClasp(cwd, () => addEnv('dev', { cwd, env: {} }))

  const createCall = calls(log).find((c) => c.startsWith('create-script'))
  assert.doesNotMatch(createCall!, /--type/)
})
