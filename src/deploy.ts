/**
 * `push` and `deploy` — the two commands that actually write to Apps Script.
 *
 * `push` is a composition, not new logic: gate → build → assert → manifest-guarded
 * `clasp push`. Each step is the cheapest one that can still fail at that point,
 * so a failure never costs more than it has to. `deploy` is a superset: the full
 * push sequence, then a deployment pointer move.
 */

import {
  loadEnvs,
  resolveEnv,
  saveEnvs,
  EnvsError,
  ENVS_ENV_VAR,
  type EnvEntry,
  type LoadEnvsOptions,
} from './envs.ts'
import { formatDescription, readShortSha, resolveVersion } from './version.ts'
import { assertEnvMatch, assertProvisioned, writeClaspConfig } from './project.ts'
import { withManifest } from './manifest.ts'
import { resolveBuildCommand, runBuild } from './build.ts'
import { runGate, type GateResult } from './gate.ts'
import { claspJson, type DeploymentRow } from './clasp.ts'
import { promptYesNo } from './prompt.ts'
import { editorUrl, webAppUrl } from './links.ts'
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

/**
 * The local-write policy, checked by both write paths.
 *
 * `push` needs this as much as `deploy` does: `clasp push` replaces the
 * script's HEAD code, and container-bound triggers and `onOpen` menus run from
 * HEAD rather than from the deployed version — so a push changes behaviour for
 * every user of that Sheet immediately, and `rollback` cannot undo it.
 */
function assertLocalDeployAllowed(entry: EnvEntry, env: Record<string, string | undefined>): void {
  if (env.CI === 'true' || entry.allowLocalDeploy) return
  throw new EnvsError(
    `Environment "${entry.name}" has allowLocalDeploy: false — writing to it from a local machine is refused. ` +
      `This covers push as well as deploy: a push overwrites the script's HEAD code, which bound triggers and onOpen menus run from immediately. ` +
      `Do it from CI, or set the flag in envs.json if that policy is wrong.`
  )
}

export function push(envName: string | undefined, options: PushOptions = {}): PushResult {
  const { cwd = process.cwd(), skipChecks = false, noBuild = false, env = process.env } = options
  const ui = createUI('gas-app push')

  const entry = resolveEnv(loadEnvs({ ...options, cwd, env }), envName)
  assertProvisioned(entry)
  assertLocalDeployAllowed(entry, env)
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
  // deploy and rollback both end on a URL; push ended on nothing, and right
  // after a first push is when the editor link is most wanted.
  ui.info(editorUrl(entry.scriptId))
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

export function deploy(envName: string | undefined, options: DeployOptions = {}): DeployResult {
  const { cwd = process.cwd(), env = process.env, yes = false } = options
  const ui = createUI('gas-app deploy')

  const entry = resolveEnv(loadEnvs({ ...options, cwd, env }), envName)

  // Checked here as well as in push() so it refuses before prompting, not after.
  const inCI = env.CI === 'true'
  assertProvisioned(entry)
  assertLocalDeployAllowed(entry, env)
  const confirm =
    options.confirm ?? ((question: string) => promptYesNo(question, `gas-app deploy ${entry.name} --yes`))

  if (options.description !== undefined && options.description.trim() === '') {
    throw new EnvsError('--description was given but is empty. Omit it entirely to derive one, or pass real text.')
  }
  // Derived from the same resolution every other consumer reads, so the label
  // on the deployment and the version stamped in the code cannot disagree.
  const shortSha = readShortSha(cwd)
  const description =
    options.description ??
    formatDescription(resolveVersion({ explicit: options.version, cwd, processEnv: env }), shortSha)

  // The bare label read as a semver being chosen, and the "(-)" in a derived one
  // is an absent git sha that nothing explained.
  const question =
    `Deploy "${entry.name}" as "${description}" — this creates a new immutable version` +
    (options.description === undefined && !shortSha ? ', with no git commit recorded' : '') +
    '?'
  if (!yes && !inCI && !confirm(question)) {
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
      // "Add it manually" has to name a destination. Under the env var there is
      // no envs.json being read at all, so pointing at the file is a dead end.
      ui.warn(
        env[ENVS_ENV_VAR]
          ? `the registry came from ${ENVS_ENV_VAR}, so there is no file to record the new deployment id in. ` +
              `Add "deploymentId": "${deploymentId}" to "${entry.name}" wherever that variable is defined.`
          : `could not write the new deployment id to envs.json. Add "deploymentId": "${deploymentId}" to "${entry.name}" by hand.`
      )
    }
  }

  ui.item(`deployed "${entry.name}" → ${deploymentId} (${description})`)
  if (deploymentId) ui.info(webAppUrl(deploymentId))
  return { ...pushed, deploymentId, versionNumber: result.data.versionNumber, description, persisted }
}
