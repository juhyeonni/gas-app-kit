import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { loadEnvs, saveEnvs, resolveEnv, envState, EnvsError, ENVS_ENV_VAR } from '../src/envs.ts'

function fixture(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-kit-'))
  if (contents !== undefined) fs.writeFileSync(path.join(dir, 'envs.json'), contents)
  return dir
}

const THREE_ENVS = JSON.stringify({
  dev: { scriptId: 'S_DEV', deploymentId: 'D_DEV' },
  staging: { scriptId: 'S_STG', deploymentId: '', allowPrerelease: true },
  production: { scriptId: 'S_PRD', deploymentId: 'D_PRD', allowLocalDeploy: false },
})

test('loads entries from envs.json', () => {
  const registry = loadEnvs({ cwd: fixture(THREE_ENVS), env: {} })
  assert.equal(registry.dev.scriptId, 'S_DEV')
  assert.equal(registry.staging.allowPrerelease, true)
})

test('key insertion order is preserved, not sorted', () => {
  const registry = loadEnvs({ cwd: fixture(THREE_ENVS), env: {} })
  assert.deepEqual(Object.keys(registry), ['dev', 'staging', 'production'])
})

test('policy flags fail closed when absent or not literally true', () => {
  const cwd = fixture(JSON.stringify({ dev: { scriptId: 'S', allowLocalDeploy: 'true' } }))
  const entry = loadEnvs({ cwd, env: {} }).dev
  assert.equal(entry.allowLocalDeploy, false, 'string "true" must not grant permission')
  assert.equal(entry.allowPrerelease, false, 'absent flag defaults to false')
})

test('the env var wins over the file, verbatim', () => {
  const cwd = fixture(THREE_ENVS)
  const registry = loadEnvs({ cwd, env: { [ENVS_ENV_VAR]: JSON.stringify({ only: { scriptId: 'FROM_VAR' } }) } })
  assert.deepEqual(Object.keys(registry), ['only'])
  assert.equal(registry.only.scriptId, 'FROM_VAR')
})

test('a malformed env var names the variable, not the file', () => {
  const cwd = fixture(THREE_ENVS)
  assert.throws(
    () => loadEnvs({ cwd, env: { [ENVS_ENV_VAR]: '{ broken' } }),
    (err) => err instanceof EnvsError && err.message.includes(ENVS_ENV_VAR) && !err.message.includes('envs.json')
  )
})

test('a malformed file names the file', () => {
  const cwd = fixture('{ broken')
  assert.throws(
    () => loadEnvs({ cwd, env: {} }),
    (err) => err instanceof EnvsError && err.message.includes('envs.json')
  )
})

test('a missing file fails with a remedy, not a downstream error', () => {
  assert.throws(
    () => loadEnvs({ cwd: fixture(undefined), env: {} }),
    (err) => err instanceof EnvsError && err.message.includes('envs add')
  )
})

test('a non-object entry is rejected naming the env', () => {
  const cwd = fixture(JSON.stringify({ dev: 'S_DEV' }))
  assert.throws(() => loadEnvs({ cwd, env: {} }), (err) => err.message.includes('"dev"'))
})

test('an unknown env is refused with the valid names', () => {
  const registry = loadEnvs({ cwd: fixture(THREE_ENVS), env: {} })
  assert.throws(
    () => resolveEnv(registry, 'nonsense'),
    (err) => err instanceof EnvsError && err.message.includes('dev, staging, production')
  )
})

test('an entry with an empty scriptId loads fine and fails at use time', () => {
  const cwd = fixture(JSON.stringify({ dev: { scriptId: '' } }))
  const registry = loadEnvs({ cwd, env: {} })
  assert.equal(envState(registry.dev), 'unprovisioned')
  assert.equal(resolveEnv(registry, 'dev').scriptId, '')
})

test('envState distinguishes the three states', () => {
  const registry = loadEnvs({ cwd: fixture(THREE_ENVS), env: {} })
  assert.equal(envState(registry.dev), 'deployed')
  assert.equal(envState(registry.staging), 'undeployed')
  assert.equal(envState(loadEnvs({ cwd: fixture(JSON.stringify({ x: {} })), env: {} }).x), 'unprovisioned')
})

test('--envs path is honoured over the default location', () => {
  const dir = fixture(THREE_ENVS)
  fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ elsewhere: { scriptId: 'S' } }))
  const registry = loadEnvs({ cwd: dir, envsPath: 'other.json', env: {} })
  assert.deepEqual(Object.keys(registry), ['elsewhere'])
})

test('keys this tool does not recognise survive a save', () => {
  const cwd = fixture(
    JSON.stringify({
      dev: { scriptId: 'S_DEV', deploymentId: 'D_DEV', allowLocalDeploy: true, owner: 'team-a', note: 'keep me' },
    })
  )
  saveEnvs(loadEnvs({ cwd, env: {} }), { cwd, env: {} })

  const written = JSON.parse(fs.readFileSync(path.join(cwd, 'envs.json'), 'utf-8'))
  assert.equal(written.dev.owner, 'team-a')
  assert.equal(written.dev.note, 'keep me')
  assert.equal(written.dev.scriptId, 'S_DEV')
  assert.ok(!('name' in written.dev), 'the derived name is still never stored')
})

test('a recognised key still wins over what the file said', () => {
  // The flags must keep failing closed; carrying unknown keys must not make a
  // string "true" grant permission by arriving through the spread.
  const cwd = fixture(JSON.stringify({ dev: { scriptId: ' S ', allowLocalDeploy: 'true' } }))
  const entry = loadEnvs({ cwd, env: {} }).dev
  assert.equal(entry.allowLocalDeploy, false)
  assert.equal(entry.scriptId, 'S')
})

test('envs.json is found from a subdirectory', () => {
  const root = fixture(THREE_ENVS)
  const deep = path.join(root, 'packages', 'reporting', 'src')
  fs.mkdirSync(deep, { recursive: true })

  const registry = loadEnvs({ cwd: deep, env: {} })
  assert.deepEqual(Object.keys(registry), ['dev', 'staging', 'production'])
})

test('a save from a subdirectory writes the registry it read, not a new one', () => {
  const root = fixture(THREE_ENVS)
  const deep = path.join(root, 'sub')
  fs.mkdirSync(deep)

  const registry = loadEnvs({ cwd: deep, env: {} })
  registry.dev.deploymentId = 'D_NEW'
  const written = saveEnvs(registry, { cwd: deep, env: {} })

  assert.equal(written, path.join(root, 'envs.json'))
  assert.equal(fs.existsSync(path.join(deep, 'envs.json')), false, 'no second registry beside the subdirectory')
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'envs.json'), 'utf-8')).dev.deploymentId, 'D_NEW')
})

test('no registry anywhere up the tree names the search, not just the file', () => {
  const cwd = fixture(undefined)
  assert.throws(
    () => loadEnvs({ cwd, env: {} }),
    (err: unknown) => err instanceof EnvsError && /any parent directory/.test((err as Error).message)
  )
})
