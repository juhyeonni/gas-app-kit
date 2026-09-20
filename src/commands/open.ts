/**
 * `gas-app open [env]` — print the editor and web-app URLs.
 *
 * Both forms report state rather than judging it: an env with no deployment is
 * printed and exits 0, same as it always has in the argument-less listing. Only
 * an env with no scriptId at all refuses, because there is nothing to print.
 */

import { loadEnvs, resolveEnv, EnvsError, type EnvEntry, type LoadEnvsOptions } from '../envs.ts'
import { editorUrl, webAppUrl } from '../links.ts'
import { createUI } from '../ui.mjs'

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
  // "Not deployed yet" is a state, not a failure: the argument-less form of this
  // same command has always printed it and exited 0. Exiting 1 here broke every
  // alias and script wrapping `open` under `set -e`, for an env whose editor URL
  // was printed successfully.
  printEntry(entry)
  if (!entry.deploymentId) {
    createUI('gas-app open').info(`undeployed — run "gas-app deploy ${name}" to create a web-app URL`)
  }
  return 0
}
