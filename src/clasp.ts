/**
 * The one place that shells out to clasp.
 *
 * Results are read from `--json` (a global option in clasp v3), never by
 * parsing human-readable stdout — see memory-bank clasp-v3-verification.md V-1.
 */

import { spawnSync } from 'node:child_process'

export type ClaspResult<T> = { ok: true; data: T } | { ok: false; reason: string }

/**
 * What to say when clasp cannot authenticate.
 *
 * clasp forwards Google's OAuth error object verbatim — `{"error":"invalid_grant",
 * "error_description":"reauth related error (invalid_rapt)", …}` — which names
 * neither clasp nor the command that fixes it, and reached the user as that
 * blob. Expiry needs no action to happen, so this is the most common non-happy
 * path in the tool's life and it deserves the same treatment as every other
 * refusal here: name what to run.
 */
export const AUTH_REASON =
  'clasp is not authenticated, or the session has expired. Run "clasp login" and try again.'

const AUTH_FAILURE =
  /invalid_grant|invalid_rapt|invalid_credentials|unauthorized|not (?:logged in|authenticated)|no credentials/i

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
    // Not just the first line: the OAuth blob clasp prints can wrap, and the
    // token that identifies it may not land on the line the message starts on.
    const said = (result.stderr || '').trim()
    const firstLine = said.split('\n')[0]
    if (said && AUTH_FAILURE.test(said)) return { ok: false, reason: AUTH_REASON }
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
    const raw = (result.stderr || result.stdout || '').trim()
    if (raw && AUTH_FAILURE.test(raw)) return { ok: false, reason: AUTH_REASON }
    const said = raw.split('\n')[0]
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

/**
 * clasp's reported version, or null when it is not on PATH at all.
 *
 * Here rather than in envs-add.ts, where it used to live: every command shells
 * out to clasp, but only project creation checked that clasp was the right one,
 * so a v2 install was named clearly during `envs add` and then failed deep
 * inside clasp everywhere else.
 */
export function claspVersion(): string | null {
  const probe = spawnSync('clasp', ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (probe.error || probe.status !== 0) return null
  return probe.stdout.trim()
}

/**
 * Whether the installed clasp is one this tool can drive.
 *
 * An unparseable version is let through: a false reject is worse than a late
 * failure, and clasp has shipped version strings this parse does not expect.
 */
export function claspSupported(version: string): boolean {
  const major = Number.parseInt(version, 10)
  return Number.isNaN(major) || major >= 3
}

/**
 * Who clasp is authenticated as. Detection only — `clasp login` is
 * browser-interactive, and launching it from a CI-drivable command reintroduces
 * exactly the interactivity the rest of this tool removes.
 */
export function claspAuthorizedUser(): { loggedIn: boolean; email?: string } {
  const probe = spawnSync('clasp', ['show-authorized-user', '--json'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (probe.error || probe.status !== 0) return { loggedIn: false }
  try {
    const parsed = JSON.parse(probe.stdout) as { loggedIn?: boolean; email?: string }
    if (!parsed || Object.keys(parsed).length === 0) return { loggedIn: false }
    // clasp v3 reports `loggedIn` explicitly; older shapes only carried fields.
    if (parsed.loggedIn === false) return { loggedIn: false }
    return parsed.email ? { loggedIn: true, email: parsed.email } : { loggedIn: true }
  } catch {
    return { loggedIn: false }
  }
}
