/**
 * `gas-app promote <from> <to>` — ship the exact code an environment verified.
 *
 * `deploy production` rebuilds from the working tree, so the bytes staging
 * approved and the bytes production receives were never the same artefact —
 * only, at best, the same commit. A rebuild re-resolves dependencies, re-runs
 * whatever the build does with timestamps and BUILD_ENV, and picks up anything
 * that changed in the tree meanwhile. It also runs the build at the moment it
 * is least wanted: after the code is already known good.
 *
 * That sat badly with this project's headline guarantee — *the artefact belongs
 * to the environment*. The stamp proves an artefact was built **for**
 * production. Nothing proved it was the artefact staging approved.
 *
 * ## What this is, and is not
 *
 * Environments here are separate Apps Script projects, each with its own
 * scriptId, and a **version number belongs to a script**. So promotion cannot
 * be a pointer move: `staging@12` has no meaning against production's script.
 * It is a code move — fetch the source of that immutable version, push it to
 * the target, cut a version there.
 *
 * What that does and does not buy:
 *   - **No rebuild.** The bytes are the ones the source version holds, fetched
 *     from Apps Script rather than produced again. This is most of the value.
 *   - **Not byte-identity across the pointer.** The target gets its own version
 *     number, unrelated to the source's, because it is a different script.
 *
 * ## Why nothing here imports the build
 *
 * Same reason `rollback` does not: promotion exists to move code that is
 * already known good, and requiring a buildable tree to do it would make the
 * command useless exactly when the tree is the problem.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

import { loadEnvs, saveEnvs, resolveEnv, EnvsError, ENVS_ENV_VAR, type EnvEntry, type LoadEnvsOptions } from './envs.ts'
import { assertProvisioned, writeClaspConfig } from './project.ts'
import { claspJson, type DeploymentRow } from './clasp.ts'
import { listVersions } from './rollback.ts'
import { promptYesNo } from './prompt.ts'
import { webAppUrl } from './links.ts'
import { createUI } from './ui.mjs'

export interface PromoteOptions extends LoadEnvsOptions {
  /** Promote this version of the source rather than the one it currently serves. */
  version?: number | undefined
  yes?: boolean
  /** Injected by tests; the CLI passes the real prompt. */
  confirm?: (question: string) => boolean
}

export interface PromoteResult {
  from: EnvEntry
  to: EnvEntry
  /** The source version whose code was moved. */
  sourceVersion: number
  /** The version created on the target. Unrelated to `sourceVersion` — different script. */
  targetVersion: number | undefined
  deploymentId: string
  description: string
  persisted: boolean
  declined?: boolean
}

/** The policy flag guards the target: promotion writes to it, exactly as deploy does. */
function assertWritable(entry: EnvEntry, env: Record<string, string | undefined>): void {
  if (env.CI === 'true' || entry.allowLocalDeploy) return
  throw new EnvsError(
    `Environment "${entry.name}" has allowLocalDeploy: false — promoting into it from a local machine is refused. ` +
      `A promotion pushes code, so it replaces that script's HEAD just as a deploy does. ` +
      `Do it from CI, or set the flag in envs.json if that policy is wrong.`
  )
}

/** Fetch the source of one immutable version into `into`. */
function pullVersion(entry: EnvEntry, versionNumber: number, into: string, configDir: string): void {
  const configPath = writeClaspConfig(entry, { cwd: configDir, buildDir: into })
  const result = spawnSync(
    'clasp',
    ['pull', '--versionNumber', String(versionNumber), '--project', configPath],
    { cwd: into, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code
    throw new EnvsError(
      code === 'ENOENT' ? 'clasp not found on PATH.' : `Could not run clasp pull: ${result.error.message}`
    )
  }
  if (result.status !== 0) {
    const said = (result.stderr || result.stdout || '').trim().split('\n')[0]
    throw new EnvsError(
      `Could not read version ${versionNumber} of "${entry.name}": ${said || `clasp exited ${result.status}`}\n` +
        'Nothing was written to the target.'
    )
  }
  if (fs.readdirSync(into).length === 0) {
    throw new EnvsError(
      `clasp returned no files for version ${versionNumber} of "${entry.name}". Refusing to push an empty project.`
    )
  }
}

/**
 * Promote the code of one environment's version into another.
 *
 * Deliberately *not* enforcing `allowPrerelease`: it is enforced nowhere else
 * either (see #63), and a rule that applies in one command and not in `deploy`
 * is harder to reason about than one that is uniformly inert until decided.
 */
export function promote(
  fromName: string | undefined,
  toName: string | undefined,
  options: PromoteOptions = {}
): PromoteResult {
  const { cwd = process.cwd(), env = process.env, yes = false } = options
  const ui = createUI('gas-app promote')

  if (!fromName || !toName) {
    throw new EnvsError('Usage: gas-app promote <from> <to> [version]')
  }
  if (fromName === toName) {
    throw new EnvsError(`"${fromName}" cannot be promoted into itself.`)
  }

  const registry = loadEnvs({ ...options, cwd, env })
  const from = resolveEnv(registry, fromName)
  const to = resolveEnv(registry, toName)
  assertProvisioned(from)
  assertProvisioned(to)
  assertWritable(to, env)

  // Which version of the source. The default is what it actually serves —
  // "promote what staging verified" is the whole point, and that is the
  // deployed version, not the newest one that happens to exist.
  const listed = listVersions(fromName, { ...options, cwd, env })
  if (options.version === undefined && listed.currentIsHead) {
    throw new EnvsError(
      `"${from.name}" serves @HEAD, which is not a version — there is nothing immutable to promote. ` +
        `Deploy it first, or name a version: "gas-app promote ${from.name} ${to.name} <version>".`
    )
  }
  const sourceVersion = options.version ?? listed.current?.versionNumber
  if (sourceVersion === undefined) {
    throw new EnvsError(
      `"${from.name}" has no deployed version to promote. Run "gas-app deploy ${from.name}" first, ` +
        `or name a version: "gas-app promote ${from.name} ${to.name} <version>".`
    )
  }
  const source = listed.versions.find((v) => v.versionNumber === sourceVersion)
  if (!source) {
    const available = listed.versions.map((v) => `${v.versionNumber} (${v.description})`).join(', ')
    throw new EnvsError(
      `Version ${sourceVersion} is not a version of "${from.name}". Available: ${available}` +
        (listed.total > listed.versions.length ? `, +${listed.total - listed.versions.length} older` : '')
    )
  }

  // The label says where the code came from. The target's own version number is
  // unrelated to the source's, so without this the trail is unrecoverable.
  const description = `${source.description} (promoted from ${from.name}@${sourceVersion})`

  if (!yes && env.CI !== 'true') {
    const confirm =
      options.confirm ??
      ((question: string) =>
        promptYesNo(question, `gas-app promote ${from.name} ${to.name} ${sourceVersion} --yes`))
    if (
      !confirm(
        `Promote "${from.name}" version ${sourceVersion} (${source.description}) into "${to.name}"? ` +
          `This replaces ${to.name}'s code with that version's and deploys it.`
      )
    ) {
      ui.info('declined — nothing promoted')
      return {
        from,
        to,
        sourceVersion,
        targetVersion: undefined,
        deploymentId: to.deploymentId,
        description,
        persisted: false,
        declined: true,
      }
    }
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-promote-'))
  const codeDir = path.join(temp, 'code')
  const configDir = path.join(temp, 'config')
  fs.mkdirSync(codeDir)
  fs.mkdirSync(configDir)

  try {
    pullVersion(from, sourceVersion, codeDir, configDir)

    // No manifest guard here, on purpose. That guard compares the artefact
    // against the repo's source manifest, and this artefact did not come from
    // the repo — it came from the source environment. Promoting the source
    // version's manifest along with its code is the correct behaviour, and the
    // temp copy clasp may rewrite is discarded either way.
    const targetConfig = writeClaspConfig(to, { cwd: configDir, buildDir: codeDir })
    const pushed = claspJson<string[]>(['push', '--force', '--project', targetConfig])
    if (!pushed.ok) {
      throw new EnvsError(
        `Could not push version ${sourceVersion} of "${from.name}" to "${to.name}": ${pushed.reason}\n` +
          `"${to.name}" still serves what it served before — no version was created.`
      )
    }

    const args = ['create-deployment', '--description', description, '--project', targetConfig]
    if (to.deploymentId) args.push('--deploymentId', to.deploymentId)
    const deployed = claspJson<DeploymentRow>(args)
    if (!deployed.ok) {
      throw new EnvsError(
        `"${to.name}" received the code but the deployment failed: ${deployed.reason}\n` +
          `Its HEAD is now version ${sourceVersion} of "${from.name}", but the deployment still points at the previous version. ` +
          `Re-run to finish, or "gas-app versions ${to.name}" to see what exists.`
      )
    }

    const deploymentId = deployed.data.deploymentId || to.deploymentId
    let persisted = false
    if (deploymentId && deploymentId !== to.deploymentId) {
      const current = loadEnvs({ ...options, cwd, env })
      current[to.name] = { ...to, deploymentId }
      try {
        saveEnvs(current, { ...options, cwd, env })
        persisted = true
      } catch {
        ui.warn(
          env[ENVS_ENV_VAR]
            ? `the registry came from ${ENVS_ENV_VAR}, so there is no file to record the new deployment id in. ` +
                `Add "deploymentId": "${deploymentId}" to "${to.name}" wherever that variable is defined.`
            : `could not write the new deployment id to envs.json. Add "deploymentId": "${deploymentId}" to "${to.name}" by hand.`
        )
      }
    }

    ui.item(
      `"${to.name}" now runs "${from.name}" version ${sourceVersion} — nothing was rebuilt`
    )
    ui.info(`${to.name} version ${deployed.data.versionNumber ?? '(unknown)'}: ${description}`)
    if (deploymentId) ui.info(webAppUrl(deploymentId))
    return {
      from,
      to,
      sourceVersion,
      targetVersion: deployed.data.versionNumber,
      deploymentId,
      description,
      persisted,
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
