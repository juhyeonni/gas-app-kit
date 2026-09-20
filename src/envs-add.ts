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

import {
  loadEnvs,
  saveEnvs,
  registryPath,
  EnvsError,
  ENVS_ENV_VAR,
  type EnvEntry,
  type EnvRegistry,
} from './envs.ts'
import { DEFAULT_BUILD_DIR } from './project.ts'

export interface AddEnvOptions {
  /** Register this existing project instead of creating one. */
  scriptId?: string | undefined
  /** Overwrite an existing registry entry. */
  force?: boolean | undefined
  /** Title for a newly created project. Defaults to the env name. */
  title?: string | undefined
  /** clasp project type, e.g. `standalone` (default), `sheets`, `docs`, `slides`, `forms`, `webapp`, `api`. */
  type?: string | undefined
  cwd?: string
  envsPath?: string | undefined
  env?: Record<string, string | undefined>
}

export interface AddEnvResult {
  entry: EnvEntry
  created: boolean
  /** True when --force replaced the scriptId, so the recorded pointer was dropped. */
  deploymentCleared: boolean
}

/** clasp's reported version, or null when it is not on PATH at all. */
function claspVersion(): string | null {
  const probe = spawnSync('clasp', ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (probe.error || probe.status !== 0) return null
  return probe.stdout.trim()
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
  const version = claspVersion()
  if (version === null) {
    // The install and the login advice have to agree: a devDependency puts clasp
    // in node_modules/.bin only, where a bare `clasp login` cannot find it.
    throw new EnvsError(
      'clasp is not installed or not on PATH. Install it with "pnpm add -D @google/clasp", then run gas-app ' +
        'through your package manager ("pnpm exec gas-app …") so node_modules/.bin is on PATH.'
    )
  }
  // v2 passes every "is it installed" check and then fails deep inside clasp with
  // nothing that names the cause: create-script was `create` in v2, and the
  // global --json flag this tool parses every answer from is v3-only. An
  // unparseable version is let through — a false reject is worse than a late one.
  const major = Number.parseInt(version, 10)
  if (!Number.isNaN(major) && major < 3) {
    throw new EnvsError(
      `clasp ${version} is installed, but gas-app-kit needs v3 — it relies on "create-script" and the global --json flag. ` +
        'Upgrade with "pnpm add -D @google/clasp@^3".'
    )
  }
  if (!claspLoggedIn()) {
    throw new EnvsError(
      'clasp is installed but not authenticated. Run "pnpm exec clasp login" yourself — this command never launches a browser prompt on your behalf.'
    )
  }
}

/**
 * Create a project from a scratch directory and return its scriptId, read out
 * of the `.clasp.json` clasp leaves behind there. Nothing is parsed from stdout.
 */
function createInIsolation(title: string, buildDir: string, type?: string): string {
  let scratch: string
  try {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-create-'))
  } catch (err) {
    // Never fall back to running create-script in the repo.
    throw new EnvsError(`Could not create a scratch directory for clasp: ${(err as Error).message}`)
  }

  try {
    const args = ['create-script', '--title', title, '--rootDir', buildDir]
    if (type) args.push('--type', type)
    const result = spawnSync('clasp', args, { cwd: scratch, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
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
/**
 * Add or register an environment.
 *
 * Exported as a library function, not only through the CLI: anything that
 * provisions a project programmatically must be able to reuse the isolation and
 * the create-vs-register decision instead of re-implementing them.
 */
export function addEnv(name: string, options: AddEnvOptions = {}): AddEnvResult {
  const { scriptId, force = false, title, type, cwd = process.cwd(), envsPath, env = process.env } = options

  if (!name) throw new EnvsError('An environment name is required: gas-app envs add <name>')

  if (env[ENVS_ENV_VAR]) {
    throw new EnvsError(
      `The registry is coming from $${ENVS_ENV_VAR}, so there is no file to write. Unset it to add an environment.`
    )
  }

  // The same resolution loadEnvs uses, or a subdirectory run reads the registry
  // above and writes a second one beside itself.
  const file = registryPath(cwd, envsPath)
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
    resolvedScriptId = createInIsolation(title ?? name, DEFAULT_BUILD_DIR, type)
    created = true
  }

  // A deploymentId points at a version of one specific script. Carried across a
  // --force that changed the scriptId, it produces an entry where `open` prints
  // a web app belonging to the old project and `deploy` aims a foreign pointer
  // at the new one — both silently.
  const sameScript = registry[name]?.scriptId === resolvedScriptId
  const deploymentCleared = Boolean(registry[name]?.deploymentId) && !sameScript

  const entry: EnvEntry = {
    ...registry[name],
    name,
    scriptId: resolvedScriptId,
    deploymentId: sameScript ? (registry[name]?.deploymentId ?? '') : '',
    allowPrerelease: registry[name]?.allowPrerelease ?? false,
    allowLocalDeploy: registry[name]?.allowLocalDeploy ?? false,
  }

  // Existing keys keep their position; a new env is appended.
  registry[name] = entry
  saveEnvs(registry, { envsPath, cwd, env })

  return { entry, created, deploymentCleared }
}
