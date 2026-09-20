/**
 * The public surface: what a consumer's own script plausibly calls.
 *
 * Two rules hold here:
 *   - nothing imports from cli.ts; the dependency runs one way only, or a
 *     consumer importing one function would pull in argv parsing it never
 *     asked for.
 *   - no top-level `await` anywhere in this graph. `require()` of an ESM
 *     package throws ERR_REQUIRE_ASYNC_MODULE if the graph contains one, and
 *     that is the only thing keeping CJS consumers working without a second
 *     build. cli.ts may use it — an executable is never `require`d.
 *
 * A third rule now: this file is a *choice*, not the contents of the src
 * directory. It used to re-export everything — 44 values and 29 types, which
 * made `escapeCssForGas`, `brokenLinks` and the output format itself into
 * public API by accident of being in the barrel. What genuinely belongs to
 * someone else's build script lives here; the rest is in `gas-app-kit/internal`,
 * which carries no compatibility promise.
 */

// The registry. The whole point of the tool is that one file answers "which
// environments exist", so reading it is the most likely thing to want.
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

// Provisioning, for anything that creates environments programmatically.
export { addEnv, type AddEnvOptions, type AddEnvResult } from './envs-add.ts'

// The operations. Importable so a script does not have to shell out to the CLI.
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
  type VersionRow,
  type ListVersionsResult,
  type ListVersionsOptions,
  type RollbackOptions,
  type RollbackResult,
} from './rollback.ts'
export { promote, type PromoteOptions, type PromoteResult } from './promote.ts'
export { resolveBuildCommand, runBuild, type BuildTarget, type RunBuildResult } from './build.ts'

/**
 * Build identity. The README's one worked example: call `collectBuildInfo` once
 * and derive every display from the single returned object, because two calls
 * can disagree.
 */
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

// Preflight and the gate, both reasonable to run from a custom pipeline.
export {
  runDoctor,
  type DoctorResult,
  type DoctorCheck,
  type CheckLevel,
  type DoctorOptions,
} from './commands/doctor.ts'
export {
  diffEnv,
  type DiffResult,
  type DiffEntry,
  type FileVerdict,
  type DiffOptions,
} from './commands/diff.ts'
export { runGate, type GateResult, type CheckResult, type CheckStatus, type RunGateOptions } from './gate.ts'

// Talking to clasp directly, for the one-off this tool does not wrap.
export { claspJson, listDeployments, type ClaspResult, type DeploymentRow } from './clasp.ts'

/** Optional, and documented as replaceable — its internals are not part of this. */
export { buildWebApp, type BuildWebAppOptions, type BuildWebAppResult } from './build-web-app.ts'
