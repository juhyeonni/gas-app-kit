/**
 * `gas-app doctor` — is this set up, before you ask it to do anything.
 *
 * Everything reported here was previously discoverable only by running a
 * command that wanted to do something else and reading its refusal. The
 * refusals are good, but they are all reactive: each arrives attached to an
 * operation the user wanted to succeed. There was no way to ask "is this
 * correct" — which is the first thing anyone does after `envs add`, and the
 * first thing they want weeks later when something breaks.
 *
 * Read-only: nothing here writes a file or a deployment.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  loadEnvs,
  envState,
  registryPath,
  EnvsError,
  ENVS_ENV_VAR,
  ENVS_FILE,
  type EnvRegistry,
  type LoadEnvsOptions,
} from '../envs.ts'
import { claspVersion, claspSupported, claspAuthorizedUser } from '../clasp.ts'
import { resolveBuildDir, readStamp, detectPackageManager } from '../project.ts'
import { resolveBuildCommand } from '../build.ts'
import { createUI } from '../ui.mjs'

/**
 * `fail` is the only level that changes the exit code.
 *
 * The distinction that matters: "you have not built yet" and "this environment
 * has no scriptId" are states, not defects — the same rule `open` follows. Only
 * something that makes every remote command impossible fails.
 */
export type CheckLevel = 'ok' | 'note' | 'warn' | 'fail'

export interface DoctorCheck {
  name: string
  level: CheckLevel
  detail: string
  /** What to run or change. Present whenever the level is not `ok`. */
  fix?: string
}

export interface DoctorResult {
  checks: DoctorCheck[]
  ok: boolean
}

export interface DoctorOptions extends LoadEnvsOptions {
  json?: boolean
}

function checkClasp(): DoctorCheck[] {
  const version = claspVersion()
  if (version === null) {
    return [
      {
        name: 'clasp',
        level: 'fail',
        detail: 'not installed, or not on PATH',
        fix: 'pnpm add -D @google/clasp, then run gas-app through your package manager ("pnpm exec gas-app …") so node_modules/.bin is on PATH',
      },
      { name: 'auth', level: 'note', detail: 'not checked — clasp is unavailable' },
    ]
  }

  if (!claspSupported(version)) {
    return [
      {
        name: 'clasp',
        level: 'fail',
        detail: `${version} — gas-app-kit needs v3`,
        fix: 'pnpm add -D @google/clasp@^3',
      },
      { name: 'auth', level: 'note', detail: 'not checked — clasp is the wrong major version' },
    ]
  }

  const user = claspAuthorizedUser()
  return [
    { name: 'clasp', level: 'ok', detail: version },
    user.loggedIn
      ? { name: 'auth', level: 'ok', detail: user.email ?? 'logged in' }
      : {
          name: 'auth',
          level: 'fail',
          detail: 'not authenticated, or the session has expired',
          fix: 'pnpm exec clasp login — this tool never launches a browser prompt on your behalf',
        },
  ]
}

function checkRegistry(
  options: DoctorOptions
): { check: DoctorCheck; registry: EnvRegistry | null; extra: DoctorCheck[] } {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const extra: DoctorCheck[] = []

  if (env[ENVS_ENV_VAR]) {
    extra.push({
      name: 'override',
      level: 'note',
      detail: `$${ENVS_ENV_VAR} is set, so the registry is read-only`,
      fix: `unset $${ENVS_ENV_VAR} to let "envs add" and a new deployment id be written`,
    })
  }

  let registry: EnvRegistry
  try {
    registry = loadEnvs(options)
  } catch (err) {
    return {
      check: {
        name: 'registry',
        level: 'fail',
        detail: err instanceof EnvsError ? err.message : String(err),
        fix: `gas-app envs add <name>`,
      },
      registry: null,
      extra,
    }
  }

  const source = env[ENVS_ENV_VAR]
    ? `$${ENVS_ENV_VAR}`
    : path.relative(cwd, registryPath(cwd, options.envsPath)) || ENVS_FILE
  const names = Object.keys(registry)
  return {
    check: {
      name: 'registry',
      level: 'ok',
      detail: `${source} — ${names.length} environment${names.length === 1 ? '' : 's'}`,
    },
    registry,
    extra,
  }
}

function checkBuild(cwd: string): DoctorCheck[] {
  const buildDir = resolveBuildDir(cwd)
  const checks: DoctorCheck[] = []

  try {
    const target = resolveBuildCommand(cwd)
    checks.push({
      name: 'build',
      level: 'ok',
      detail: `${target.packageManager} run ${target.script} (from ${target.source}) → ${buildDir}/`,
    })
  } catch (err) {
    // Not a failure: rollback never builds, and `envs`/`open` do not either.
    checks.push({
      name: 'build',
      level: 'warn',
      detail: err instanceof EnvsError ? err.message : String(err),
      fix: `push and deploy need it; ${detectPackageManager(cwd)} run <script> must produce ${buildDir}/`,
    })
  }

  const manifest = path.join(cwd, 'appsscript.json')
  if (!fs.existsSync(manifest)) {
    checks.push({
      name: 'manifest',
      level: 'warn',
      detail: 'no appsscript.json at the project root',
      fix: 'your build must copy one into the build directory — clasp refuses a project without it',
    })
  }

  const stamp = readStamp({ cwd, buildDir })
  checks.push(
    stamp
      ? { name: 'stamp', level: 'ok', detail: `${buildDir}/ was built for "${stamp.env}" at ${stamp.builtAt}` }
      : {
          name: 'stamp',
          level: 'note',
          detail: `nothing built yet in ${buildDir}/`,
          fix: 'gas-app build <env> — push refuses output it cannot verify',
        }
  )
  return checks
}

function checkEnvironments(registry: EnvRegistry): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  for (const [name, entry] of Object.entries(registry)) {
    const state = envState(entry)
    if (state === 'unprovisioned') {
      checks.push({
        name: `env:${name}`,
        level: 'warn',
        detail: 'unprovisioned — no scriptId',
        fix: `gas-app envs add ${name} --script-id <id>, or add one to the registry`,
      })
      continue
    }
    if (state === 'undeployed') {
      checks.push({ name: `env:${name}`, level: 'note', detail: 'registered, not deployed yet' })
      continue
    }
    checks.push({
      name: `env:${name}`,
      level: 'ok',
      detail: entry.allowLocalDeploy ? 'deployed, writable from here' : 'deployed, CI-only (allowLocalDeploy: false)',
    })
  }
  return checks
}

/** Collect every check. Exported so a consumer can act on the result rather than the output. */
export function runDoctor(options: DoctorOptions = {}): DoctorResult {
  const cwd = options.cwd ?? process.cwd()
  const checks: DoctorCheck[] = [...checkClasp()]

  const { check, registry, extra } = checkRegistry(options)
  checks.push(check, ...extra, ...checkBuild(cwd))
  if (registry) checks.push(...checkEnvironments(registry))

  return { checks, ok: !checks.some((c) => c.level === 'fail') }
}

const MARK: Record<CheckLevel, 'item' | 'info' | 'warn' | 'error'> = {
  ok: 'item',
  note: 'info',
  warn: 'warn',
  fail: 'error',
}

export function doctorCommand(options: DoctorOptions = {}): number {
  const result = runDoctor(options)

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 1
  }

  const ui = createUI('gas-app doctor')
  const width = Math.max(...result.checks.map((c) => c.name.length))
  for (const check of result.checks) {
    ui[MARK[check.level]](`${check.name.padEnd(width)}  ${check.detail}`)
    if (check.fix) ui.info(`${' '.repeat(width)}  → ${check.fix}`)
  }
  return result.ok ? 0 : 1
}
