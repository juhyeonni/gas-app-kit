import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  toCandidates,
  currentVersionOf,
  formatVersions,
  listVersions,
  rollback,
  DEFAULT_VERSION_LIMIT,
} from '../src/rollback.ts'

const ENVS = {
  dev: { scriptId: 'script-1', deploymentId: 'AKfyV2', allowLocalDeploy: true },
  production: { scriptId: 'script-1', deploymentId: 'AKfyV3', allowLocalDeploy: false },
}

/** A consumer directory with a registry and a fake clasp on PATH. */
function workspace(envs: unknown = ENVS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-rollback-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'c', private: true }))
  fs.writeFileSync(path.join(dir, 'envs.json'), JSON.stringify(envs))
  fs.mkdirSync(path.join(dir, 'build'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'appsscript.json'), '{"timeZone":"Asia/Tokyo"}')
  fs.writeFileSync(path.join(dir, 'build', 'appsscript.json'), '{"timeZone":"Asia/Tokyo"}')
  return dir
}

/**
 * A clasp stand-in on PATH. `list-deployments` returns `rows`; every other
 * invocation echoes its argv to `log` so the assertions can read what was run.
 */
function withFakeClasp<T>(rows: unknown[], run: (log: string) => T, versionRows: unknown[] = VERSIONS): T {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-bin-'))
  const log = path.join(bin, 'calls.log')
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
if (args[0] === 'list-versions') {
  console.log(JSON.stringify(${JSON.stringify(versionRows)}))
} else if (args[0] === 'list-deployments') {
  console.log(JSON.stringify(${JSON.stringify(rows)}))
} else {
  console.log(JSON.stringify({ deploymentId: args[args.indexOf('--deploymentId') + 1], versionNumber: Number(args[args.indexOf('--versionNumber') + 1]) }))
}
`
  fs.writeFileSync(path.join(bin, 'clasp'), script, { mode: 0o755 })
  const previous = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${previous}`
  try {
    return run(log)
  } finally {
    process.env.PATH = previous
  }
}

const calls = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n') : [])

/** `list-versions`: the rollback candidates. Versions are immutable snapshots. */
const VERSIONS = [
  { versionNumber: 3, description: 'v1.2.0 (ccc3333)' },
  { versionNumber: 1, description: 'v1.0.0 (aaa1111)' },
  { versionNumber: 2, description: 'v1.1.0 (bbb2222)' },
]

/** `list-deployments`: pointers. One @HEAD plus the env's own, serving v2. */
const ROWS = [
  { deploymentId: 'AKfyHEAD' },
  { deploymentId: 'AKfyV2', versionNumber: 2, description: 'v1.1.0 (bbb2222)' },
]

// ── partitioning ─────────────────────────────────────────────────────────────

test('candidates come back newest first', () => {
  assert.deepEqual(
    toCandidates(VERSIONS).map((v) => v.versionNumber),
    [3, 2, 1]
  )
})

test('a missing description becomes a readable placeholder, not empty space', () => {
  assert.equal(toCandidates([{ versionNumber: 4 }])[0]?.description, '(no description)')
})

test('a project with no versions yields no candidates', () => {
  assert.deepEqual(toCandidates([]), [])
})

test('a deployment with no versionNumber is @HEAD, reported not selected', () => {
  // A brand-new project reports a deployment immediately (bolt 044, fact 01).
  assert.deepEqual(currentVersionOf([{ deploymentId: 'AKfyHEAD' }], 'AKfyHEAD'), {
    versionNumber: undefined,
    isHead: true,
  })
})

test('candidates are read from list-versions, not from the deployment list', () => {
  // The shortcut that looks right and is not: one reused deployment id reports
  // a single row no matter how many versions exist behind it.
  const cwd = workspace()
  const result = withFakeClasp(ROWS, () => listVersions('dev', { cwd, env: {} }))

  assert.equal(result.total, 3, 'three versions behind one deployment pointer')
})

// ── listing ──────────────────────────────────────────────────────────────────

test('the served version is marked and the rest are not', () => {
  const cwd = workspace()
  const result = withFakeClasp(ROWS, () => listVersions('dev', { cwd, env: {} }))

  assert.equal(result.current?.versionNumber, 2)
  const lines = formatVersions(result)
  assert.match(lines.find((l) => l.includes(' 2 '))!, /→/)
  assert.doesNotMatch(lines.find((l) => l.includes(' 3 '))!, /→/)
})

test('a truncated listing says how many it hid', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    versionNumber: i + 1,
    description: `v0.0.${i + 1}`,
  }))
  const cwd = workspace()
  const result = withFakeClasp(ROWS, () => listVersions('dev', { cwd, env: {} }), many)

  assert.equal(result.versions.length, DEFAULT_VERSION_LIMIT)
  assert.equal(result.total, 30)
  // A truncated list that looks complete is how someone concludes their version is gone.
  assert.match(formatVersions(result).at(-1)!, /15 older version\(s\) not shown/)
})

test('a deployment pointing at HEAD is reported as such, not as "unknown"', () => {
  const cwd = workspace({ dev: { scriptId: 's', deploymentId: 'AKfyHEAD', allowLocalDeploy: true } })
  const result = withFakeClasp(ROWS, () => listVersions('dev', { cwd, env: {} }))

  assert.equal(result.currentIsHead, true)
  assert.equal(result.current, undefined)
})

// ── rollback ─────────────────────────────────────────────────────────────────

test('a rollback repoints the deployment and runs no build', () => {
  const cwd = workspace()
  const log = withFakeClasp(ROWS, (log) => {
    rollback('dev', 3, { cwd, env: {}, yes: true })
    return log
  })

  const call = calls(log).find((c) => c.startsWith('create-deployment'))!
  assert.match(call, /--deploymentId AKfyV2/)
  assert.match(call, /--versionNumber 3/)
  assert.match(call, /--description v1\.2\.0 \(ccc3333\)/, 'the target’s own description, not a new one')
  // No build output appeared: the tree is exactly what the workspace created.
  assert.deepEqual(fs.readdirSync(path.join(cwd, 'build')).sort(), ['appsscript.json'])
})

test('rolling back to the version already served is a stated no-op, exit 0', () => {
  const cwd = workspace()
  const result = withFakeClasp(ROWS, () => rollback('dev', 2, { cwd, env: {}, yes: true }))

  assert.equal(result.noop, true)
})

test('an absent target names the versions that do exist', () => {
  const cwd = workspace()

  assert.throws(
    () => withFakeClasp(ROWS, () => rollback('dev', 42, { cwd, env: {}, yes: true })),
    // "Version 42 not found" is useless under pressure; this is the product.
    /Available: 3 \(v1\.2\.0 \(ccc3333\)\), 2 \(v1\.1\.0 \(bbb2222\)\), 1 \(v1\.0\.0 \(aaa1111\)\)/
  )
})

test('@HEAD cannot be selected as a target', () => {
  const cwd = workspace()

  // @HEAD has no version number, so no numeric argument can ever reach it.
  assert.throws(
    () => withFakeClasp(ROWS, () => rollback('dev', 0, { cwd, env: {}, yes: true })),
    /Version 0 is not a version of/
  )
})

test('a project with only @HEAD refuses, explaining why', () => {
  const cwd = workspace()

  assert.throws(
    () => withFakeClasp(ROWS, () => rollback('dev', 1, { cwd, env: {}, yes: true }), []),
    /pointing a deployment at HEAD is not a rollback/
  )
})

test('a declined confirmation changes nothing', () => {
  const cwd = workspace()
  const log = withFakeClasp(ROWS, (log) => {
    const result = rollback('dev', 3, { cwd, env: {}, confirm: () => false })
    assert.equal(result.declined, true)
    return log
  })

  assert.equal(calls(log).some((c) => c.startsWith('create-deployment')), false)
})

test('--yes bypasses the confirmation entirely', () => {
  const cwd = workspace()
  const log = withFakeClasp(ROWS, (log) => {
    rollback('dev', 3, {
      cwd,
      env: {},
      yes: true,
      // Automated recovery is impossible if a prompt can still fire.
      confirm: () => assert.fail('confirm must not be called when --yes is given'),
    })
    return log
  })

  assert.equal(calls(log).some((c) => c.startsWith('create-deployment')), true)
})

test('the confirmation names both the current and the target version', () => {
  const cwd = workspace()
  let asked = ''
  withFakeClasp(ROWS, () =>
    rollback('dev', 3, {
      cwd,
      env: {},
      confirm: (q) => {
        asked = q
        return false
      },
    })
  )

  assert.match(asked, /from 2 \(v1\.1\.0 \(bbb2222\)\) to 3 \(v1\.2\.0 \(ccc3333\)\)/)
})

test('an unprovisioned environment refuses before calling clasp', () => {
  const cwd = workspace({ dev: { scriptId: '', deploymentId: '', allowLocalDeploy: true } })

  assert.throws(() => listVersions('dev', { cwd, env: {} }), /unprovisioned/)
})

test('the rollback module does not import the build path', async () => {
  // The single property that makes this usable during an incident is that no
  // build runs. A stray import that pulls build.ts back in is a real regression.
  const source = fs.readFileSync(new URL('../src/rollback.ts', import.meta.url), 'utf-8')

  assert.doesNotMatch(source, /from '\.\/build\.ts'/)
  assert.doesNotMatch(source, /from '\.\/deploy\.ts'/)
  assert.doesNotMatch(source, /from '\.\/gate\.ts'/)
})

