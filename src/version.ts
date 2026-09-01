/**
 * The version pipeline.
 *
 * One resolved version, rendered two ways. The measured failure this closes:
 * a consumer's `package.json` said `1.3.1`, its newest tag said `v1.1.0`, its
 * build banner read `package.json`, and its live deployment descriptions were
 * hand-typed (`"Dev"`, `"v1.3.1"`). Four sources, no agreement — and the defect
 * was never a missing computation, it was a missing *consumption*.
 *
 * So resolution happens in exactly one function with one fixed order, and both
 * downstream renderings derive from its result:
 *
 *   - `formatDescription` keeps the value verbatim, leading `v` and all, because
 *     it is read next to a releases page.
 *   - `collectBuildInfo` strips the leading `v`, because that field feeds a
 *     semver-shaped display that has never carried one.
 *
 * Keeping the v-stripping out of `resolveVersion` is deliberate: baking one
 * consumer's formatting into the shared primitive is how the two renderings
 * would drift again.
 *
 * Nothing here throws. A build must not fail because a version could not be
 * determined — it should ship an unmistakably broken-looking version instead,
 * which is visible, whereas a failed build at release time is just an outage.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

export type VersionSource = 'flag' | 'tag' | 'local'

export interface VersionSpec {
  /** The version as resolved, in its original form — `v` and prerelease intact. */
  value: string
  source: VersionSource
}

/** Everything that identifies one build. Six fields, no more. */
export interface BuildInfo {
  /** `value` with a leading `v` stripped. */
  version: string
  commit: string
  branch: string
  /** The build environment name, as supplied by the caller. */
  env: string
  builtAt: string
  dirty: boolean
}

export interface ResolveVersionOptions {
  /** Wins over every other tier. Blank is treated as absent, not as a version. */
  explicit?: string | undefined
  cwd?: string
  /** Process environment. Only `CI` is read, to pick the fallback marker. */
  processEnv?: NodeJS.ProcessEnv
}

export interface CollectBuildInfoOptions extends ResolveVersionOptions {
  /**
   * The build environment name — becomes `BuildInfo.env`. Always explicit: a
   * default here would be a hidden dependency on one env var name, which is
   * the thing this function exists to remove.
   */
  env: string
}

/**
 * Git, degraded to `null` on any failure — no binary, not a repo, no commits.
 * Same shape the consumer build scripts already use, so failure semantics are
 * carried over rather than reinvented.
 */
function git(args: string[], cwd: string): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  if (result.error || result.status !== 0) return null
  return result.stdout.trim()
}

/** The short sha, or `null`. Exported for `deploy`, which holds no `BuildInfo`. */
export function readShortSha(cwd: string = process.cwd()): string | null {
  return git(['rev-parse', '--short', 'HEAD'], cwd)
}

/** Keeps the existing consumer banner convention so banners stay comparable. */
function toJstIso(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000)
  return jst.toISOString().replace('Z', '+09:00')
}

function readPackageVersion(cwd: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8')) as { version?: unknown }
    if (typeof pkg.version !== 'string' || pkg.version.trim() === '') return null
    return pkg.version.trim()
  } catch {
    return null
  }
}

/**
 * Strip a leading `v` only when a digit follows it, so `v1.4.0` narrows but a
 * tag named `verify-2` is left alone.
 */
function stripLeadingV(value: string): string {
  return value.replace(/^v(?=\d)/, '')
}

/**
 * Resolve the one authoritative version: explicit → exact-match tag →
 * `package.json` plus a fallback marker.
 *
 * Tag shape is never validated. `release-42` resolves verbatim, because a
 * deploy blocked by tag-formatting opinions is worse than an odd label.
 *
 * The fallback marker is environment-aware while the *tier* stays single:
 * `-local` on a laptop, `-untagged` in CI. A `workflow_dispatch` run with no
 * version input is a real way to deploy, and labelling that artefact `-local`
 * sends whoever reads it hunting for uncommitted changes that do not exist.
 */
export function resolveVersion(options: ResolveVersionOptions = {}): VersionSpec {
  const { explicit, cwd = process.cwd(), processEnv = process.env } = options

  if (explicit !== undefined && explicit.trim() !== '') {
    return { value: explicit.trim(), source: 'flag' }
  }

  const tag = git(['describe', '--tags', '--exact-match'], cwd)
  if (tag) return { value: tag, source: 'tag' }

  const base = readPackageVersion(cwd)
  // No version anywhere: `-` on its own, with no marker appended. `--local`
  // would read as a version; `-` reads as the absence of one, which is true.
  if (base === null) return { value: '-', source: 'local' }

  return { value: `${base}${processEnv.CI === 'true' ? '-untagged' : '-local'}`, source: 'local' }
}

/**
 * Every build-identity field in one call.
 *
 * **Call this exactly once per build.** Both the code banner and any injected
 * build constant must derive from that single return value — two calls can
 * disagree (`builtAt` differs by the build's own duration, and `dirty` can flip
 * mid-build), and a version display that lies is worse than none. The rule is
 * the caller's to keep; caching it here would only hide accidental second calls.
 *
 * `dirty` stays in the payload deliberately: a release built from a dirty tree
 * is exactly the fact someone needs when a bug will not reproduce from the tag
 * it was supposedly built from.
 */
export function collectBuildInfo(options: CollectBuildInfoOptions): BuildInfo {
  const { env, explicit, cwd = process.cwd(), processEnv = process.env } = options

  const spec = resolveVersion({ explicit, cwd, processEnv })

  let branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  // Detached HEAD tells us nothing; CI knows the ref it checked out.
  if (branch === 'HEAD') branch = processEnv.GITHUB_REF_NAME || 'HEAD'

  return {
    version: stripLeadingV(spec.value),
    commit: git(['rev-parse', '--short', 'HEAD'], cwd) ?? '-',
    branch: branch || '-',
    env,
    builtAt: toJstIso(new Date()),
    // Absence of evidence is not dirtiness: no git means `false`, not `true`.
    dirty: (git(['status', '--porcelain'], cwd) || '') !== '',
  }
}

/**
 * The deployment label: `{version} ({shortSha})`.
 *
 * Pure — it neither calls git nor knows about clasp, which is what makes the
 * v-preservation and prerelease rules testable without mocking anything. No `v`
 * is ever fabricated: `1.3.1-local` stays `1.3.1-local`, and that odd-looking
 * label is the signal that this was not built from a tag.
 */
export function formatDescription(spec: VersionSpec, shortSha?: string | null): string {
  const sha = shortSha && shortSha.trim() !== '' ? shortSha.trim() : '-'
  return `${spec.value} (${sha})`
}
