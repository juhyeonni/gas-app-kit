#!/usr/bin/env node
/**
 * gas-app — the CLI dispatcher.
 *
 * Thin on purpose: parse, route, translate a refusal into an exit code. All
 * logic lives in the modules beside it, which never import this file.
 *
 * Exit codes: 0 success · 1 failure · 2 usage error.
 */

import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { EnvsError, loadEnvs, resolveEnv } from './envs.ts'
import { envsCommand } from './commands/envs.ts'
import { openCommand } from './commands/open.ts'
import { doctorCommand } from './commands/doctor.ts'
import { addEnv } from './envs-add.ts'
import { runBuild } from './build.ts'
import { push, deploy } from './deploy.ts'
import { listVersions, formatVersions, rollback } from './rollback.ts'
import { editorUrl } from './links.ts'
import { createUI } from './ui.mjs'

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2

/**
 * A CLI's output is routinely read by something that stops early — `| head`,
 * `| grep -q`, a pager the user quits. The reader closes the pipe, the next
 * write fails with EPIPE, and Node's default for an 'error' event with no
 * listener is to throw: `gas-app --help | head -3` printed a stack trace and
 * exited non-zero, reproducibly, for a command that did nothing wrong.
 *
 * A closed reader is not this program's failure, so it is not reported as one.
 * Anything else on these streams still surfaces the way it did before.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(EXIT_OK)
    throw err
  })
}

interface CommandSpec {
  /** One line, shown in the command list. */
  summary: string
  /** Everything after `gas-app`, as it should be typed. */
  usage: string
  /**
   * Flags this command accepts, beyond the global ones. This list is the only
   * source: the stray-flag check and the command's own help both read it, so a
   * flag cannot be accepted by a command whose help omits it.
   */
  flags: readonly string[]
  /** Behaviour a flag list cannot convey. Shown only under the command's own help. */
  notes?: readonly string[]
}

const COMMANDS: Record<string, CommandSpec> = {
  doctor: {
    summary: 'check clasp, authentication, the registry and the build, and say what is wrong',
    usage: 'doctor',
    flags: ['json'],
    notes: [
      'Read-only: it writes no file and touches no deployment. Exits non-zero only when',
      'something makes every remote command impossible — clasp missing or the wrong major',
      'version, no authentication, an unreadable registry. Not having built yet, and an',
      'environment with no scriptId, are states rather than defects and do not fail it.',
    ],
  },
  envs: {
    summary: 'list registered environments and their state',
    usage: 'envs',
    flags: ['json'],
    notes: [
      'Reports one of four states per environment: unprovisioned (no scriptId), undeployed (no',
      'deploymentId), @<n> (serving version n), and "deployed (version unknown)" — the last',
      'whenever the version cannot be read from Google, which includes being logged out.',
      'To create or register an environment, see "gas-app envs add --help".',
    ],
  },
  open: {
    summary: 'print editor and web-app URLs for an environment',
    usage: 'open [env]',
    flags: [],
    notes: [
      'With no environment, prints every one. An environment that is not deployed yet is a',
      'state, not a failure: its editor URL is printed and the command exits 0.',
    ],
  },
  build: {
    summary: "run the consumer's build for an environment and stamp the output",
    usage: 'build <env>',
    flags: [],
    notes: [
      'Runs your own build script with BUILD_ENV set, then writes a stamp naming the',
      'environment it built for. push refuses output whose stamp does not match.',
    ],
  },
  push: {
    summary: 'gate, build, verify, then push the code to an environment',
    usage: 'push <env>',
    flags: ['skip-checks', 'no-build', 'dry-run'],
    notes: [
      '--dry-run runs the gate, the build and the stamp check, then stops before the upload.',
      'The policy flag is evaluated, not bypassed: the point is to see a refusal safely.',
      'Refused unless the environment has "allowLocalDeploy": true, or CI=true. A push',
      "replaces the script's HEAD code, which bound triggers and onOpen menus run from",
      'immediately — rollback cannot undo it, which is why it is gated like deploy.',
    ],
  },
  deploy: {
    summary: 'push, then create or update the environment’s deployment',
    usage: 'deploy <env>',
    flags: ['skip-checks', 'no-build', 'dry-run', 'description', 'yes'],
    notes: [
      'Confirms first. With no terminal to ask on it refuses rather than assuming consent —',
      'pass --yes, or set CI=true, to state the intent explicitly.',
      'Creates a new immutable version and moves the deployment pointer at it.',
    ],
  },
  versions: {
    summary: 'list the versions an environment can be rolled back to',
    usage: 'versions <env>',
    flags: ['json'],
    notes: ['The version the environment currently serves is marked with an arrow.'],
  },
  rollback: {
    summary: 'repoint an environment at an earlier version, without rebuilding',
    usage: 'rollback <env> [version]',
    flags: ['yes'],
    notes: [
      'The version is optional: omitting it lists the candidates and refuses, rather than',
      'choosing one for you. Nothing is built — the tree being unbuildable is frequently why',
      'you are rolling back. @HEAD is never a target.',
      'Confirms first; with no terminal it refuses and names the --yes form that would work.',
    ],
  },
}

/** `envs add` is the one nested form, and it carries four flags of its own. */
const ENVS_ADD: CommandSpec = {
  summary: 'create a new Apps Script project, or register one that already exists',
  usage: 'envs add <name>',
  flags: ['script-id', 'title', 'type', 'force'],
  notes: [
    'Without --script-id this creates a real Apps Script project in your Drive.',
    'A newly registered environment cannot be written to from this machine until you set',
    '"allowLocalDeploy": true for it in envs.json yourself — the flag fails closed.',
  ],
}

/**
 * One description per flag, shown in the global help and in each command's own.
 * The "push, deploy:" prefixes are kept under a single command too: they say the
 * flag is shared, which is worth knowing at either altitude.
 */
const FLAGS: Record<string, string> = {
  envs: 'path to the environment registry (default: ./envs.json, searched upward)',
  'script-id': 'envs add: register an existing project instead of creating one',
  title: 'envs add: title for a newly created project (default: the env name)',
  type: 'envs add: clasp project type (default: standalone)',
  force: 'envs add: overwrite an existing registry entry',
  'skip-checks': 'push, deploy: skip the typecheck/test gate',
  'no-build': 'push, deploy: push what is already built and stamped',
  'dry-run': 'push, deploy: run the gate, build and checks, then stop before uploading',
  description: 'deploy: label for the deployment (default: derived from version + sha)',
  yes: 'deploy, rollback: skip the confirmation prompt',
  json: 'envs, versions: print the result as JSON instead of for reading',
  help: 'show this message',
  version: 'print the gas-app-kit version',
}

/** How each flag is spelled in a help listing, `-h, --help` included. */
const FLAG_SPELLING: Record<string, string> = {
  envs: '--envs <path>',
  'script-id': '--script-id <id>',
  title: '--title <text>',
  type: '--type <type>',
  force: '--force',
  'skip-checks': '--skip-checks',
  'no-build': '--no-build',
  'dry-run': '--dry-run',
  description: '--description <t>',
  yes: '--yes',
  json: '--json',
  help: '-h, --help',
  version: '-v, --version',
}

/**
 * Global options every subcommand shares. `strict: true` makes an unsupported
 * flag a parse error rather than something silently ignored, which is FR-5's
 * "unknown flags exit non-zero" for free. `allowPositionals` must be set
 * explicitly — strict mode defaults it to false, and every command takes an env.
 */
const OPTIONS = {
  envs: { type: 'string' },
  'script-id': { type: 'string' },
  title: { type: 'string' },
  type: { type: 'string' },
  force: { type: 'boolean' },
  'skip-checks': { type: 'boolean' },
  'no-build': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  description: { type: 'string' },
  yes: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const

const GLOBAL_FLAGS = ['envs', 'help', 'version'] as const

/** Render one flag as a help line, aligned against its widest sibling. */
function flagLines(names: readonly string[], stream: { write(text: string): unknown }): void {
  const width = Math.max(...names.map((n) => FLAG_SPELLING[n]!.length))
  for (const name of names) {
    stream.write(`  ${FLAG_SPELLING[name]!.padEnd(width)}  ${FLAGS[name]}\n`)
  }
}

function usage(stream: { write(text: string): unknown } = process.stderr): void {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length))
  stream.write('\nUsage: gas-app <command> [env] [options]\n\nCommands:\n')
  for (const [name, spec] of Object.entries(COMMANDS)) {
    stream.write(`  ${name.padEnd(width)}  ${spec.summary}\n`)
  }
  stream.write('\nSubcommands:\n')
  stream.write(`  ${ENVS_ADD.usage.padEnd(width + 2)}  ${ENVS_ADD.summary}\n`)
  stream.write('\nOptions:\n')
  flagLines(Object.keys(FLAGS), stream)
  stream.write('\nRun "gas-app <command> --help" for one command on its own.\n')
  stream.write('\nExit codes: 0 success · 1 failure · 2 usage error\n\n')
}

/**
 * One command's own help.
 *
 * The global block lists eleven options of which `versions` accepts two, so the
 * signal-to-noise at the point of use was poor — and `--help` on a subcommand
 * printing the global page is the one CLI convention nearly everything else
 * follows. `spec.flags` is the same list the stray-flag check reads, so a flag
 * this omits is a flag the command refuses.
 */
function commandUsage(spec: CommandSpec, stream: { write(text: string): unknown } = process.stdout): void {
  stream.write(`\nUsage: gas-app ${spec.usage} [options]\n\n  ${spec.summary}\n`)
  if (spec.notes?.length) {
    stream.write('\n')
    for (const note of spec.notes) stream.write(`  ${note}\n`)
  }
  stream.write('\nOptions:\n')
  flagLines([...spec.flags, ...GLOBAL_FLAGS], stream)
  stream.write('\nExit codes: 0 success · 1 failure · 2 usage error\n\n')
}

/**
 * Read from package.json at runtime rather than importing it: the file sits
 * outside `rootDir`, and resolving it relatively works identically from source
 * (src/cli.ts) and from the published build (dist/cli.js).
 */
function packageVersion(): string {
  const require = createRequire(import.meta.url)
  return (require('../package.json') as { version: string }).version
}

/** Kept as its own function so the flag types stay inferred from OPTIONS rather than hand-written. */
function parse(args: string[]) {
  return parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true })
}

function main(argv: string[]): number {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(argv)
  } catch (err) {
    // Node appends advice about placing positional arguments last, which is
    // about parseArgs and not about this CLI. The first sentence names the flag,
    // which is the whole useful part.
    const [named] = (err as Error).message.split('. ')
    process.stderr.write(`${named}. Run "gas-app --help" for the flags each command takes.\n`)
    return EXIT_USAGE
  }
  const { values, positionals } = parsed

  const [command, envName] = positionals

  // `--version` is the boolean "print the package version", so next to a command
  // it silently swallows the command and its argument: `deploy dev --version 1.2.3`
  // printed a version number and exited 0 without deploying.
  if (values.version) {
    if (command) {
      process.stderr.write(
        '--version prints the gas-app-kit version and takes no value. To label a deployment, use:\n' +
          `  gas-app deploy ${envName ?? '<env>'} --description "1.2.3"\n`
      )
      return EXIT_USAGE
    }
    console.log(packageVersion())
    return EXIT_OK
  }

  // An explicit --help is what was asked for: stdout, exit 0, with or without a
  // command. Only the empty invocation is a usage error.
  if (values.help) {
    if (command === 'envs' && envName === 'add') commandUsage(ENVS_ADD)
    else if (command !== undefined && Object.hasOwn(COMMANDS, command)) commandUsage(COMMANDS[command]!)
    else usage(process.stdout)
    return EXIT_OK
  }
  if (!command) {
    usage()
    return EXIT_USAGE
  }

  if (!Object.hasOwn(COMMANDS, command)) {
    process.stderr.write(
      `Unknown command "${command}". Valid commands: ${Object.keys(COMMANDS).join(', ')}\n`
    )
    usage()
    return EXIT_USAGE
  }

  // `strict: true` rejects a flag nobody declared; it says nothing about a real
  // flag aimed at a command that ignores it. `push --yes` looked like consent
  // and was discarded, which is worse than an error.
  // `envs` covers its own flags plus `envs add`'s: they share one command word,
  // and rejecting `--script-id` before the `add` is read would refuse a valid
  // invocation.
  const accepted =
    command === 'envs' ? [...COMMANDS.envs!.flags, ...ENVS_ADD.flags] : COMMANDS[command]!.flags
  const stray = Object.keys(values).filter(
    (flag) => !GLOBAL_FLAGS.includes(flag as (typeof GLOBAL_FLAGS)[number]) && !accepted.includes(flag)
  )
  if (stray.length) {
    process.stderr.write(
      `"${command}" does not take ${stray.map((f) => `--${f}`).join(', ')}. ` +
        'Run "gas-app --help" for the flags each command takes.\n'
    )
    return EXIT_USAGE
  }

  const context = { envsPath: values.envs }
  const json = values.json === true

  if (command === 'envs') {
    // `envs add <name>` is the one nested form. Everything else under `envs`
    // is the listing, so an unexpected word here is a usage error rather than
    // something silently treated as a flag-less listing.
    if (envName === 'add') {
      const name = positionals[2]
      if (!name) {
        process.stderr.write('Usage: gas-app envs add <name> [--script-id <id>] [--title <t>] [--type <t>] [--force]\n')
        return EXIT_USAGE
      }
      const result = addEnv(name, {
        ...context,
        scriptId: values['script-id'],
        title: values.title,
        type: values.type,
        force: values.force,
      })
      const ui = createUI('gas-app envs add')
      ui.item(
        `${result.created ? 'created' : 'registered'} "${name}" → ${result.entry.scriptId}`
      )
      ui.info(`editor: ${editorUrl(result.entry.scriptId)}`)
      // The env this just created is refused by the first deploy command the
      // README shows, and nothing said so. Everything between here and a working
      // push is also unlisted, so name the two prerequisites.
      ui.info(`next: gas-app push ${name} — needs a "build" script and an appsscript.json at the project root`)
      ui.info(
        `deploying "${name}" from this machine is refused until you set "allowLocalDeploy": true for it in envs.json`
      )
      if (result.deploymentCleared) {
        ui.warn(
          `the scriptId changed, so the recorded deploymentId was dropped — it pointed at the previous script. ` +
            `"gas-app deploy ${name}" will create a new deployment.`
        )
      }
      return EXIT_OK
    }
    if (envName) {
      // The old suggestion was "envs add <whatever they typed>", which provisions
      // a real Apps Script project in the user's Drive. "envs list" is among the
      // first things anyone guesses, and a "did you mean" is taken on trust — so
      // offer both, and say what the creating one actually does.
      process.stderr.write(
        `"envs" takes no argument — it lists every environment. Did you mean:\n` +
          `  gas-app envs\n` +
          `      list every registered environment\n` +
          `  gas-app envs add ${envName}\n` +
          `      create a new Apps Script project named "${envName}" in your Drive, and register it\n`
      )
      return EXIT_USAGE
    }
    return envsCommand({ ...context, json })
  }

  if (command === 'doctor') {
    return doctorCommand({ ...context, json })
  }

  if (command === 'push') {
    push(envName, {
      ...context,
      skipChecks: values['skip-checks'],
      noBuild: values['no-build'],
      dryRun: values['dry-run'],
    })
    return EXIT_OK
  }

  if (command === 'deploy') {
    const result = deploy(envName, {
      ...context,
      skipChecks: values['skip-checks'],
      noBuild: values['no-build'],
      dryRun: values['dry-run'],
      description: values.description,
      yes: values.yes,
    })
    // A declined confirmation changed nothing, so it exits 0 like a success —
    // `exit 1` here would read as a CI failure when nothing went wrong.
    void result.declined
    return EXIT_OK
  }

  if (command === 'versions') {
    const result = listVersions(envName, context)
    if (json) {
      // `total` before truncation, so a shortened list never reads as complete,
      // and `current: null` with `currentIsHead` distinguishes "serving HEAD"
      // from "could not tell".
      console.log(
        JSON.stringify(
          {
            env: result.entry.name,
            current: result.current?.versionNumber ?? null,
            currentIsHead: result.currentIsHead,
            total: result.total,
            versions: result.versions,
          },
          null,
          2
        )
      )
      return EXIT_OK
    }
    for (const line of formatVersions(result)) console.log(line)
    if (result.versions.length === 0) {
      createUI('gas-app versions').info(`"${result.entry.name}" has no versioned deployments yet`)
    }
    return EXIT_OK
  }

  if (command === 'rollback') {
    // The version is positional and optional: omitting it lists candidates and
    // refuses, rather than choosing one for you.
    const raw = positionals[2]
    if (raw !== undefined && !/^\d+$/.test(raw)) {
      process.stderr.write(`Version must be a number, got "${raw}". Run "gas-app versions ${envName ?? '<env>'}" to see the candidates.\n`)
      return EXIT_USAGE
    }
    rollback(envName, raw === undefined ? undefined : Number(raw), { ...context, yes: values.yes })
    return EXIT_OK
  }

  if (command === 'build') {
    const registry = loadEnvs(context)
    const entry = resolveEnv(registry, envName)
    const { target, stampPath } = runBuild(entry.name, { cwd: process.cwd() })
    createUI('gas-app build').item(
      `built for "${entry.name}" via ${target.packageManager} run ${target.script} → stamped ${path.relative(process.cwd(), stampPath)}`
    )
    return EXIT_OK
  }

  return openCommand(envName, context)
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (err) {
  const errno = err as NodeJS.ErrnoException
  if (err instanceof EnvsError) {
    createUI('gas-app').error(err.message)
    process.exitCode = EXIT_FAIL
  } else if (errno.code !== undefined && errno.syscall !== undefined) {
    // A read-only checkout, an unwritable --envs path or a full disk reached the
    // user as a raw Node stack trace. It is still a refusal, so it exits like
    // one. What was or was not written is deliberately not claimed here.
    createUI('gas-app').error(
      `${errno.code}: ${errno.syscall} failed${errno.path ? ` on ${errno.path}` : ''}. Check the path and its permissions.`
    )
    process.exitCode = EXIT_FAIL
  } else {
    throw err
  }
}
