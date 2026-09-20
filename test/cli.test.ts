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
  const { out } = run(['envs'], { env: { GAS_APP_ENVS_JSON: JSON.stringify({ only: { scriptId: 'S' } }) } })
  assert.match(out, /only/)
  assert.doesNotMatch(out, /staging/)
})

test('open <env> prints both URLs', () => {
  const { status, stdout } = run(['open', 'dev'])
  assert.equal(status, 0)
  assert.match(stdout, /script\.google\.com\/home\/projects\/S_DEV\/edit/)
  assert.match(stdout, /macros\/s\/D_DEV\/exec/)
})

test('open on an undeployed env prints what exists and exits 0', () => {
  // Same state, same information, same exit code as the argument-less listing —
  // which is what makes `open` safe to wrap in an alias under `set -e`.
  const { status, out } = run(['open', 'staging'])
  assert.equal(status, 0)
  assert.match(out, /S_STG/, 'the editor URL it does have is printed')
  assert.match(out, /undeployed/)
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
  assert.match(out, /"envs" takes no argument/)
})

test('the envs suggestion says that creating an environment provisions a project', () => {
  // A "did you mean" is taken on trust, and `envs list` is a common guess. The
  // suggestion must not send someone into creating a Drive project called "list"
  // without saying that is what it does.
  const { out } = run(['envs', 'list'])
  assert.match(out, /gas-app envs\n/, 'the harmless option is offered too')
  assert.match(out, /create a new Apps Script project named "list" in your Drive/)
})

test('--version next to a command is a usage error, not a silent no-op', () => {
  const { status, out } = run(['deploy', 'dev', '--version', '1.2.3'])
  assert.equal(status, 2)
  assert.match(out, /--description/)
})

test('a bare --help goes to stdout and exits 0', () => {
  const { status, stdout, stderr } = run(['--help'])
  assert.equal(status, 0)
  assert.match(stdout, /Usage: gas-app/)
  assert.equal(stderr, '')
})

test('--help lists every flag that actually acts', () => {
  const { stdout } = run(['--help'])
  for (const flag of ['--skip-checks', '--no-build', '--description', '--yes']) {
    assert.ok(stdout.includes(flag), `--help must list ${flag}`)
  }
})

test('a real flag aimed at a command that ignores it is a usage error', () => {
  const { status, out } = run(['push', 'dev', '--yes'])
  assert.equal(status, 2)
  assert.match(out, /does not take --yes/)
})

test('a filesystem failure is a refusal, not a raw Node stack trace', () => {
  const { status, out } = run(['envs', 'add', 'qa', '--script-id', 'S_QA', '--envs', 'no/such/dir/envs.json'])
  assert.equal(status, 1)
  assert.match(out, /ENOENT/)
  assert.doesNotMatch(out, /at Module\./, 'the stack trace must not reach the user')
})

test('--help on a command shows that command, not the global page', () => {
  const { status, stdout } = run(['push', '--help'])
  assert.equal(status, 0)
  assert.match(stdout, /Usage: gas-app push <env>/)
  assert.match(stdout, /--skip-checks/)
  assert.match(stdout, /--no-build/)
  assert.doesNotMatch(stdout, /--script-id/, 'a flag push does not take must not be listed')
  assert.doesNotMatch(stdout, /^Commands:/m, 'the command list belongs to the global page')
})

test('envs add has its own help, separate from the envs listing', () => {
  const { status, stdout } = run(['envs', 'add', '--help'])
  assert.equal(status, 0)
  assert.match(stdout, /Usage: gas-app envs add <name>/)
  for (const flag of ['--script-id', '--title', '--type', '--force']) {
    assert.match(stdout, new RegExp(flag.replace(/-/g, '\\-')))
  }
})

test('bare --help still lists every command', () => {
  const { status, stdout } = run(['--help'])
  assert.equal(status, 0)
  assert.match(stdout, /Commands:/)
  assert.match(stdout, /rollback/)
})

test('a command’s help and its accepted flags are the same list', () => {
  // The help is rendered from the list the stray-flag check reads, so these
  // cannot drift: --json is in versions' help and accepted, --yes is neither.
  assert.match(run(['versions', '--help']).stdout, /--json/)
  assert.equal(run(['versions', 'dev', '--yes']).status, 2)
})

test('envs --json prints one parseable object and nothing else', () => {
  const { status, stdout } = run(['envs', '--json'])
  assert.equal(status, 0)
  const parsed = JSON.parse(stdout)
  assert.deepEqual(Object.keys(parsed), ['dev', 'staging', 'fresh'])
  assert.equal(parsed.staging.state, 'undeployed')
  assert.equal(parsed.fresh.state, 'unprovisioned')
})

test('--json says why a version is unknown rather than leaving it blank', () => {
  const { stdout } = run(['envs', '--json'])
  const dev = JSON.parse(stdout).dev
  assert.equal(dev.state, 'deployed')
  assert.equal(dev.versionNumber, null, 'null, not omitted — "could not ask" is not "no version"')
  assert.match(dev.degraded, /clasp not found on PATH/)
})

test('a refused --json run writes no JSON at all', () => {
  // Either stdout parses or the command failed; never half an object.
  const { status, stdout } = run(['versions', 'dev', '--json'])
  assert.equal(status, 1)
  assert.equal(stdout.trim(), '')
})

test('a reader that stops early does not produce a crash', () => {
  const result = spawnSync('sh', ['-c', `"${process.execPath}" "${BIN}" --help | head -3`], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: process.env.PATH ?? '' },
  })
  assert.doesNotMatch(result.stderr, /EPIPE/)
  assert.match(result.stdout, /Usage: gas-app/)
})
