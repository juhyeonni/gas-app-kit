/**
 * `envs add` — create an Apps Script project, or register an existing one.
 *
 * The isolation requirement is the whole point: `clasp create-script` writes
 * `.clasp.json` into cwd and `appsscript.json` into rootDir (bolt 044 fact 05).
 * The consumer's repo is never the cwd for that call, so its own files are
 * never in the blast radius — no snapshot/restore dance needed, unlike
 * `setup.mjs`, which runs create in the repo root and cleans up afterwards.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

import { loadEnvs, EnvsError, ENVS_FILE, ENVS_ENV_VAR, type EnvEntry, type EnvRegistry } from './envs.ts'
import { DEFAULT_BUILD_DIR } from './project.ts'

export interface AddEnvOptions {
  /** Register this existing project instead of creating one. */
  scriptId?: string | undefined
  /** Overwrite an existing registry entry. */
  force?: boolean | undefined
  /** Title for a newly created project. Defaults to the env name. */
  title?: string | undefined
  cwd?: string
  envsPath?: string | undefined
  env?: NodeJS.ProcessEnv
}

export interface AddEnvResult {
  entry: EnvEntry
  created: boolean
}

/** `clasp --version` succeeding is the only "is it installed" signal needed. */
function claspInstalled(): boolean {
  const probe = spawnSync('clasp', ['--version'], { stdio: 'ignore' })
  return !probe.error && probe.status === 0
}

/**
 * Detect authentication — never fix it. `clasp login` is browser-interactive,
 * and auto-launching it from a command meant to be CI-drivable reintroduces
 * exactly the interactivity the rest of this tool removes (NG-3).
 */
function claspLoggedIn(): boolean {
  const probe = spawnSync('clasp', ['show-authorized-user', '--json'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (probe.error || probe.status !== 0) return false
  try {
    const parsed = JSON.parse(probe.stdout) as Record<string, unknown>
    return Boolean(parsed && Object.keys(parsed).length > 0)
  } catch {
    return false
  }
}

function preflight(): void {
  if (!claspInstalled()) {
    throw new EnvsError(
      'clasp is not installed or not on PATH. Install it first: "pnpm add -D @google/clasp" (or npm i -g @google/clasp).'
    )
  }
  if (!claspLoggedIn()) {
    throw new EnvsError(
      'clasp is installed but not authenticated. Run "clasp login" yourself — this command never launches a browser prompt on your behalf.'
    )
  }
}

/**
 * Create a project from a scratch directory and return its scriptId, read out
 * of the `.clasp.json` clasp leaves behind there. Nothing is parsed from stdout.
 */
function createInIsolation(title: string, buildDir: string): string {
  let scratch: string
  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-create-'))
  } catch (err) {
    // Never fall back to running create-script in the repo.
    throw new EnvsError(`Could not create a scratch directory for clasp: ${(err as Error).message}`)
  }

  try {
    const result = spawnSync(
      'clasp',
      ['create-script', '--title', title, '--rootDir', buildDir],
      { cwd: scratch, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    if (result.error) throw new EnvsError(`clasp create-script failed: ${result.error.message}`)
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(0, 3).join(' ')
      throw new EnvsError(`clasp create-script failed: ${detail || `exited ${result.status}`}`)
    }

    const configPath = path.join(scratch, '.clasp.json')
    if (!fs.existsSync(configPath)) {
      throw new EnvsError('clasp create-script reported success but wrote no .clasp.json — cannot determine the scriptId.')
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { scriptId?: string }
    const scriptId = String(config.scriptId ?? '').trim()
    if (!scriptId) {
      throw new EnvsError('The project was created but its scriptId could not be determined; envs.json was left unchanged.')
    }
    return scriptId
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/** Serialize the registry back out, dropping the derived `name` field. */
function serialize(registry: EnvRegistry): string {
  const out: Record<string, Omit<EnvEntry, 'name'>> = {}
  for (const [name, entry] of Object.entries(registry)) {
    out[name] = {
      scriptId: entry.scriptId,
      deploymentId: entry.deploymentId,
      allowPrerelease: entry.allowPrerelease,
      allowLocalDeploy: entry.allowLocalDeploy,
    }
  }
  return `${JSON.stringify(out, null, 2)}\n`
}

/**
 * Add or register an environment.
 *
 * Exported as a library function, not only through the CLI: anything that
 * provisions a project programmatically must be able to reuse the isolation and
 * the create-vs-register decision instead of re-implementing them.
 */
export function addEnv(name: string, options: AddEnvOptions = {}): AddEnvResult {
  const { scriptId, force = false, title, cwd = process.cwd(), envsPath, env = process.env } = options

  if (!name) throw new EnvsError('An environment name is required: gas-app envs add <name>')

  if (env[ENVS_ENV_VAR]) {
    throw new EnvsError(
      `The registry is coming from $${ENVS_ENV_VAR}, so there is no file to write. Unset it to add an environment.`
    )
  }

  const file = envsPath ? path.resolve(cwd, envsPath) : path.join(cwd, ENVS_FILE)
  let registry: EnvRegistry = {}
  if (fs.existsSync(file)) {
    registry = loadEnvs({ envsPath, cwd, env })
  }

  if (registry[name] && !force) {
    throw new EnvsError(`Environment "${name}" already exists in ${path.basename(file)}. Pass --force to overwrite it.`)
  }

  let resolvedScriptId: string
  let created = false
  if (scriptId) {
    resolvedScriptId = scriptId.trim()
    if (!resolvedScriptId) throw new EnvsError('--script-id was given but is empty.')
  } else {
    preflight()
    resolvedScriptId = createInIsolation(title ?? name, DEFAULT_BUILD_DIR)
    created = true
  }

  const entry: EnvEntry = {
    name,
    scriptId: resolvedScriptId,
    deploymentId: registry[name]?.deploymentId ?? '',
    allowPrerelease: registry[name]?.allowPrerelease ?? false,
    allowLocalDeploy: registry[name]?.allowLocalDeploy ?? false,
  }

  // Existing keys keep their position; a new env is appended.
  registry[name] = entry
  fs.writeFileSync(file, serialize(registry))

  return { entry, created }
}
