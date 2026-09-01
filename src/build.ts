/**
 * The build wrapper.
 *
 * The build itself is repo-owned; env-consistency is this tool's job. A
 * `pnpm build && gas-app deploy` composition cannot guarantee that `BUILD_ENV`
 * reached the child, that the build preceded the push, or that the artefact
 * belongs to the requested env. So the tool wraps the consumer's build and
 * writes the stamp itself — which is also why the consumer's build script never
 * needs to know the stamp exists.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

import { EnvsError } from './envs.ts'
import { DEFAULT_BUILD_DIR, writeStamp } from './project.ts'

export interface ConsumerPackage {
  scripts?: Record<string, string>
  packageManager?: string
  gasApp?: { build?: string; buildDir?: string }
}

export interface BuildTarget {
  /** Package-manager script name to run. */
  script: string
  /** The script's body, as written in package.json. */
  body: string
  buildDir: string
  packageManager: string
  /** Where the script name came from, for error messages. */
  source: 'gasApp.build' | 'scripts.build'
}

/** Anything that would re-enter this tool and spawn itself forever. */
const SELF_REFERENCE = /\bgas-app\s+(build|push|deploy)\b/

function readPackageJson(cwd: string): ConsumerPackage {
  const file = path.join(cwd, 'package.json')
  if (!fs.existsSync(file)) {
    throw new EnvsError(`No package.json in ${cwd} — nothing to build.`)
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as ConsumerPackage
  } catch (err) {
    throw new EnvsError(`package.json is not valid JSON: ${(err as Error).message}`)
  }
}

/**
 * Which package manager runs the script. `packageManager` wins, then a
 * lockfile, then npm — the same order every other tool in this space uses.
 */
function detectPackageManager(cwd: string, pkg: ConsumerPackage): string {
  const declared = pkg.packageManager?.split('@')[0]
  if (declared) return declared
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

/**
 * Resolve which script builds this consumer: `gasApp.build`, else the plain
 * `build` script. Every failure here is static — detected before anything is
 * spawned, which is the point of the self-reference check.
 */
export function resolveBuildCommand(cwd: string = process.cwd()): BuildTarget {
  const pkg = readPackageJson(cwd)
  const scripts = pkg.scripts ?? {}

  const configured = pkg.gasApp?.build
  const script = configured ?? 'build'
  const source: BuildTarget['source'] = configured ? 'gasApp.build' : 'scripts.build'

  const body = scripts[script]
  if (body === undefined) {
    throw new EnvsError(
      configured
        ? `gasApp.build names the script "${script}", but package.json has no such script.`
        : 'No build command found: package.json has neither a "gasApp.build" key nor a "build" script.'
    )
  }

  if (SELF_REFERENCE.test(body)) {
    throw new EnvsError(
      `The "${script}" script runs gas-app itself ("${body}"), which would spawn this command in a loop. Point it at the real build (for example "node scripts/build.mjs") and let gas-app wrap it.`
    )
  }

  return {
    script,
    body,
    buildDir: pkg.gasApp?.buildDir ?? DEFAULT_BUILD_DIR,
    packageManager: detectPackageManager(cwd, pkg),
    source,
  }
}

export interface RunBuildResult {
  target: BuildTarget
  stampPath: string
}

/**
 * Run the consumer's build for `envName`, then stamp the output.
 *
 * The child inherits stdio: a developer needs their own bundler's errors
 * verbatim. `BUILD_ENV` is set last so it overrides whatever the parent shell
 * happened to have. `UI_NESTED` matches the consumer scripts' own convention
 * for suppressing nested banners.
 */
export function runBuild(
  envName: string,
  { cwd = process.cwd() }: { cwd?: string } = {}
): RunBuildResult {
  const target = resolveBuildCommand(cwd)

  const result = spawnSync(target.packageManager, ['run', target.script], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, BUILD_ENV: envName, UI_NESTED: '1' },
  })

  if (result.error) {
    throw new EnvsError(`Could not run "${target.packageManager} run ${target.script}": ${result.error.message}`)
  }
  if (result.status !== 0) {
    // The child already printed why. Do not paraphrase it.
    throw new EnvsError(`Build failed (${target.packageManager} run ${target.script} exited ${result.status}). No stamp written.`)
  }

  // Only on success: an unstamped build directory must never look built.
  const stampPath = writeStamp(envName, { cwd, buildDir: target.buildDir })
  return { target, stampPath }
}
