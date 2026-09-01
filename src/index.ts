/**
 * Library surface. Importable without going through the CLI, so a consumer's
 * own script can resolve environments without spawning a subprocess.
 *
 * Two rules hold here:
 *   - nothing imports from cli.ts; the dependency runs one way only, or a
 *     consumer importing one function would pull in argv parsing it never
 *     asked for.
 *   - no top-level `await` anywhere in this graph. `require()` of an ESM
 *     package throws ERR_REQUIRE_ASYNC_MODULE if the graph contains one, and
 *     that is the only thing keeping CJS consumers working without a second
 *     build. cli.ts may use it — an executable is never `require`d.
 */

export {
  loadEnvs,
  saveEnvs,
  resolveEnv,
  envState,
  EnvsError,
  ENVS_FILE,
  ENVS_ENV_VAR,
  type EnvEntry,
  type EnvRegistry,
  type EnvState,
  type LoadEnvsOptions,
} from './envs.ts'
export { editorUrl, webAppUrl } from './links.ts'
export { claspJson, listDeployments, type ClaspResult, type DeploymentRow } from './clasp.ts'
export {
  writeClaspConfig,
  claspConfigPath,
  writeStamp,
  readStamp,
  assertEnvMatch,
  DEFAULT_BUILD_DIR,
  STAMP_FILE,
  type BuildStamp,
  type ProjectPaths,
} from './project.ts'
export { withManifest, ManifestDriftError, MANIFEST_FILE } from './manifest.ts'
export { addEnv, type AddEnvOptions, type AddEnvResult } from './envs-add.ts'
export { resolveBuildCommand, runBuild, type BuildTarget, type RunBuildResult } from './build.ts'
export {
  push,
  deploy,
  type PushOptions,
  type PushResult,
  type DeployOptions,
  type DeployResult,
} from './deploy.ts'
export {
  listVersions,
  rollback,
  toCandidates,
  currentVersionOf,
  formatVersions,
  DEFAULT_VERSION_LIMIT,
  type VersionRow,
  type ListVersionsResult,
  type ListVersionsOptions,
  type RollbackOptions,
  type RollbackResult,
} from './rollback.ts'
export {
  resolveVersion,
  collectBuildInfo,
  formatDescription,
  type VersionSpec,
  type VersionSource,
  type BuildInfo,
  type ResolveVersionOptions,
  type CollectBuildInfoOptions,
} from './version.ts'
export {
  runGate,
  brokenLinks,
  type GateResult,
  type CheckResult,
  type CheckStatus,
  type RunGateOptions,
} from './gate.ts'
export { createUI } from './ui.mjs'
