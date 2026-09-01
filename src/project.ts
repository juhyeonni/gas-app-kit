/**
 * Per-env clasp configuration and the build stamp.
 *
 * Two ideas, deliberately in one file: the stamp only has meaning in terms of
 * which project a command is about to talk to.
 *
 * The config is *generated* and selected per invocation with clasp's
 * `-P, --project` flag. The consumer's own `.clasp.json` is never written to,
 * and generated config is never read back for truth — `envs.json` is truth.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { EnvsError, type EnvEntry } from './envs.ts'

/** Default build output directory, matching the `rootDir: build` convention. */
export const DEFAULT_BUILD_DIR = 'build'

/** Written by the tool, never by the consumer's build. */
export const STAMP_FILE = '.gas-app-stamp.json'

export interface BuildStamp {
  env: string
  builtAt: string
}

export interface ProjectPaths {
  cwd?: string
  buildDir?: string
}

const resolveCwd = (cwd?: string): string => cwd ?? process.cwd()

/** Path of the generated config for one env. Gitignorable, never hand-edited. */
export function claspConfigPath(envName: string, cwd?: string): string {
  return path.join(resolveCwd(cwd), `clasp.${envName}.json`)
}

/**
 * Generate the clasp config for `entry` and return its path, to be passed to
 * clasp as `-P`. Regenerated on every invocation: a stale file on disk can
 * never win, because the caller names the file explicitly.
 */
export function writeClaspConfig(
  entry: EnvEntry,
  { cwd, buildDir = DEFAULT_BUILD_DIR }: ProjectPaths = {}
): string {
  if (!entry.scriptId) {
    throw new EnvsError(
      `Environment "${entry.name}" has no scriptId — it is unprovisioned. Run "gas-app envs add ${entry.name}" or add a scriptId to envs.json.`
    )
  }
  const file = claspConfigPath(entry.name, cwd)
  fs.writeFileSync(file, `${JSON.stringify({ scriptId: entry.scriptId, rootDir: buildDir }, null, 2)}\n`)
  return file
}

function stampPath(cwd: string, buildDir: string): string {
  return path.join(path.resolve(cwd, buildDir), STAMP_FILE)
}

/**
 * Record which env produced the current build output. Callers write it only
 * after the consumer's build command exits 0.
 */
export function writeStamp(
  envName: string,
  { cwd, buildDir = DEFAULT_BUILD_DIR }: ProjectPaths = {}
): string {
  const dir = path.resolve(resolveCwd(cwd), buildDir)
  if (!fs.existsSync(dir)) {
    throw new EnvsError(`Build directory "${buildDir}" does not exist — nothing was built.`)
  }
  const file = stampPath(resolveCwd(cwd), buildDir)
  const stamp: BuildStamp = { env: envName, builtAt: new Date().toISOString() }
  fs.writeFileSync(file, `${JSON.stringify(stamp, null, 2)}\n`)
  return file
}

/** The stamp as written, or null when there is none. */
export function readStamp({ cwd, buildDir = DEFAULT_BUILD_DIR }: ProjectPaths = {}): BuildStamp | null {
  const file = stampPath(resolveCwd(cwd), buildDir)
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<BuildStamp>
    if (typeof parsed.env !== 'string' || parsed.env === '') return null
    return { env: parsed.env, builtAt: String(parsed.builtAt ?? '') }
  } catch {
    return null
  }
}

/**
 * Refuse unless the build output was produced for this exact environment.
 *
 * Two independent checks, and the error must say which one failed:
 *   a) the entry is usable at all — an empty scriptId fails *here*, before any
 *      clasp subprocess exists to produce a worse error;
 *   b) the stamp agrees with the requested env.
 *
 * A missing stamp is a **hard failure**, never a pass. A build predating this
 * tool is exactly the case that would otherwise ship the wrong code silently.
 */
export function assertEnvMatch(
  entry: EnvEntry,
  registryNames: string[],
  paths: ProjectPaths = {}
): void {
  if (!entry.scriptId) {
    throw new EnvsError(
      `Environment "${entry.name}" has no scriptId — it is unprovisioned and cannot be a push target.`
    )
  }

  const stamp = readStamp(paths)
  if (!stamp) {
    const buildDir = paths.buildDir ?? DEFAULT_BUILD_DIR
    throw new EnvsError(
      `No build stamp in "${buildDir}". Build through "gas-app build ${entry.name}" so the output records which environment it was made for — an unstamped build cannot be verified and will not be pushed.`
    )
  }

  if (stamp.env !== entry.name) {
    throw new EnvsError(
      `Build/environment mismatch: the output in "${paths.buildDir ?? DEFAULT_BUILD_DIR}" was built for "${stamp.env}", but "${entry.name}" was requested. Rebuild with "gas-app build ${entry.name}".`
    )
  }

  if (!registryNames.includes(stamp.env)) {
    throw new EnvsError(
      `The build stamp names environment "${stamp.env}", which is not in the registry. Valid environments: ${registryNames.join(', ')}`
    )
  }
}
