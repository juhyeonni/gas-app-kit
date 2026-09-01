import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

const REGISTRY = JSON.stringify({
  dev: { scriptId: 'S_DEV', deploymentId: 'D_DEV' },
  staging: { scriptId: 'S_STG' },
  fresh: {},
})

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-cli-'))
  fs.writeFileSync(path.join(dir, 'envs.json'), REGISTRY)
  return dir
}

/** PATH is emptied so clasp can never be found — `envs` must still work. */
function run(args, { cwd = workspace(), env = {} } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, PATH: '', ...env },
  })
  return { ...result, out: `${result.stdout}${result.stderr}` }
}

test('no command prints usage and exits with a usage error', () => {
  const { status, out } = run([])
  assert.equal(status, 2)
  assert.match(out, /Usage: gas-app/)
})

test('an unknown command names it and lists the valid ones', () => {
  const { status, out } = run(['bogus-command'])
  assert.equal(status, 2)
  assert.match(out, /Unknown command "bogus-command"/)
  assert.match(out, /envs, open/)
})

test('an unsupported flag is a usage error, not silently ignored', () => {
  const { status, out } = run(['envs', '--bogus'])
  assert.equal(status, 2)
  assert.match(out, /Unknown option '--bogus'/)
})

test('--help exits 0 and --version prints the package version', () => {
  assert.equal(run(['envs', '--help']).status, 0)
  const version = run(['--version'])
  assert.equal(version.status, 0)
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/)
})

test('envs lists every entry, including an unprovisioned one, without clasp', () => {
  const { status, out } = run(['envs'])
  assert.equal(status, 0)
  assert.match(out, /dev\s+deployed \(version unknown\)/)
  assert.match(out, /staging\s+undeployed/)
  assert.match(out, /fresh\s+unprovisioned/, 'an empty entry must be listed, not hidden')
})

test('envs preserves registry order', () => {
  const { stdout } = run(['envs'])
  const order = stdout.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean)
  assert.deepEqual(order.slice(0, 3), ['dev', 'staging', 'fresh'])
})

test('a missing registry fails with a remedy and exit 1', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-empty-'))
  const { status, out } = run(['envs'], { cwd: empty })
  assert.equal(status, 1)
  assert.match(out, /envs add/)
})

test('the env var overrides the file for the CLI too', () => {
  const { out } = run(['envs'], { env: { KANBEE_ENVS_JSON: JSON.stringify({ only: { scriptId: 'S' } }) } })
  assert.match(out, /only/)
  assert.doesNotMatch(out, /staging/)
})

test('open <env> prints both URLs', () => {
  const { status, stdout } = run(['open', 'dev'])
  assert.equal(status, 0)
  assert.match(stdout, /script\.google\.com\/home\/projects\/S_DEV\/edit/)
  assert.match(stdout, /macros\/s\/D_DEV\/exec/)
})

test('open on an undeployed env refuses, naming it, and still offers the editor', () => {
  const { status, out } = run(['open', 'staging'])
  assert.equal(status, 1)
  assert.match(out, /"staging" is undeployed/)
  assert.match(out, /S_STG/)
})

test('open with no env prints every entry in registry order', () => {
  const { status, stdout } = run(['open'])
  assert.equal(status, 0)
  assert.ok(stdout.indexOf('dev') < stdout.indexOf('staging'))
  assert.match(stdout, /\(undeployed\)/)
  assert.match(stdout, /\(unprovisioned\)/)
})

test('open on an unknown env lists the valid names', () => {
  const { status, out } = run(['open', 'nonsense'])
  assert.equal(status, 1)
  assert.match(out, /dev, staging, fresh/)
})

test('envs add registers an existing project through the CLI', () => {
  const cwd = workspace()
  const { status, out } = run(['envs', 'add', 'canary', '--script-id', 'S_NEW'], { cwd })
  assert.equal(status, 0)
  assert.match(out, /registered "canary" → S_NEW/)

  const registry = JSON.parse(fs.readFileSync(path.join(cwd, 'envs.json'), 'utf-8'))
  assert.equal(registry.canary.scriptId, 'S_NEW')
  assert.deepEqual(Object.keys(registry), ['dev', 'staging', 'fresh', 'canary'], 'appended, order kept')
})

test('envs add without a name is a usage error', () => {
  const { status, out } = run(['envs', 'add'])
  assert.equal(status, 2)
  assert.match(out, /Usage: gas-app envs add/)
})

test('envs add refuses to overwrite without --force, exiting 1', () => {
  const cwd = workspace()
  const { status, out } = run(['envs', 'add', 'dev', '--script-id', 'OTHER'], { cwd })
  assert.equal(status, 1)
  assert.match(out, /--force/)
})

test('an unknown envs subcommand is a usage error, not a silent listing', () => {
  const { status, out } = run(['envs', 'addd', '--script-id', 'S'])
  assert.equal(status, 2)
  assert.match(out, /Unknown subcommand "envs addd"/)
})
