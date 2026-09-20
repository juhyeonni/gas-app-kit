/**
 * The manifest guard.
 *
 * `clasp` rewrites `appsscript.json` inside `rootDir` — which, under the
 * `rootDir: build` convention, is a generated artefact the next build
 * overwrites. So a working-tree diff is the wrong test: it passes while the
 * real failure still happens, namely **a manifest clasp altered being pushed to
 * Apps Script in that same run**.
 *
 * This guard therefore compares the artefact against the repo's source manifest
 * before and after the call, and restores it unconditionally. The two directions
 * are not the same verdict: drift found *before* the call is a refusal, because
 * that manifest has not shipped yet and a rebuild fixes it. Drift found *after*
 * it is a warning — clasp normalises the manifest as a matter of course, the
 * call has already returned by the time it is visible, and exiting non-zero
 * there read as "the code never left".
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { EnvsError } from './envs.ts'
import { DEFAULT_BUILD_DIR, type ProjectPaths } from './project.ts'
import { createUI } from './ui.mjs'

export const MANIFEST_FILE = 'appsscript.json'

export class ManifestDriftError extends EnvsError {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestDriftError'
  }
}

interface Guarded {
  sourcePath: string
  artefactPath: string
  snapshot: string | null
}

function locate(cwd: string, buildDir: string): Guarded {
  const sourcePath = path.join(cwd, MANIFEST_FILE)
  const artefactPath = path.join(path.resolve(cwd, buildDir), MANIFEST_FILE)
  const snapshot = fs.existsSync(artefactPath) ? fs.readFileSync(artefactPath, 'utf-8') : null
  return { sourcePath, artefactPath, snapshot }
}

/**
 * Run `fn` with the manifest guarded.
 *
 * - Nothing to guard (no manifest in `buildDir`, e.g. an isolated scratch dir)
 *   makes this a transparent wrapper, not an error.
 * - Restoration happens in `finally`, including when `fn` throws: the failure
 *   path is when a distracted developer is least likely to notice.
 * - Compare-before-write, so an untouched manifest keeps its mtime.
 * - Returns whatever `fn` returns, so callers wrap a clasp call without
 *   changing their own shape.
 */
export function withManifest<T>(fn: () => T, { cwd, buildDir = DEFAULT_BUILD_DIR }: ProjectPaths = {}): T {
  const root = cwd ?? process.cwd()
  const { sourcePath, artefactPath, snapshot } = locate(root, buildDir)

  if (snapshot !== null && fs.existsSync(sourcePath)) {
    const source = fs.readFileSync(sourcePath, 'utf-8')
    if (source !== snapshot) {
      throw new ManifestDriftError(
        `${path.join(buildDir, MANIFEST_FILE)} differs from ${MANIFEST_FILE} before clasp ran. Rebuild so the artefact matches the source manifest — pushing this would ship a manifest nobody wrote.`
      )
    }
  }

  const keptPath = `${artefactPath}.clasp`

  /**
   * Restore if changed. `keep` preserves clasp's version alongside, because the
   * message below tells the user to adopt it and that command needs a file to
   * copy from. Not kept on the failure path, where a stray unexplained file
   * would sit next to an error about something else entirely.
   */
  const restore = (keep: boolean): boolean => {
    if (snapshot === null) return false
    const after = fs.existsSync(artefactPath) ? fs.readFileSync(artefactPath, 'utf-8') : null
    if (after === snapshot) return false
    // Compare-before-write: only touch the file when it actually changed, so an
    // untouched manifest keeps its mtime (unit 006 reads mtimes).
    if (keep && after !== null) fs.writeFileSync(keptPath, after)
    fs.writeFileSync(artefactPath, snapshot)
    return true
  }

  let result: T
  try {
    result = fn()
  } catch (err) {
    // Restore on the failure path too — but let the original error through.
    // Reporting drift instead would bury why the command actually failed.
    restore(false)
    throw err
  }

  if (restore(true)) {
    // A warning, not a refusal. clasp v3 normalises the manifest as a matter of
    // course, so this fires on an ordinary first push — and by the time it is
    // detected the call has already returned. exit 1 here read as "the code
    // never left", which was the opposite of what had happened; the caller's own
    // success or failure line is what answers that question.
    const ui = createUI('gas-app')
    ui.warn(
      `clasp rewrote ${path.join(buildDir, MANIFEST_FILE)} during this run — it normalises the manifest, ` +
        `filling in defaults like timeZone, runtimeVersion and exceptionLogging. Your ${MANIFEST_FILE} was restored.`
    )
    if (fs.existsSync(keptPath)) {
      ui.info(`clasp's version was kept — adopt it once and this stops recurring:`)
      ui.info(`  cp ${path.relative(root, keptPath)} ${MANIFEST_FILE}`)
    }
    ui.info(`(${MANIFEST_FILE} is the Apps Script project manifest: runtime, timezone and OAuth scopes.)`)
  }
  return result
}
