/**
 * `gas-app-kit/internal` — reachable, and deliberately not promised.
 *
 * These were in the main entry point by accident of being in the barrel file,
 * which made them semver: the output format could not be tidied without a
 * breaking change, and `buildWebApp`'s internals were frozen despite that
 * function being documented as optional and replaceable.
 *
 * They are still exported, because something may be relying on them and a
 * removal is worse than a move. Nothing here carries a compatibility promise:
 * it can change in any release. If you find yourself needing one of these,
 * that is worth an issue — it probably means the public surface is missing
 * something.
 */

export { registryPath, serializeRegistry } from './envs.ts'
export {
  writeClaspConfig,
  claspConfigPath,
  writeStamp,
  readStamp,
  assertEnvMatch,
  assertProvisioned,
  resolveBuildDir,
  detectPackageManager,
  DEFAULT_BUILD_DIR,
  STAMP_FILE,
  type BuildStamp,
  type ProjectPaths,
} from './project.ts'
export { withManifest, ManifestDriftError, MANIFEST_FILE } from './manifest.ts'
export { claspVersion, claspSupported, claspAuthorizedUser, AUTH_REASON } from './clasp.ts'
export { brokenLinks } from './gate.ts'
export { toCandidates, currentVersionOf, formatVersions, DEFAULT_VERSION_LIMIT } from './rollback.ts'
export {
  stripGasSyntax,
  escapeJsForGas,
  escapeCssForGas,
  renderBanner,
  renderIndexHtml,
} from './build-web-app.ts'

/**
 * The CLI's output helpers. Exported here rather than from the main entry so
 * that tidying how this tool prints is not a breaking change to a module nobody
 * meant to publish. It is also plain JavaScript with no types.
 */
export { createUI } from './ui.mjs'
