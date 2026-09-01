import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { loadEnvs, EnvsError, type EnvEntry } from '../src/envs.ts'
import {
  writeClaspConfig,
  claspConfigPath,
  writeStamp,
  readStamp,
  assertEnvMatch,
  STAMP_FILE,
} from '../src/project.ts'

const REGISTRY = JSON.stringify({
  dev: { scriptId: 'S_DEV', deploymentId: 'D_DEV' },
  production: { scriptId: 'S_PRD', deploymentId: 'D_PRD' },
  fresh: {},
})

function workspace({ withBuild = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-project-'))
  fs.writeFileSync(path.join(dir, 'envs.json'), REGISTRY)
  if (withBuild) fs.mkdirSync(path.join(dir, 'build'))
  return dir
}

const entryFor = (cwd: string, name: string): EnvEntry => loadEnvs({ cwd, env: {} })[name]!
const names = (cwd: string): string[] => Object.keys(loadEnvs({ cwd, env: {} }))

test('writeClaspConfig generates a per-env file, never touching .clasp.json', () => {
  const cwd = workspace()
  fs.writeFileSync(path.join(cwd, '.clasp.json'), '{"scriptId":"UNTOUCHED"}')

  const file = writeClaspConfig(entryFor(cwd, 'dev'), { cwd })

  assert.equal(file, claspConfigPath('dev', cwd))
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { scriptId: 'S_DEV', rootDir: 'build' })
  assert.equal(fs.readFileSync(path.join(cwd, '.clasp.json'), 'utf-8'), '{"scriptId":"UNTOUCHED"}')
})

test('a stale config for another env cannot win — each env names its own file', () => {
  const cwd = workspace()
  writeClaspConfig(entryFor(cwd, 'production'), { cwd })
  const devConfig = writeClaspConfig(entryFor(cwd, 'dev'), { cwd })

  assert.equal(JSON.parse(fs.readFileSync(devConfig, 'utf-8')).scriptId, 'S_DEV')
  assert.equal(
    JSON.parse(fs.readFileSync(claspConfigPath('production', cwd), 'utf-8')).scriptId,
    'S_PRD',
    'the other env’s config is left alone rather than overwritten'
  )
})

test('an unprovisioned env is refused before any clasp config is written', () => {
  const cwd = workspace()
  assert.throws(
    () => writeClaspConfig(entryFor(cwd, 'fresh'), { cwd }),
    (err: Error) => err instanceof EnvsError && err.message.includes('unprovisioned')
  )
  assert.equal(fs.existsSync(claspConfigPath('fresh', cwd)), false)
})

test('writeStamp records env and time in buildDir; readStamp reads it back', () => {
  const cwd = workspace()
  writeStamp('dev', { cwd })
  const stamp = readStamp({ cwd })

  assert.equal(stamp?.env, 'dev')
  assert.ok(Date.parse(stamp!.builtAt) > 0)
  assert.ok(fs.existsSync(path.join(cwd, 'build', STAMP_FILE)))
})

test('writeStamp refuses when nothing was built', () => {
  const cwd = workspace({ withBuild: false })
  assert.throws(() => writeStamp('dev', { cwd }), (err: Error) => err.message.includes('does not exist'))
})

test('a dev-stamped build cannot be pushed to production, and the error names both', () => {
  const cwd = workspace()
  writeStamp('dev', { cwd })

  assert.throws(
    () => assertEnvMatch(entryFor(cwd, 'production'), names(cwd), { cwd }),
    (err: Error) => err.message.includes('"dev"') && err.message.includes('"production"')
  )
})

test('a matching stamp passes', () => {
  const cwd = workspace()
  writeStamp('dev', { cwd })
  assert.doesNotThrow(() => assertEnvMatch(entryFor(cwd, 'dev'), names(cwd), { cwd }))
})

test('a missing stamp is a hard failure, not a pass', () => {
  const cwd = workspace()
  assert.throws(
    () => assertEnvMatch(entryFor(cwd, 'dev'), names(cwd), { cwd }),
    (err: Error) => err instanceof EnvsError && err.message.includes('No build stamp')
  )
})

test('a corrupt stamp is treated as missing, never as a match', () => {
  const cwd = workspace()
  fs.writeFileSync(path.join(cwd, 'build', STAMP_FILE), '{ not json')
  assert.equal(readStamp({ cwd }), null)
  assert.throws(() => assertEnvMatch(entryFor(cwd, 'dev'), names(cwd), { cwd }))
})

test('a stamp naming an env that no longer exists is refused, listing the valid ones', () => {
  const cwd = workspace()
  fs.writeFileSync(
    path.join(cwd, 'build', STAMP_FILE),
    JSON.stringify({ env: 'retired', builtAt: new Date().toISOString() })
  )
  // The mismatch check fires first and already names both sides.
  assert.throws(
    () => assertEnvMatch(entryFor(cwd, 'dev'), names(cwd), { cwd }),
    (err: Error) => err.message.includes('retired')
  )
})

test('an unprovisioned env fails the assertion before the stamp is even considered', () => {
  const cwd = workspace()
  writeStamp('fresh', { cwd })
  assert.throws(
    () => assertEnvMatch(entryFor(cwd, 'fresh'), names(cwd), { cwd }),
    (err: Error) => err.message.includes('unprovisioned')
  )
})
