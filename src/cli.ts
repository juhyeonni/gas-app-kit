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
import { addEnv } from './envs-add.ts'
import { runBuild } from './build.ts'
import { push, deploy } from './deploy.ts'
import { listVersions, formatVersions, rollback } from './rollback.ts'
import { createUI } from './ui.mjs'

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2

const COMMANDS: Record<string, string> = {
  envs: 'list registered environments and their state',
  open: 'print editor and web-app URLs for an environment',
  build: "run the consumer's build for an environment and stamp the output",
  push: 'gate, build, verify, then push the code to an environment',
  deploy: 'push, then create or update the environment’s deployment',
  versions: 'list the versions an environment can be rolled back to',
  rollback: 'repoint an environment at an earlier version, without rebuilding',
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
  description: { type: 'string' },
  yes: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const

function usage(stream: { write(text: string): unknown } = process.stderr): void {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length))
  stream.write('\nUsage: gas-app <command> [env] [options]\n\nCommands:\n')
  for (const [name, description] of Object.entries(COMMANDS)) {
    stream.write(`  ${name.padEnd(width)}  ${description}\n`)
  }
  stream.write('\nSubcommands:\n')
  stream.write('  envs add <name>   create a project, or register one with --script-id\n')
  stream.write('\nOptions:\n')
  stream.write('  --envs <path>       path to the environment registry (default: ./envs.json)\n')
  stream.write('  --script-id <id>    envs add: register an existing project instead of creating one\n')
  stream.write('  --title <text>      envs add: title for a newly created project (default: the env name)\n')
  stream.write('  --type <type>       envs add: clasp project type (default: standalone)\n')
  stream.write('  --force             envs add: overwrite an existing registry entry\n')
  stream.write('  --skip-checks       push, deploy: skip the typecheck/test gate\n')
  stream.write('  --no-build          push, deploy: push what is already built and stamped\n')
  stream.write('  --description <t>   deploy: label for the deployment (default: derived from version + sha)\n')
  stream.write('  --yes               deploy, rollback: skip the confirmation prompt\n')
  stream.write('  -h, --help          show this message\n')
  stream.write('  -v, --version       print the gas-app-kit version\n')
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
    process.stderr.write(`${(err as Error).message}\n`)
    usage()
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
    usage(process.stdout)
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
  const GLOBAL_FLAGS = ['envs', 'help', 'version']
  const TAKES: Record<string, readonly string[]> = {
    envs: ['script-id', 'title', 'type', 'force'],
    open: [],
    build: [],
    push: ['skip-checks', 'no-build'],
    deploy: ['skip-checks', 'no-build', 'description', 'yes'],
    versions: [],
    rollback: ['yes'],
  }
  const stray = Object.keys(values).filter(
    (flag) => !GLOBAL_FLAGS.includes(flag) && !TAKES[command]!.includes(flag)
  )
  if (stray.length) {
    process.stderr.write(
      `"${command}" does not take ${stray.map((f) => `--${f}`).join(', ')}. ` +
        'Run "gas-app --help" for the flags each command takes.\n'
    )
    return EXIT_USAGE
  }

  const context = { envsPath: values.envs }

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
    return envsCommand(context)
  }

  if (command === 'push') {
    push(envName, { ...context, skipChecks: values['skip-checks'], noBuild: values['no-build'] })
    return EXIT_OK
  }

  if (command === 'deploy') {
    const result = deploy(envName, {
      ...context,
      skipChecks: values['skip-checks'],
      noBuild: values['no-build'],
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
