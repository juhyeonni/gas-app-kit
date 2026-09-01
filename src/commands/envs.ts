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

/** Current version of `entry.deploymentId`, or null if it cannot be determined. */
function currentVersion(entry: EnvEntry): Version | null {
  const result = listDeployments(entry.scriptId)
  if (!result.ok || !Array.isArray(result.data)) return null

  const match = result.data.find((d) => d.deploymentId === entry.deploymentId)
  // No versionNumber means the implicit @HEAD deployment — never "a version".
  if (!match || match.versionNumber === undefined || match.versionNumber === null) return null

  return { versionNumber: match.versionNumber, description: match.description ?? '' }
}

export function envsCommand(options: LoadEnvsOptions = {}): number {
  const ui = createUI('gas-app envs')
  const registry = loadEnvs(options)
  const names = Object.keys(registry)

  if (names.length === 0) {
    ui.warn('No environments registered. Run "gas-app envs add <name>".')
    return 0
  }

  const width = Math.max(...names.map((n) => n.length))
  let degraded: string | null = null

  for (const name of names) {
    const entry = registry[name]!
    const state = envState(entry)
    let detail: string = state

    if (state === 'deployed') {
      const version = currentVersion(entry)
      if (version) {
        detail = `@${version.versionNumber}${version.description ? ` (${version.description})` : ''}`
      } else {
        detail = 'deployed (version unknown)'
        degraded ??= 'could not read deployments from clasp'
      }
    }

    const flags = [
      entry.allowPrerelease ? 'prerelease' : null,
      entry.allowLocalDeploy ? 'local-deploy' : null,
    ].filter((f): f is string => f !== null)

    console.log(`  ${name.padEnd(width)}  ${detail}${flags.length ? `  [${flags.join(', ')}]` : ''}`)
  }

  if (degraded) ui.info(degraded)
  return 0
}
