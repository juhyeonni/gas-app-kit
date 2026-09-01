import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

import { resolveVersion, collectBuildInfo, formatDescription } from '../src/version.ts'

/**
 * Real git repositories, not a mocked seam. `git describe --tags --exact-match`
 * is precisely what is under test here — a stub would only prove the stub was
 * called. Repos are local, need no network, and are torn down by the OS.
 */
function repo(pkg: Record<string, unknown> | null = { name: 'c', version: '2.1.0' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-version-'))
  if (pkg !== null) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  }
  return dir
}

function git(dir: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** A repo with one commit. Identity is passed per-invocation so a developer's global config is irrelevant. */
function initRepo(dir: string) {
  git(dir, 'init', '--quiet', '--initial-branch', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'one\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '--quiet', '-m', 'first')
  return dir
}

function tagged(tag: string, pkg?: Record<string, unknown>) {
  const dir = initRepo(repo(pkg))
  git(dir, 'tag', tag)
  return dir
}

// ── resolveVersion: precedence ────────────────────────────────────────────────

test('an explicit value beats both tag and package.json, and says so', () => {
  const cwd = tagged('v9.9.9')
  const spec = resolveVersion({ explicit: 'v1.4.0', cwd, processEnv: {} })

  assert.deepEqual(spec, { value: 'v1.4.0', source: 'flag' })
})

test('a blank explicit value is treated as absent, not as a version', () => {
  const cwd = tagged('v1.4.0')

  assert.equal(resolveVersion({ explicit: '   ', cwd, processEnv: {} }).source, 'tag')
})

test('an exact-match tag is returned verbatim, leading v intact', () => {
  const cwd = tagged('v1.4.0')
  const spec = resolveVersion({ cwd, processEnv: {} })

  assert.deepEqual(spec, { value: 'v1.4.0', source: 'tag' })
})

test('a prerelease tag keeps its full identifier, never truncated', () => {
  const cwd = tagged('v1.4.0-rc.1')

  assert.equal(resolveVersion({ cwd, processEnv: {} }).value, 'v1.4.0-rc.1')
})

test('a tag that is not semver-shaped is used verbatim, not rejected', () => {
  const cwd = tagged('release-42')
  const spec = resolveVersion({ cwd, processEnv: {} })

  assert.deepEqual(spec, { value: 'release-42', source: 'tag' })
})

test('a tag on an earlier commit does not count as this build s version', () => {
  const cwd = tagged('v1.4.0')
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'two\n')
  git(cwd, 'commit', '--quiet', '-am', 'second')

  // --exact-match, not --abbrev=0: only a tag *at HEAD* is a release.
  assert.deepEqual(resolveVersion({ cwd, processEnv: {} }), { value: '2.1.0-local', source: 'local' })
})

// ── resolveVersion: the fallback tier and its marker ──────────────────────────

test('no tag outside CI falls back to package.json marked -local', () => {
  const cwd = initRepo(repo())

  assert.deepEqual(resolveVersion({ cwd, processEnv: {} }), { value: '2.1.0-local', source: 'local' })
})

test('no tag inside CI is marked -untagged, never -local', () => {
  const cwd = initRepo(repo())
  const spec = resolveVersion({ cwd, processEnv: { CI: 'true' } })

  // A CI artefact labelled as a laptop build sends readers hunting for
  // uncommitted changes that do not exist.
  assert.deepEqual(spec, { value: '2.1.0-untagged', source: 'local' })
})

test('a tag wins over the CI marker — CI only shapes the fallback', () => {
  const cwd = tagged('v1.4.0')

  assert.equal(resolveVersion({ cwd, processEnv: { CI: 'true' } }).value, 'v1.4.0')
})

test('outside a git repository, resolution still returns a value', () => {
  const cwd = repo()

  assert.deepEqual(resolveVersion({ cwd, processEnv: {} }), { value: '2.1.0-local', source: 'local' })
})

test('no package.json, no tag: a degraded value rather than a throw', () => {
  const cwd = repo(null)
  const spec = resolveVersion({ cwd, processEnv: {} })

  // `-` reads as the absence of a version, which is the truth. `--local` would
  // read as a version.
  assert.deepEqual(spec, { value: '-', source: 'local' })
})

test('a malformed package.json degrades the same way', () => {
  const cwd = repo(null)
  fs.writeFileSync(path.join(cwd, 'package.json'), '{ not json')

  assert.equal(resolveVersion({ cwd, processEnv: {} }).value, '-')
})

test('a package.json with no version field degrades rather than reading undefined', () => {
  const cwd = repo({ name: 'c' })

  assert.equal(resolveVersion({ cwd, processEnv: {} }).value, '-')
})

// ── collectBuildInfo ─────────────────────────────────────────────────────────

test('every field is present without the CLI in the loop', () => {
  const cwd = tagged('v1.4.0')
  const info = collectBuildInfo({ env: 'dev', cwd, processEnv: {} })

  assert.deepEqual(Object.keys(info).sort(), ['branch', 'builtAt', 'commit', 'dirty', 'env', 'version'])
  assert.equal(info.env, 'dev')
  assert.equal(info.branch, 'main')
  assert.match(info.commit, /^[0-9a-f]{7,}$/)
  assert.equal(info.dirty, false)
})

test('the leading v is stripped for BuildInfo.version, prerelease intact', () => {
  const cwd = tagged('v1.4.0-rc.1')

  assert.equal(collectBuildInfo({ env: 'dev', cwd, processEnv: {} }).version, '1.4.0-rc.1')
})

test('a v that is not a version prefix survives', () => {
  const cwd = tagged('verify-2')

  // Stripping is conditional on a digit following the `v`; a blanket strip
  // would silently mangle this.
  assert.equal(collectBuildInfo({ env: 'dev', cwd, processEnv: {} }).version, 'verify-2')
})

test('an uncommitted change makes the build dirty', () => {
  const cwd = initRepo(repo())
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'changed\n')

  assert.equal(collectBuildInfo({ env: 'dev', cwd, processEnv: {} }).dirty, true)
})

test('an untracked file also counts as dirty', () => {
  const cwd = initRepo(repo())
  fs.writeFileSync(path.join(cwd, 'stray.txt'), 'x\n')

  assert.equal(collectBuildInfo({ env: 'dev', cwd, processEnv: {} }).dirty, true)
})

test('without git, fields degrade to - and nothing throws', () => {
  const cwd = repo()
  const info = collectBuildInfo({ env: 'production', cwd, processEnv: {} })

  assert.equal(info.commit, '-')
  assert.equal(info.branch, '-')
  // Absence of evidence is not dirtiness.
  assert.equal(info.dirty, false)
  assert.equal(info.env, 'production')
})

test('a detached HEAD falls back to GITHUB_REF_NAME', () => {
  const cwd = initRepo(repo())
  git(cwd, 'checkout', '--quiet', '--detach', 'HEAD')
  const info = collectBuildInfo({ env: 'dev', cwd, processEnv: { GITHUB_REF_NAME: 'release/1.4' } })

  assert.equal(info.branch, 'release/1.4')
})

test('a detached HEAD with no CI ref reports HEAD rather than an empty string', () => {
  const cwd = initRepo(repo())
  git(cwd, 'checkout', '--quiet', '--detach', 'HEAD')

  assert.equal(collectBuildInfo({ env: 'dev', cwd, processEnv: {} }).branch, 'HEAD')
})

test('a branch name containing a quote survives serialisation', () => {
  const cwd = initRepo(repo())
  git(cwd, 'checkout', '--quiet', '-b', "feat/o'brien")
  const info = collectBuildInfo({ env: 'dev', cwd, processEnv: {} })

  assert.equal(info.branch, "feat/o'brien")
  assert.equal(JSON.parse(JSON.stringify(info)).branch, "feat/o'brien")
})

test('builtAt keeps the JST rendering banners are compared against', () => {
  const cwd = initRepo(repo())

  assert.match(
    collectBuildInfo({ env: 'dev', cwd, processEnv: {} }).builtAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+09:00$/
  )
})

test('an explicit version flows through to BuildInfo, v-stripped', () => {
  const cwd = tagged('v9.9.9')

  assert.equal(collectBuildInfo({ env: 'dev', explicit: 'v1.4.0', cwd, processEnv: {} }).version, '1.4.0')
})

// ── formatDescription ────────────────────────────────────────────────────────

test('a tag renders as {tag} ({shortSha})', () => {
  assert.equal(formatDescription({ value: 'v1.4.0', source: 'tag' }, 'abc1234'), 'v1.4.0 (abc1234)')
})

test('a prerelease is not truncated in the description', () => {
  assert.equal(
    formatDescription({ value: 'v1.4.0-rc.1', source: 'tag' }, 'abc1234'),
    'v1.4.0-rc.1 (abc1234)'
  )
})

test('no v is fabricated for a fallback version', () => {
  assert.equal(formatDescription({ value: '1.3.1-local', source: 'local' }, 'abc1234'), '1.3.1-local (abc1234)')
  assert.equal(
    formatDescription({ value: '1.3.1-untagged', source: 'local' }, 'abc1234'),
    '1.3.1-untagged (abc1234)'
  )
})

test('a missing sha renders as - rather than throwing', () => {
  assert.equal(formatDescription({ value: 'v1.4.0', source: 'tag' }, null), 'v1.4.0 (-)')
  assert.equal(formatDescription({ value: 'v1.4.0', source: 'tag' }, '  '), 'v1.4.0 (-)')
  assert.equal(formatDescription({ value: 'v1.4.0', source: 'tag' }), 'v1.4.0 (-)')
})

// ── the property the whole bolt exists for ───────────────────────────────────

test('description and banner version cannot disagree about one resolution', () => {
  const cwd = tagged('v1.4.0-rc.1')

  const spec = resolveVersion({ cwd, processEnv: {} })
  const info = collectBuildInfo({ env: 'dev', cwd, processEnv: {} })
  const description = formatDescription(spec, info.commit)

  // Two renderings, one value: the description keeps the `v`, the banner drops it.
  assert.equal(description, `v1.4.0-rc.1 (${info.commit})`)
  assert.equal(info.version, '1.4.0-rc.1')
  assert.equal(`v${info.version}`, spec.value)
})
