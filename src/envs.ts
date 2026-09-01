/**
 * The environment registry: one file, one loader, one resolver.
 *
 * Every command resolves an environment through here. No command carries its
 * own union of env names, which is what makes "adding an env is a config edit"
 * true rather than aspirational.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export const ENVS_FILE = 'envs.json'
export const ENVS_ENV_VAR = 'GAS_APP_ENVS_JSON'

/** One deployable environment, after normalization. */
export interface EnvEntry {
  name: string
  scriptId: string
  deploymentId: string
  allowPrerelease: boolean
  allowLocalDeploy: boolean
}

/** The whole set. Key order is display order. */
export type EnvRegistry = Record<string, EnvEntry>

/** Derived at display time, never stored in `envs.json`. */
export type EnvState = 'unprovisioned' | 'undeployed' | 'deployed'

export interface LoadEnvsOptions {
  envsPath?: string | undefined
  cwd?: string
  /**
   * Environment variables. `Record<string, string | undefined>` rather than
   * `NodeJS.ProcessEnv` on purpose: that is an ambient global, and putting it in
   * a published type forces every consumer's tsconfig to pull in `@types/node`
   * globals or fail typechecking on *our* declarations. `process.env` is
   * assignable to this, so nothing at a call site changes.
   */
  env?: Record<string, string | undefined>
}

/** A refusal the CLI prints as-is. Carries no stack trace worth showing a user. */
export class EnvsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvsError'
  }
}

/**
 * Policy flags fail closed: anything but a literal `true` is `false`. Matches
 * the consumer's existing `resolve(rawKey) === 'true'` convention rather than
 * JS truthiness, so a typo never silently grants permission.
 */
const flag = (value: unknown): boolean => value === true

function normalizeEntry(name: string, raw: unknown): EnvEntry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EnvsError(
      `Environment "${name}" must be an object, got ${Array.isArray(raw) ? 'array' : typeof raw}.`
    )
  }
  const entry = raw as Record<string, unknown>
  return {
    name,
    scriptId: String(entry.scriptId ?? '').trim(),
    deploymentId: String(entry.deploymentId ?? '').trim(),
    allowPrerelease: flag(entry.allowPrerelease),
    allowLocalDeploy: flag(entry.allowLocalDeploy),
  }
}

function parseRegistry(text: string, source: string): EnvRegistry {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new EnvsError(`${source} is not valid JSON: ${(err as Error).message}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new EnvsError(`${source} must be a JSON object mapping env names to entries.`)
  }

  // Key insertion order is display order everywhere. Never sorted.
  const registry: EnvRegistry = {}
  for (const [name, raw] of Object.entries(data as Record<string, unknown>)) {
    registry[name] = normalizeEntry(name, raw)
  }
  return registry
}

/**
 * Read the registry. `GAS_APP_ENVS_JSON` wins over the file verbatim and the
 * file is not read at all — the single knob that makes committing ids or not a
 * one-line policy decision.
 *
 * A malformed variable names *the variable*; a malformed file names *the file*.
 * Reversing those two points CI failures at the wrong place.
 */
export function loadEnvs({
  envsPath,
  cwd = process.cwd(),
  env = process.env,
}: LoadEnvsOptions = {}): EnvRegistry {
  const inline = env[ENVS_ENV_VAR]
  if (inline !== undefined && inline !== '') {
    return parseRegistry(inline, `$${ENVS_ENV_VAR}`)
  }

  const file = envsPath ? path.resolve(cwd, envsPath) : path.join(cwd, ENVS_FILE)
  if (!fs.existsSync(file)) {
    const shown = path.relative(cwd, file) || ENVS_FILE
    throw new EnvsError(
      `${shown} not found. Run "gas-app envs add <name>" first, or set $${ENVS_ENV_VAR}.`
    )
  }
  return parseRegistry(fs.readFileSync(file, 'utf-8'), path.relative(cwd, file) || ENVS_FILE)
}

/**
 * Write the registry back out, dropping the derived `name` field.
 *
 * Refuses when the registry came from the environment variable: there is no
 * file to write, and silently creating one would make the override lie.
 */
export function saveEnvs(
  registry: EnvRegistry,
  { envsPath, cwd = process.cwd(), env = process.env }: LoadEnvsOptions = {}
): string {
  if (env[ENVS_ENV_VAR]) {
    throw new EnvsError(
      `The registry is coming from $${ENVS_ENV_VAR}, so there is no file to write. Unset it to persist changes.`
    )
  }
  const file = envsPath ? path.resolve(cwd, envsPath) : path.join(cwd, ENVS_FILE)
  const out: Record<string, Omit<EnvEntry, 'name'>> = {}
  for (const [name, entry] of Object.entries(registry)) {
    out[name] = {
      scriptId: entry.scriptId,
      deploymentId: entry.deploymentId,
      allowPrerelease: entry.allowPrerelease,
      allowLocalDeploy: entry.allowLocalDeploy,
    }
  }
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`)
  return file
}

/** Look one up, or refuse with the list of names that do exist. */
export function resolveEnv(registry: EnvRegistry, name: string | undefined): EnvEntry {
  const names = Object.keys(registry)
  const valid = names.join(', ') || '(none registered)'
  if (!name) {
    throw new EnvsError(`No environment given. Valid environments: ${valid}`)
  }
  const entry = registry[name]
  if (!entry) {
    throw new EnvsError(`Unknown environment "${name}". Valid environments: ${valid}`)
  }
  return entry
}

/**
 * Derived at display time, never stored. `envs.json` holds identifiers and
 * policy flags only.
 */
export function envState(entry: EnvEntry): EnvState {
  if (!entry.scriptId) return 'unprovisioned'
  if (!entry.deploymentId) return 'undeployed'
  return 'deployed'
}
