import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { push, deploy } from '../src/deploy.ts'
import { EnvsError } from '../src/envs.ts'
import { writeStamp } from '../src/project.ts'

/**
 * A fake `clasp` on PATH. It records every invocation and answers with the
 * JSON shapes clasp 3.3.0 actually produces, so these tests exercise the whole
 * pipeline — argument construction included — without touching Google.
 */
function fakeClasp(dir: string, { failOn = '' }: { failOn?: string } = {}): string {
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
if (cmd === ${JSON.stringify(failOn)}) { process.stderr.write('fake clasp: refused\\n'); process.exit(1) }
if (cmd === 'push') { console.log(JSON.stringify(['build/Code.js', 'build/index.html', 'build/appsscript.json'])) }
else if (cmd === 'create-deployment') { console.log(JSON.stringify({ deploymentId: 'AKfyNEW', versionNumber: 7, description: args[args.indexOf('--description') + 1] })) }
else { console.log('[]') }
`,
    { mode: 0o755 }
  )
  return log
}

const calls = (log: string): string[] =>
  fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : []

/** A consumer whose build writes a file, so "did the build run?" is observable. */
function workspace(registry: Record<string, unknown>, { failOn = '' } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-deploy-'))
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify({
      name: 'consumer',
      version: '2.1.0',
      private: true,
      scripts: {
        build: `node -e "require('fs').mkdirSync('build',{recursive:true});require('fs').writeFileSync('build/built.txt','yes')"`,
        typecheck: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    })
  )
  fs.writeFileSync(path.join(cwd, 'envs.json'), JSON.stringify(registry, null, 2))
  fs.mkdirSync(path.join(cwd, 'build'), { recursive: true })
  const log = fakeClasp(cwd, { failOn })
  return { cwd, log }
}

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

const DEV_ONLY = { dev: { scriptId: 'S_DEV', deploymentId: '', allowLocalDeploy: true } }

test('push runs gate, build, assert, then clasp push — in that order', () => {
  const { cwd, log } = workspace(DEV_ONLY)
  const result = withFakeClasp(cwd, () => push('dev', { cwd, env: {} }))

  assert.equal(fs.existsSync(path.join(cwd, 'build', 'built.txt')), true, 'the build ran')
  assert.equal(result.files, 3, 'file count comes from clasp --json')
  assert.equal(calls(log).length, 1)
  assert.match(calls(log)[0]!, /^push --force --project .*clasp\.dev\.json --json$/)
})

test('the pushed config names the requested env explicitly', () => {
  const { cwd } = workspace({ ...DEV_ONLY, production: { scriptId: 'S_PRD', allowLocalDeploy: true } })
  withFakeClasp(cwd, () => push('production', { cwd, env: {} }))

  const config = JSON.parse(fs.readFileSync(path.join(cwd, 'clasp.production.json'), 'utf-8'))
  assert.equal(config.scriptId, 'S_PRD')
})

test('a build stamped for another env stops before clasp is invoked', () => {
  const { cwd, log } = workspace({ ...DEV_ONLY, production: { scriptId: 'S_PRD', allowLocalDeploy: true } })
  writeStamp('dev', { cwd })

  assert.throws(
    () => withFakeClasp(cwd, () => push('production', { cwd, env: {}, noBuild: true })),
    (err: Error) => err instanceof EnvsError && err.message.includes('"dev"')
  )
  assert.deepEqual(calls(log), [], 'clasp was never called')
})

test('--no-build skips gate and build but still asserts', () => {
  const { cwd, log } = workspace(DEV_ONLY)
  writeStamp('dev', { cwd })

  withFakeClasp(cwd, () => push('dev', { cwd, env: {}, noBuild: true }))

  assert.equal(fs.existsSync(path.join(cwd, 'build', 'built.txt')), false, 'no build ran')
  assert.equal(calls(log).length, 1)
})

test('--no-build with nothing ever built fails on the missing stamp, not on clasp', () => {
  const { cwd, log } = workspace(DEV_ONLY)
  assert.throws(
    () => withFakeClasp(cwd, () => push('dev', { cwd, env: {}, noBuild: true })),
    (err: Error) => err.message.includes('No build stamp')
  )
  assert.deepEqual(calls(log), [])
})

test('a failing gate stops before the build', () => {
  const { cwd, log } = workspace(DEV_ONLY)
  const pkg = path.join(cwd, 'package.json')
  const parsed = JSON.parse(fs.readFileSync(pkg, 'utf-8'))
  parsed.scripts.typecheck = 'node -e "process.exit(1)"'
  fs.writeFileSync(pkg, JSON.stringify(parsed))

  assert.throws(() => withFakeClasp(cwd, () => push('dev', { cwd, env: {} })), /gate failed/i)
  assert.equal(fs.existsSync(path.join(cwd, 'build', 'built.txt')), false)
  assert.deepEqual(calls(log), [])
})

test('an unprovisioned env never reaches clasp', () => {
  const { cwd, log } = workspace({ fresh: { scriptId: '' } })
  assert.throws(
    () => withFakeClasp(cwd, () => push('fresh', { cwd, env: {}, noBuild: true })),
    (err: Error) => err.message.includes('unprovisioned')
  )
  assert.deepEqual(calls(log), [])
})

test('deploy refuses a local deploy when allowLocalDeploy is false', () => {
  const { cwd, log } = workspace({ production: { scriptId: 'S_PRD', allowLocalDeploy: false } })

  assert.throws(
    () => withFakeClasp(cwd, () => deploy('production', { cwd, env: {}, yes: true })),
    (err: Error) => err instanceof EnvsError && err.message.includes('allowLocalDeploy')
  )
  assert.deepEqual(calls(log), [], 'refused before any work')
})

test('CI overrides allowLocalDeploy — the flag is about local machines', () => {
  const { cwd, log } = workspace({ production: { scriptId: 'S_PRD', allowLocalDeploy: false } })
  const result = withFakeClasp(cwd, () => deploy('production', { cwd, env: { CI: 'true' }, yes: true }))

  assert.equal(result.deploymentId, 'AKfyNEW')
  assert.equal(calls(log).length, 2, 'push then create-deployment')
})

test('an explicitly empty description is rejected', () => {
  const { cwd } = workspace(DEV_ONLY)
  assert.throws(
    () => withFakeClasp(cwd, () => deploy('dev', { cwd, env: {}, yes: true, description: '   ' })),
    (err: Error) => err.message.includes('empty')
  )
})

test('an omitted description is derived, never silently empty', () => {
  const { cwd, log } = workspace(DEV_ONLY)
  withFakeClasp(cwd, () => deploy('dev', { cwd, env: {}, yes: true }))

  const deployCall = calls(log).find((c) => c.startsWith('create-deployment'))!
  // No `v` is fabricated for a fallback version — only a tag can supply one.
  // The workspace is a bare temp dir, so the sha degrades to `-` rather than throwing.
  assert.match(deployCall, /--description 2\.1\.0-local \(-\)/, 'version from package.json plus a sha')
})

test('an explicit version wins over the package.json fallback', () => {
  const { cwd, log } = workspace(DEV_ONLY)
  withFakeClasp(cwd, () => deploy('dev', { cwd, env: {}, yes: true, version: 'v1.4.0-rc.1' }))

  const deployCall = calls(log).find((c) => c.startsWith('create-deployment'))!
  assert.match(deployCall, /--description v1\.4\.0-rc\.1 \(/, 'explicit value, prerelease intact')
})

test('a new deploymentId is written to envs.json, never to .clasp.json', () => {
  const { cwd } = workspace(DEV_ONLY)
  fs.writeFileSync(path.join(cwd, '.clasp.json'), '{"scriptId":"UNTOUCHED"}')

  const result = withFakeClasp(cwd, () => deploy('dev', { cwd, env: {}, yes: true }))

  assert.equal(result.persisted, true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, 'envs.json'), 'utf-8')).dev.deploymentId, 'AKfyNEW')
  assert.equal(fs.readFileSync(path.join(cwd, '.clasp.json'), 'utf-8'), '{"scriptId":"UNTOUCHED"}')
})

test('an existing deploymentId is updated in place, not created anew', () => {
  const { cwd, log } = workspace({ dev: { scriptId: 'S_DEV', deploymentId: 'AKfyOLD', allowLocalDeploy: true } })
  withFakeClasp(cwd, () => deploy('dev', { cwd, env: {}, yes: true }))

  const deployCall = calls(log).find((c) => c.startsWith('create-deployment'))!
  assert.match(deployCall, /--deploymentId AKfyOLD/)
})

test('push succeeding but deploy failing says the previous version is still served', () => {
  const { cwd } = workspace(DEV_ONLY, { failOn: 'create-deployment' })

  assert.throws(
    () => withFakeClasp(cwd, () => deploy('dev', { cwd, env: {}, yes: true })),
    (err: Error) =>
      err.message.includes('previous version is still being served') && err.message.includes('--no-build')
  )
})

test('a declined confirmation deploys nothing and is not an error', () => {
  const { cwd, log } = workspace(DEV_ONLY)
  const result = withFakeClasp(cwd, () =>
    deploy('dev', { cwd, env: {}, confirm: () => false })
  )

  assert.equal(result.declined, true)
  assert.deepEqual(calls(log), [], 'nothing ran')
})

test('--yes bypasses the confirmation entirely', () => {
  const { cwd } = workspace(DEV_ONLY)
  let asked = false
  const result = withFakeClasp(cwd, () =>
    deploy('dev', { cwd, env: {}, yes: true, confirm: () => { asked = true; return false } })
  )

  assert.equal(asked, false, 'the prompt must not even be reached')
  assert.equal(result.declined, undefined)
})
