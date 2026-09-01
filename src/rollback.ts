/**
 * The recovery path: list versions, repoint a deployment at one of them.
 *
 * This is an incident-time tool, which changes what "done" means here. Two
 * properties matter more than the happy path:
 *
 *   1. **No build runs.** Rolling back must not depend on the tree being
 *      buildable — that is often exactly what is broken. This module therefore
 *      imports nothing from `build.ts` or `deploy.ts`, and a stray import that
 *      pulls the build path back in is a real regression, not a style nit.
 *   2. **The error message is the product.** "Version 42 not found" is useless
 *      under pressure. Listing what *does* exist is the difference between a
 *      one-minute recovery and a hunt through the Apps Script UI.
 *
 * `@HEAD` is never a rollback target. A brand-new project already reports it as
 * a deployment (bolt 044, fact 01), and repointing HEAD is not a rollback — it
 * is pointing production at whatever is in the editor right now.
 */

import * as fs from 'node:fs'

import { loadEnvs, resolveEnv, EnvsError, type EnvEntry, type LoadEnvsOptions } from './envs.ts'
import {
  claspJson,
  listDeployments,
  listVersionRows,
  type DeploymentRow,
  type VersionRowRaw,
} from './clasp.ts'
import { writeClaspConfig } from './project.ts'
import { withManifest } from './manifest.ts'
import { createUI } from './ui.mjs'

/** Production history reached 226 versions (bolt 044, fact 08). Never print all of them. */
export const DEFAULT_VERSION_LIMIT = 15

export interface VersionRow {
  versionNumber: number
  description: string
}

export interface ListVersionsResult {
  entry: EnvEntry
  /** Newest first, `@HEAD` excluded. Truncated to `limit`. */
  versions: VersionRow[]
  /** Which of them the env currently serves, if any. */
  current: VersionRow | undefined
  /** Total before truncation, so a shortened list never reads as complete. */
  total: number
  /** True when the env's deployment exists but carries no version (it is `@HEAD`). */
  currentIsHead: boolean
}

export interface ListVersionsOptions extends LoadEnvsOptions {
  limit?: number
}

/** Normalise `list-versions` rows: newest first, every description printable. */
export function toCandidates(rows: VersionRowRaw[]): VersionRow[] {
  return rows
    .filter((row) => typeof row.versionNumber === 'number')
    .map((row) => ({
      versionNumber: row.versionNumber,
      description: (row.description ?? '').trim() || '(no description)',
    }))
    .sort((a, b) => b.versionNumber - a.versionNumber)
}

/**
 * Which version an env currently serves, from its deployment row.
 *
 * A deployment with no `versionNumber` is `@HEAD` — it serves whatever is in
 * the editor, which is why it is a state to report, never a target to pick.
 */
export function currentVersionOf(
  rows: DeploymentRow[],
  deploymentId: string
): { versionNumber: number | undefined; isHead: boolean } {
  const row = rows.find((r) => r.deploymentId === deploymentId)
  if (!row) return { versionNumber: undefined, isHead: false }
  return { versionNumber: row.versionNumber, isHead: row.versionNumber === undefined }
}

/**
 * List an env's rollback candidates.
 *
 * Two clasp calls, because they answer different questions: `list-versions`
 * gives the candidates (versions are immutable snapshots), `list-deployments`
 * says which one the env's *pointer* currently serves. Reading candidates off
 * the deployment list instead is the obvious shortcut and it is wrong — a
 * project that reuses one deployment id reports exactly one row regardless of
 * how many versions exist behind it.
 */
export function listVersions(
  envName: string | undefined,
  options: ListVersionsOptions = {}
): ListVersionsResult {
  const { limit = DEFAULT_VERSION_LIMIT } = options
  const entry = resolveEnv(loadEnvs(options), envName)
  if (!entry.scriptId) {
    throw new EnvsError(`Environment "${entry.name}" is unprovisioned — there is nothing to roll back.`)
  }

  const versionResult = listVersionRows(entry.scriptId)
  if (!versionResult.ok) {
    throw new EnvsError(`Could not list versions for "${entry.name}": ${versionResult.reason}`)
  }
  const candidates = toCandidates(versionResult.data)

  let current: { versionNumber: number | undefined; isHead: boolean } = {
    versionNumber: undefined,
    isHead: false,
  }
  if (entry.deploymentId) {
    const deployResult = listDeployments(entry.scriptId)
    if (!deployResult.ok) {
      throw new EnvsError(`Could not list deployments for "${entry.name}": ${deployResult.reason}`)
    }
    current = currentVersionOf(deployResult.data, entry.deploymentId)
  }

  return {
    entry,
    versions: candidates.slice(0, limit),
    current: candidates.find((v) => v.versionNumber === current.versionNumber),
    total: candidates.length,
    currentIsHead: current.isHead,
  }
}

/** One line per version, marking the served one. */
export function formatVersions(result: ListVersionsResult): string[] {
  const lines = result.versions.map((v) => {
    const marker = v.versionNumber === result.current?.versionNumber ? '→' : ' '
    return `  ${marker} ${String(v.versionNumber).padStart(4)}  ${v.description}`
  })
  if (result.total > result.versions.length) {
    // Say what was hidden. A truncated list that looks complete is how someone
    // concludes the version they need is gone.
    lines.push(`    … ${result.total - result.versions.length} older version(s) not shown`)
  }
  return lines
}

export interface RollbackOptions extends LoadEnvsOptions {
  /** Bypass every confirmation. Without it, automated recovery is impossible. */
  yes?: boolean
  /** Injected for testing; defaults to a TTY prompt. */
  confirm?: (question: string) => boolean
  limit?: number
}

export interface RollbackResult {
  entry: EnvEntry
  target: VersionRow
  /** True when the env already served the target — a stated no-op, not a failure. */
  noop: boolean
  declined?: boolean
}

function promptYesNo(question: string): boolean {
  if (!process.stdin.isTTY) return false
  process.stdout.write(`${question} [y/N] `)
  const buffer = Buffer.alloc(8)
  let bytes: number
  try {
    bytes = fs.readSync(0, buffer, 0, buffer.length, null)
  } catch {
    return false
  }
  return /^y/i.test(buffer.toString('utf-8', 0, bytes).trim())
}

/**
 * Repoint `env`'s deployment at `versionNumber`, without building anything.
 *
 * Omitting the target is not an error on a TTY — it lists the candidates and
 * asks. Off a TTY it refuses, because a rollback that silently picks a version
 * for you is worse than one that stops.
 */
export function rollback(
  envName: string | undefined,
  versionNumber: number | undefined,
  options: RollbackOptions = {}
): RollbackResult {
  const { cwd = process.cwd(), yes = false, confirm = promptYesNo } = options
  const ui = createUI('gas-app rollback')

  const listed = listVersions(envName, options)
  const { entry } = listed

  if (listed.versions.length === 0) {
    throw new EnvsError(
      `Environment "${entry.name}" has no versions to roll back to. ` +
        'Only @HEAD exists, and pointing a deployment at HEAD is not a rollback.'
    )
  }
  if (!entry.deploymentId) {
    throw new EnvsError(`Environment "${entry.name}" is undeployed — there is no pointer to move.`)
  }

  if (versionNumber === undefined) {
    // The listing is the useful half of this branch, so print it either way.
    for (const line of formatVersions(listed)) console.log(line)
    if (!process.stdin.isTTY) {
      throw new EnvsError(
        `No version given. Re-run as "gas-app rollback ${entry.name} <version>" — a rollback never picks a version for you.`
      )
    }
    throw new EnvsError(
      `No version given. Re-run as "gas-app rollback ${entry.name} <version>" with one of the versions listed above.`
    )
  }

  const target = listed.versions.find((v) => v.versionNumber === versionNumber)
  if (!target) {
    // The whole point of this message: name what exists, in order.
    const available = listed.versions.map((v) => `${v.versionNumber} (${v.description})`).join(', ')
    throw new EnvsError(
      `Version ${versionNumber} is not a version of "${entry.name}". Available: ${available}` +
        (listed.total > listed.versions.length ? `, +${listed.total - listed.versions.length} older` : '')
    )
  }

  if (listed.current?.versionNumber === versionNumber) {
    // Already there. Exit 0: nothing failed, and an incident is no time to
    // decode a non-zero exit that meant "no change needed".
    ui.info(`"${entry.name}" already serves version ${versionNumber} — nothing to do`)
    return { entry, target, noop: true }
  }

  if (!yes) {
    const from = listed.currentIsHead
      ? '@HEAD'
      : listed.current
        ? `${listed.current.versionNumber} (${listed.current.description})`
        : 'an unknown version'
    if (!confirm(`Roll "${entry.name}" back from ${from} to ${target.versionNumber} (${target.description})?`)) {
      ui.info('declined — nothing changed')
      return { entry, target, noop: false, declined: true }
    }
  }

  // Guarded even though a version repoint should not touch the manifest:
  // "should not" and "does not" are different, and a clean tree afterwards is
  // one of this bolt's stated criteria.
  const configPath = writeClaspConfig(entry, { cwd })
  const result = withManifest(
    () =>
      claspJson<DeploymentRow>([
        'create-deployment',
        '--deploymentId',
        entry.deploymentId,
        '--versionNumber',
        String(target.versionNumber),
        '--description',
        target.description,
        '--project',
        configPath,
      ]),
    { cwd }
  )

  if (!result.ok) {
    throw new EnvsError(
      `Rollback failed: ${result.reason}\nThe deployment still serves what it served before — nothing is half-applied.`
    )
  }

  ui.item(`"${entry.name}" now serves version ${target.versionNumber} (${target.description})`)
  return { entry, target, noop: false }
}
