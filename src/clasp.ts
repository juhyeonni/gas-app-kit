/**
 * The one place that shells out to clasp.
 *
 * Results are read from `--json` (a global option in clasp v3), never by
 * parsing human-readable stdout — see memory-bank clasp-v3-verification.md V-1.
 */

import { spawnSync } from 'node:child_process'

export type ClaspResult<T> = { ok: true; data: T } | { ok: false; reason: string }

/** One row of `clasp list-deployments --json`. `@HEAD` carries no versionNumber. */
export interface DeploymentRow {
  deploymentId: string
  versionNumber?: number | undefined
  description?: string | undefined
}

/**
 * Run clasp and parse its JSON output.
 * Never throws: the only caller so far (`envs`) must degrade rather than die
 * when clasp is missing or the caller is logged out.
 */
export function claspJson<T = unknown>(args: string[]): ClaspResult<T> {
  const result = spawnSync('clasp', [...args, '--json'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code
    return { ok: false, reason: code === 'ENOENT' ? 'clasp not found on PATH' : result.error.message }
  }
  if (result.status !== 0) {
    const firstLine = (result.stderr || '').trim().split('\n')[0]
    return { ok: false, reason: firstLine || `clasp exited ${result.status}` }
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) as T }
  } catch {
    // clasp v3 can fail while exiting 0: it writes the reason to stderr and
    // nothing to stdout (observed 2026-09-01 — "ANYONE access has been disabled
    // by your domain administrator." on create-deployment, exit 0). Reporting
    // only "not JSON" there throws away the one line that says what to fix, so
    // whatever clasp did say is carried through verbatim.
    const said = (result.stderr || result.stdout || '').trim().split('\n')[0]
    return {
      ok: false,
      reason: said ? `clasp reported: ${said}` : 'clasp returned output that is not JSON, and said nothing else',
    }
  }
}

/**
 * Deployments for a script id. `list-deployments` takes the id positionally, so
 * this needs no .clasp.json and no `--project` — which is what keeps the `envs`
 * command independent of the clasp-config machinery in bolt 046.
 */
export function listDeployments(scriptId: string): ClaspResult<DeploymentRow[]> {
  return claspJson<DeploymentRow[]>(['list-deployments', scriptId])
}

/** One row of `clasp list-versions --json`. */
export interface VersionRowRaw {
  versionNumber: number
  description?: string | undefined
}

/**
 * Versions of a script — the actual rollback candidates.
 *
 * Distinct from `listDeployments`, and the distinction is easy to get wrong:
 * deployments are *pointers*, so a project that reuses one deployment id
 * reports a single row no matter how many versions exist behind it. Measured
 * 2026-09-01 on a throwaway project: 6 versions, 2 deployments (one `@HEAD`).
 */
export function listVersionRows(scriptId: string): ClaspResult<VersionRowRaw[]> {
  return claspJson<VersionRowRaw[]>(['list-versions', scriptId])
}
