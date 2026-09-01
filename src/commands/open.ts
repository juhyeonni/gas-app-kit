/**
 * `gas-app open [env]` — print the editor and web-app URLs.
 *
 * With an env: refuse if it has no deployment. Without one: print every entry
 * in registry key order, marking the ones that have nothing to open.
 */

import { loadEnvs, resolveEnv, EnvsError, type EnvEntry, type LoadEnvsOptions } from '../envs.ts'
import { editorUrl, webAppUrl } from '../links.ts'

function printEntry(entry: EnvEntry, width = 0): void {
  const label = width ? entry.name.padEnd(width) : entry.name
  if (!entry.scriptId) {
    console.log(`  ${label}  (unprovisioned)`)
    return
  }
  console.log(`  ${label}  editor  ${editorUrl(entry.scriptId)}`)
  console.log(
    `  ${' '.repeat(label.length)}  web     ${entry.deploymentId ? webAppUrl(entry.deploymentId) : '(undeployed)'}`
  )
}

export function openCommand(name: string | undefined, options: LoadEnvsOptions = {}): number {
  const registry = loadEnvs(options)

  if (!name) {
    const names = Object.keys(registry)
    if (names.length === 0) {
      throw new EnvsError('No environments registered. Run "gas-app envs add <name>".')
    }
    const width = Math.max(...names.map((n) => n.length))
    for (const key of names) printEntry(registry[key]!, width)
    return 0
  }

  const entry = resolveEnv(registry, name)
  if (!entry.scriptId) {
    throw new EnvsError(`Environment "${name}" is unprovisioned — no script to open.`)
  }
  if (!entry.deploymentId) {
    throw new EnvsError(
      `Environment "${name}" is undeployed — no web app to open. Editor: ${editorUrl(entry.scriptId)}`
    )
  }
  printEntry(entry)
  return 0
}
