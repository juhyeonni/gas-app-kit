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
 * before and after the call, restores it unconditionally in `finally`, and
 * treats post-call drift as a refusal rather than a silent cleanup.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { EnvsError } from './envs.ts'
import { DEFAULT_BUILD_DIR, type ProjectPaths } from './project.ts'

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

  /** Restore if changed. Returns whether it had drifted. */
  const restore = (): boolean => {
    if (snapshot === null) return false
    const after = fs.existsSync(artefactPath) ? fs.readFileSync(artefactPath, 'utf-8') : null
    if (after === snapshot) return false
    // Compare-before-write: only touch the file when it actually changed, so an
    // untouched manifest keeps its mtime (unit 006 reads mtimes).
    fs.writeFileSync(artefactPath, snapshot)
    return true
  }

  let result: T
  try {
    result = fn()
  } catch (err) {
    // Restore on the failure path too — but let the original error through.
    // Reporting drift instead would bury why the command actually failed.
    restore()
    throw err
  }

  if (restore()) {
    throw new ManifestDriftError(
      `clasp modified ${path.join(buildDir, MANIFEST_FILE)} during this run. The local file has been restored, but the altered manifest already reached Apps Script — verify the deployment's declared scopes and services.`
    )
  }
  return result
}
