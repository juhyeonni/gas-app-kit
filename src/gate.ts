/**
 * The pre-push quality gate: typecheck, then unit tests.
 *
 * Three properties are load-bearing, each for a measured reason:
 *
 *   - **Sequential.** A parallel full-suite run on a loaded machine produces
 *     worker timeouts that read as real failures.
 *   - **Lint excluded.** It does not break a deployment, and including it makes
 *     the gate slow enough that `--skip-checks` becomes a habit.
 *   - **Degrades, never blanket-fails.** When typecheck fails *and* the checkout
 *     has linked dependencies that do not resolve, the failure is environmental
 *     rather than a code defect: the gate warns, records it as degraded, and
 *     still runs the tests. A gate that hard-fails in an environment that cannot
 *     typecheck at all makes `--skip-checks` permanent, which is what the gate
 *     exists to prevent.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

import { createUI } from './ui.mjs'

export type CheckStatus = 'passed' | 'failed' | 'degraded' | 'absent'

export interface CheckResult {
  name: 'typecheck' | 'test'
  status: CheckStatus
  /** Why it degraded or was absent. */
  reason?: string
}

export interface GateResult {
  ran: boolean
  /** Set when the whole gate was skipped rather than run. */
  skippedBecause?: 'flag' | 'ci'
  checks: CheckResult[]
  passed: boolean
}

export interface RunGateOptions {
  cwd?: string
  skipChecks?: boolean
  env?: NodeJS.ProcessEnv
}

/**
 * Directories where a workspace's linked dependencies land. One level of
 * workspace packages is enough for every layout this tool targets.
 */
function linkRoots(cwd: string): string[] {
  const roots = [path.join(cwd, 'node_modules')]
  const packages = path.join(cwd, 'packages')
  if (fs.existsSync(packages)) {
    for (const entry of fs.readdirSync(packages)) {
      roots.push(path.join(packages, entry, 'node_modules'))
    }
  }
  return roots.filter((dir) => fs.existsSync(dir))
}

/**
 * Dependencies installed as symlinks whose target no longer exists.
 *
 * Detected by resolving the link, not by matching a path: one relative `link:`
 * specifier cannot be correct at two directory depths, so path-matching would
 * need a new case for every depth forever.
 */
export function brokenLinks(cwd: string = process.cwd()): string[] {
  const broken: string[] = []

  const inspect = (dir: string, display: string): void => {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(dir)
    } catch {
      return
    }
    if (!stat.isSymbolicLink()) return
    if (!fs.existsSync(dir)) broken.push(display)
  }

  for (const root of linkRoots(cwd)) {
    for (const entry of fs.readdirSync(root)) {
      const full = path.join(root, entry)
      if (entry.startsWith('@')) {
        // Scoped packages nest one level deeper.
        let scoped: string[]
        try {
          scoped = fs.readdirSync(full)
        } catch {
          continue
        }
        for (const name of scoped) inspect(path.join(full, name), `${entry}/${name}`)
        continue
      }
      inspect(full, entry)
    }
  }

  return [...new Set(broken)]
}

function hasScript(cwd: string, name: string): boolean {
  const file = path.join(cwd, 'package.json')
  if (!fs.existsSync(file)) return false
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf-8')) as { scripts?: Record<string, string> }
    return typeof pkg.scripts?.[name] === 'string'
  } catch {
    return false
  }
}

function runScript(cwd: string, name: string): boolean {
  // Output is the product on failure — forward it verbatim.
  const result = spawnSync('npm', ['run', '--silent', name], { cwd, stdio: 'inherit' })
  return !result.error && result.status === 0
}

/**
 * Run the gate. Returns what happened; the caller decides the exit code, so
 * this stays usable as a library function.
 */
export function runGate({ cwd = process.cwd(), skipChecks = false, env = process.env }: RunGateOptions = {}): GateResult {
  const ui = createUI('gas-app gate')

  // Either condition alone is enough; say which one applied.
  if (skipChecks) {
    ui.warn('checks skipped (--skip-checks)')
    return { ran: false, skippedBecause: 'flag', checks: [], passed: true }
  }
  if (env.CI === 'true') {
    ui.info('checks skipped (CI=true — CI runs them as separate jobs)')
    return { ran: false, skippedBecause: 'ci', checks: [], passed: true }
  }

  const checks: CheckResult[] = []

  // 1. typecheck. It always *runs*; a broken link only changes how a failure is
  //    classified. Skipping upfront on the mere presence of a broken symlink
  //    silently disables typecheck wherever a stale link lingers — measured on a
  //    real monorepo carrying a dead workspace link from a package that had been
  //    merged away, which nonetheless typechecks perfectly.
  if (!hasScript(cwd, 'typecheck')) {
    checks.push({ name: 'typecheck', status: 'absent', reason: 'no "typecheck" script' })
  } else if (runScript(cwd, 'typecheck')) {
    checks.push({ name: 'typecheck', status: 'passed' })
  } else {
    const broken = brokenLinks(cwd)
    if (broken.length > 0) {
      const reason = `typecheck failed and these linked dependencies do not resolve: ${broken.join(', ')}`
      ui.warn(`${reason} — treating as environmental, not a code failure. Tests still run.`)
      checks.push({ name: 'typecheck', status: 'degraded', reason })
    } else {
      checks.push({ name: 'typecheck', status: 'failed' })
    }
  }

  // 2. tests — sequentially, after typecheck, never concurrently with it.
  if (!hasScript(cwd, 'test')) {
    checks.push({ name: 'test', status: 'absent', reason: 'no "test" script' })
  } else {
    checks.push({ name: 'test', status: runScript(cwd, 'test') ? 'passed' : 'failed' })
  }

  // A degraded typecheck does not excuse failing tests.
  const passed = !checks.some((c) => c.status === 'failed')
  return { ran: true, checks, passed }
}
