import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { resolveBuildCommand, runBuild } from '../src/build.ts'
import { readStamp } from '../src/project.ts'
import { EnvsError } from '../src/envs.ts'

/**
 * A consumer whose "build" writes a marker recording the BUILD_ENV it saw —
 * the only thing that proves the wrapper propagated it to the child.
 */
function consumer(pkg: Record<string, unknown>, { withBuildDir = 'build' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-build-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'c', private: true, ...pkg }, null, 2))
  if (withBuildDir) fs.mkdirSync(path.join(dir, withBuildDir), { recursive: true })
  return dir
}

const MARKER = 'node -e "require(\'fs\').writeFileSync(\'build/marker.txt\', process.env.BUILD_ENV ?? \'unset\')"'

test('resolves the plain build script with zero configuration', () => {
  const cwd = consumer({ scripts: { build: 'echo hi' } })
  const target = resolveBuildCommand(cwd)

  assert.equal(target.script, 'build')
  assert.equal(target.source, 'scripts.build')
  assert.equal(target.buildDir, 'build')
})

test('gasApp.build wins over the plain build script', () => {
  const cwd = consumer({ scripts: { build: 'echo plain', 'custom:script': 'echo custom' }, gasApp: { build: 'custom:script' } })
  const target = resolveBuildCommand(cwd)

  assert.equal(target.script, 'custom:script')
  assert.equal(target.source, 'gasApp.build')
})

test('gasApp.buildDir overrides the default', () => {
  const cwd = consumer({ scripts: { build: 'echo hi' }, gasApp: { buildDir: 'dist' } })
  assert.equal(resolveBuildCommand(cwd).buildDir, 'dist')
})

test('a self-referential build command is rejected before anything is spawned', () => {
  const cwd = consumer({ scripts: { build: 'gas-app build dev' } })
  assert.throws(
    () => resolveBuildCommand(cwd),
    (err: Error) => err instanceof EnvsError && err.message.includes('loop')
  )
})

test('a build script that shells out to gas-app push is caught too', () => {
  const cwd = consumer({ scripts: { build: 'npm run gen && gas-app push dev' } })
  assert.throws(() => resolveBuildCommand(cwd))
})

test('a missing build script names both places that were checked', () => {
  const cwd = consumer({ scripts: { test: 'true' } })
  assert.throws(
    () => resolveBuildCommand(cwd),
    (err: Error) => err.message.includes('gasApp.build') && err.message.includes('"build" script')
  )
})

test('gasApp.build naming a nonexistent script fails at resolution', () => {
  const cwd = consumer({ scripts: { build: 'echo hi' }, gasApp: { build: 'nope' } })
  assert.throws(
    () => resolveBuildCommand(cwd),
    (err: Error) => err.message.includes('"nope"')
  )
})

test('detects the package manager from a lockfile', () => {
  const cwd = consumer({ scripts: { build: 'echo hi' } })
  fs.writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), '')
  assert.equal(resolveBuildCommand(cwd).packageManager, 'pnpm')
})

test('the packageManager field wins over lockfile detection', () => {
  const cwd = consumer({ scripts: { build: 'echo hi' }, packageManager: 'yarn@4.1.0' })
  fs.writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), '')
  assert.equal(resolveBuildCommand(cwd).packageManager, 'yarn')
})

test('runBuild passes BUILD_ENV to the child and stamps on success', () => {
  const cwd = consumer({ scripts: { build: MARKER } })
  const { stampPath } = runBuild('staging', { cwd })

  assert.equal(fs.readFileSync(path.join(cwd, 'build', 'marker.txt'), 'utf-8'), 'staging')
  assert.equal(readStamp({ cwd })?.env, 'staging')
  assert.ok(fs.existsSync(stampPath))
})

test('BUILD_ENV from the parent shell is overridden, not inherited', () => {
  const cwd = consumer({ scripts: { build: MARKER } })
  const previous = process.env.BUILD_ENV
  process.env.BUILD_ENV = 'production'
  try {
    runBuild('dev', { cwd })
  } finally {
    if (previous === undefined) delete process.env.BUILD_ENV
    else process.env.BUILD_ENV = previous
  }
  assert.equal(fs.readFileSync(path.join(cwd, 'build', 'marker.txt'), 'utf-8'), 'dev')
})

test('a failing build writes no stamp', () => {
  const cwd = consumer({ scripts: { build: 'node -e "process.exit(3)"' } })
  assert.throws(() => runBuild('dev', { cwd }), (err: Error) => err.message.includes('exited 3'))
  assert.equal(readStamp({ cwd }), null)
})

test('the stamp lands in gasApp.buildDir, not the default', () => {
  const cwd = consumer({ scripts: { build: 'echo hi' }, gasApp: { buildDir: 'dist' } }, { withBuildDir: 'dist' })
  runBuild('dev', { cwd })

  assert.equal(readStamp({ cwd, buildDir: 'dist' })?.env, 'dev')
  assert.equal(readStamp({ cwd }), null, 'nothing written to the default build/')
})
