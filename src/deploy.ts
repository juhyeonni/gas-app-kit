/**
 * `push` and `deploy` — the two commands that actually write to Apps Script.
 *
 * `push` is a composition, not new logic: gate → build → assert → manifest-guarded
 * `clasp push`. Each step is the cheapest one that can still fail at that point,
 * so a failure never costs more than it has to. `deploy` is a superset: the full
 * push sequence, then a deployment pointer move.
 */

import * as fs from 'node:fs'

import { loadEnvs, resolveEnv, saveEnvs, EnvsError, type EnvEntry, type LoadEnvsOptions } from './envs.ts'
import { formatDescription, readShortSha, resolveVersion } from './version.ts'
import { assertEnvMatch, writeClaspConfig } from './project.ts'
import { withManifest } from './manifest.ts'
import { resolveBuildCommand, runBuild } from './build.ts'
import { runGate, type GateResult } from './gate.ts'
import { claspJson, type DeploymentRow } from './clasp.ts'
import { createUI } from './ui.mjs'

export interface PushOptions extends LoadEnvsOptions {
  skipChecks?: boolean
  /** Push whatever is already built and stamped. Skips gate and build. */
  noBuild?: boolean
}

export interface PushResult {
  entry: EnvEntry
  files: number
  gate: GateResult | null
}

/** Run clasp against one env's generated config. */
function claspForEnv<T>(entry: EnvEntry, args: string[], cwd: string, buildDir: string) {
  const configPath = writeClaspConfig(entry, { cwd, buildDir })
  return withManifest(
    () => claspJson<T>([...args, '--project', configPath]),
    { cwd, buildDir }
  )
}

export function push(envName: string | undefined, options: PushOptions = {}): PushResult {
  const { cwd = process.cwd(), skipChecks = false, noBuild = false, env = process.env } = options
  const ui = createUI('gas-app push')

  const entry = resolveEnv(loadEnvs({ ...options, cwd, env }), envName)
  const buildDir = resolveBuildCommand(cwd).buildDir

  // 1. Gate — cheapest check, so it fails fastest. `--no-build` implies the
  //    artefact is already trusted, so the gate has nothing left to protect.
  let gate: GateResult | null = null
  if (!noBuild) {
    gate = runGate({ cwd, skipChecks, env })
    if (!gate.passed) {
      throw new EnvsError('Quality gate failed. Fix the errors above, or re-run with --skip-checks if you know why.')
    }
  }

  // 2. Build — must precede the assertion, which reads what it stamped.
  if (!noBuild) runBuild(entry.name, { cwd })

  // 3. Assert — the last chance to stop before anything leaves the machine.
  const registryNames = Object.keys(loadEnvs({ ...options, cwd, env }))
  assertEnvMatch(entry, registryNames, { cwd, buildDir })

  // 4. Push, with the manifest guarded around the clasp call only — the build
  //    never touches appsscript.json, so guarding it too would be noise.
  const result = claspForEnv<string[]>(entry, ['push', '--force'], cwd, buildDir)
  if (!result.ok) {
    throw new EnvsError(`clasp push failed: ${result.reason}`)
  }

  const files = Array.isArray(result.data) ? result.data.length : 0
  // clasp reports only what it actually transferred, so an unchanged tree
  // pushes nothing. Say so, or "0 files" reads as a failure.
  ui.item(
    files === 0
      ? `"${entry.name}" already up to date — no files changed`
      : `pushed ${files} file${files === 1 ? '' : 's'} to "${entry.name}"`
  )
  return { entry, files, gate }
}

export interface DeployOptions extends PushOptions {
  description?: string | undefined
  /**
   * Explicit version, winning over tag and fallback. A library argument rather
   * than a CLI flag: `--version` is already the boolean "print the package
   * version". The CI path that needs a flag is unit 004's, which can name it.
   */
  version?: string | undefined
  /** Bypass every confirmation. Without it, automated recovery is impossible. */
  yes?: boolean
  /** Injected for testing; defaults to a TTY prompt. */
  confirm?: (question: string) => boolean
}

export interface DeployResult extends PushResult {
  deploymentId: string
  versionNumber: number | undefined
  description: string
  /** False when the id could not be persisted (registry came from the env var). */
  persisted: boolean
  /** True when a confirmation was declined and nothing was deployed. */
  declined?: boolean
}

function promptYesNo(question: string): boolean {
  // Only ever reached on a real TTY; every other path must refuse or proceed
  // without asking, because a prompt inside a wrapper is the problem being closed.
  if (!process.stdin.isTTY) return true
  process.stdout.write(`${question} [y/N] `)
  const buffer = Buffer.alloc(8)
  let bytes: number
  try {
    bytes = fs.readSync(0, buffer, 0, buffer.length, null)
  } catch {
    // No readable stdin is a decline, not a crash.
    return false
  }
  return /^y/i.test(buffer.toString('utf-8', 0, bytes).trim())
}

export function deploy(envName: string | undefined, options: DeployOptions = {}): DeployResult {
  const { cwd = process.cwd(), env = process.env, yes = false, confirm = promptYesNo } = options
  const ui = createUI('gas-app deploy')

  const entry = resolveEnv(loadEnvs({ ...options, cwd, env }), envName)

  // Refuse, never prompt-as-fallback: a TTY fallback recreates the problem for
  // the next person running this inside a wrapper.
  const inCI = env.CI === 'true'
  if (!inCI && !entry.allowLocalDeploy) {
    throw new EnvsError(
      `Environment "${entry.name}" has allowLocalDeploy: false — deploying it from a local machine is refused. Deploy it from CI, or set the flag in envs.json if that policy is wrong.`
    )
  }

  if (options.description !== undefined && options.description.trim() === '') {
    throw new EnvsError('--description was given but is empty. Omit it entirely to derive one, or pass real text.')
  }
  // Derived from the same resolution every other consumer reads, so the label
  // on the deployment and the version stamped in the code cannot disagree.
  const description =
    options.description ??
    formatDescription(resolveVersion({ explicit: options.version, cwd, processEnv: env }), readShortSha(cwd))

  if (!yes && !inCI && !confirm(`Deploy "${entry.name}" as ${description}?`)) {
    // Nothing changed, so this is not a failure. exit 1 here would be a CI false positive.
    ui.info('declined — nothing deployed')
    return {
      entry,
      files: 0,
      gate: null,
      deploymentId: entry.deploymentId,
      versionNumber: undefined,
      description,
      persisted: false,
      declined: true,
    }
  }

  const pushed = push(envName, options)
  const buildDir = resolveBuildCommand(cwd).buildDir

  const args = ['create-deployment', '--description', description]
  if (entry.deploymentId) args.push('--deploymentId', entry.deploymentId)

  const result = claspForEnv<DeploymentRow>(entry, args, cwd, buildDir)
  if (!result.ok) {
    // The pointer never moved, so the previous version is still being served.
    throw new EnvsError(
      `Push succeeded but the deployment failed: ${result.reason}\n` +
        `The previous version is still being served — nothing is broken. Retry with "gas-app deploy ${entry.name} --no-build --yes" once the cause is fixed.`
    )
  }

  const deploymentId = result.data.deploymentId
  let persisted = false
  if (deploymentId && deploymentId !== entry.deploymentId) {
    const registry = loadEnvs({ ...options, cwd, env })
    registry[entry.name] = { ...entry, deploymentId }
    try {
      saveEnvs(registry, { ...options, cwd, env })
      persisted = true
    } catch {
      // The deploy itself succeeded; failing to record the id must not undo it.
      ui.warn(`could not record the deployment id in envs.json — add it manually: ${deploymentId}`)
    }
  }

  ui.item(`deployed "${entry.name}" → ${deploymentId} (${description})`)
  return { ...pushed, deploymentId, versionNumber: result.data.versionNumber, description, persisted }
}
