/**
 * `gas-app envs` — list every registered environment with its resolved state.
 *
 * Read-only and diagnostic: a missing or logged-out clasp degrades the version
 * column only. An entry is never hidden, whatever state it is in.
 */

import { loadEnvs, envState, type EnvEntry, type LoadEnvsOptions } from '../envs.ts'
import { listDeployments } from '../clasp.ts'
import { createUI } from '../ui.mjs'

interface Version {
  versionNumber: number
  description: string
}

/**
 * Current version of `entry.deploymentId`, with why it could not be read.
 *
 * The reason is carried rather than discarded: every env degrading to
 * "deployed (version unknown)" under a fixed "could not read deployments"
 * line never said the cause was an expired session, or that `clasp login`
 * fixes it.
 */
function currentVersion(entry: EnvEntry): { version: Version | null; reason?: string } {
  const result = listDeployments(entry.scriptId)
  if (!result.ok) return { version: null, reason: result.reason }
  if (!Array.isArray(result.data)) return { version: null, reason: 'clasp returned no deployment list' }

  const match = result.data.find((d) => d.deploymentId === entry.deploymentId)
  // No versionNumber means the implicit @HEAD deployment — never "a version".
  if (!match || match.versionNumber === undefined || match.versionNumber === null) {
    return { version: null }
  }

  return { version: { versionNumber: match.versionNumber, description: match.description ?? '' } }
}

export interface EnvsCommandOptions extends LoadEnvsOptions {
  /** Print one object to stdout instead of the reading layout. */
  json?: boolean
}

/**
 * The JSON rendering of one environment.
 *
 * `versionNumber: null` is the honest form of "deployed (version unknown)", and
 * `degraded` says why — a consumer must be able to tell "no version" from "could
 * not ask".
 */
interface EnvJson {
  scriptId: string
  deploymentId: string
  state: string
  versionNumber: number | null
  description: string | null
  allowLocalDeploy: boolean
  allowPrerelease: boolean
  degraded?: string
}

export function envsCommand(options: EnvsCommandOptions = {}): number {
  const ui = createUI('gas-app envs')
  const registry = loadEnvs(options)
  const names = Object.keys(registry)

  if (names.length === 0) {
    if (options.json) {
      console.log('{}')
      return 0
    }
    ui.warn('No environments registered. Run "gas-app envs add <name>".')
    return 0
  }

  const width = Math.max(...names.map((n) => n.length))
  let degraded: string | null = null
  const payload: Record<string, EnvJson> = {}

  for (const name of names) {
    const entry = registry[name]!
    const state = envState(entry)

    // Read once; both renderings are shaped from the same result, so a listing
    // and its JSON can never disagree about what an environment serves.
    const { version, reason } = state === 'deployed' ? currentVersion(entry) : { version: null, reason: undefined }

    if (options.json) {
      payload[name] = {
        scriptId: entry.scriptId,
        deploymentId: entry.deploymentId,
        state,
        versionNumber: version?.versionNumber ?? null,
        description: version?.description || null,
        allowLocalDeploy: entry.allowLocalDeploy,
        allowPrerelease: entry.allowPrerelease,
        ...(reason ? { degraded: reason } : {}),
      }
      continue
    }

    let detail: string = state
    if (state === 'deployed') {
      if (version) {
        detail = `@${version.versionNumber}${version.description ? ` (${version.description})` : ''}`
      } else {
        detail = 'deployed (version unknown)'
        if (reason) degraded ??= reason
      }
    }

    const flags = [
      entry.allowPrerelease ? 'prerelease' : null,
      entry.allowLocalDeploy ? 'local-deploy' : null,
    ].filter((f): f is string => f !== null)

    console.log(`  ${name.padEnd(width)}  ${detail}${flags.length ? `  [${flags.join(', ')}]` : ''}`)
  }

  if (options.json) {
    // Nothing else reaches stdout, so a consumer can trust that it parses or the
    // command failed. Refusals stay on stderr with the exit codes they had.
    console.log(JSON.stringify(payload, null, 2))
    return 0
  }

  if (degraded) ui.info(degraded)
  return 0
}
