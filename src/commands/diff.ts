/**
 * `gas-app diff <env>` — has someone edited this script in the Apps Script editor?
 *
 * The editor is always available and always writable by anyone with access, so
 * "someone fixed it in the UI" is the most common way an Apps Script project
 * diverges from its repository. Nothing here noticed: `envs` still printed the
 * deployment's version, because the pointer had not moved, and the next `push`
 * overwrote the edit with no diff and no warning.
 *
 * This guards the destination the way the stamp guards the artefact's origin.
 * Read-only: it pulls into a temporary directory and never touches the working
 * tree — a pull into `rootDir` would destroy the build it is comparing against.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

import { loadEnvs, resolveEnv, EnvsError, type EnvEntry, type LoadEnvsOptions } from '../envs.ts'
import { assertProvisioned, resolveBuildDir, writeClaspConfig, STAMP_FILE } from '../project.ts'
import { MANIFEST_FILE } from '../manifest.ts'
import { createUI } from '../ui.mjs'

export type FileVerdict = 'same' | 'differs' | 'only-remote' | 'only-local'

export interface DiffEntry {
  /** The file's name without its extension — see `collect`. */
  name: string
  verdict: FileVerdict
}

export interface DiffResult {
  entry: EnvEntry
  files: DiffEntry[]
  /** Reported on its own: clasp normalises the manifest, so a difference here is often benign. */
  manifest: FileVerdict
  drifted: boolean
}

export interface DiffOptions extends LoadEnvsOptions {
  json?: boolean
}

/** Our own stamp, and anything hidden, belong to neither side of the comparison. */
function comparable(file: string): boolean {
  return !file.startsWith('.') && file !== STAMP_FILE && file !== MANIFEST_FILE
}

/**
 * Read a directory as name → contents, keyed **without the extension**.
 *
 * Apps Script stores a name and a type, not a filename: the same server file is
 * `Code.gs` locally and can come back from `clasp pull` as `Code.js`. Comparing
 * by full filename would report every file as drifted on such a project, which
 * would make the command useless rather than wrong-in-a-visible-way.
 */
function collect(dir: string): Map<string, string> {
  const files = new Map<string, string>()
  if (!fs.existsSync(dir)) return files
  for (const file of fs.readdirSync(dir)) {
    if (!comparable(file)) continue
    const full = path.join(dir, file)
    if (!fs.statSync(full).isFile()) continue
    files.set(file.replace(/\.[^.]+$/, ''), fs.readFileSync(full, 'utf-8'))
  }
  return files
}

/** Trailing-whitespace and final-newline differences are not edits anyone made. */
const normalise = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')

/**
 * The manifest, compared as JSON rather than as bytes.
 *
 * clasp normalises it on the way up — filling in timeZone, runtimeVersion and
 * exceptionLogging — which `manifest.ts` already documents. A byte comparison
 * would therefore report drift on an ordinary project, so this parses both and
 * compares the values. It is still reported separately, because even a semantic
 * difference here is usually that normalisation rather than someone's edit.
 */
function compareManifest(localDir: string, remoteDir: string): FileVerdict {
  const read = (dir: string): unknown | undefined => {
    const file = path.join(dir, MANIFEST_FILE)
    if (!fs.existsSync(file)) return undefined
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch {
      return null
    }
  }
  const local = read(localDir)
  const remote = read(remoteDir)
  if (local === undefined && remote === undefined) return 'same'
  if (local === undefined) return 'only-remote'
  if (remote === undefined) return 'only-local'
  return JSON.stringify(local) === JSON.stringify(remote) ? 'same' : 'differs'
}

/**
 * Pull the remote into `into`. Throws a refusal rather than returning a code.
 *
 * The generated config is written to a sibling directory, not to `into`: it
 * would otherwise land beside the pulled files and be read back as a file the
 * remote has and the build does not.
 */
function pullInto(entry: EnvEntry, into: string, configDir: string): void {
  const configPath = writeClaspConfig(entry, { cwd: configDir, buildDir: into })
  const result = spawnSync('clasp', ['pull', '--project', configPath], {
    cwd: into,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code
    throw new EnvsError(
      code === 'ENOENT' ? 'clasp not found on PATH.' : `Could not run clasp pull: ${result.error.message}`
    )
  }
  if (result.status !== 0) {
    const said = (result.stderr || result.stdout || '').trim().split('\n')[0]
    throw new EnvsError(`Could not read "${entry.name}" from Apps Script: ${said || `clasp exited ${result.status}`}`)
  }
}

/** Compare what `push` would upload against what the script actually holds. */
export function diffEnv(name: string | undefined, options: DiffOptions = {}): DiffResult {
  const cwd = options.cwd ?? process.cwd()
  const entry = resolveEnv(loadEnvs({ ...options, cwd }), name)
  assertProvisioned(entry)

  const buildDir = path.resolve(cwd, resolveBuildDir(cwd))
  if (!fs.existsSync(buildDir) || collect(buildDir).size === 0) {
    throw new EnvsError(
      `Nothing in "${path.relative(cwd, buildDir) || buildDir}" to compare against. Run "gas-app build ${entry.name}" first — this compares what a push would upload, not what is in src/.`
    )
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-diff-'))
  const remoteDir = path.join(temp, 'remote')
  const configDir = path.join(temp, 'config')
  fs.mkdirSync(remoteDir)
  fs.mkdirSync(configDir)
  try {
    pullInto(entry, remoteDir, configDir)

    const local = collect(buildDir)
    const remote = collect(remoteDir)
    const files: DiffEntry[] = []

    for (const [fileName, contents] of local) {
      const other = remote.get(fileName)
      if (other === undefined) files.push({ name: fileName, verdict: 'only-local' })
      else if (normalise(contents) !== normalise(other)) files.push({ name: fileName, verdict: 'differs' })
      else files.push({ name: fileName, verdict: 'same' })
    }
    for (const fileName of remote.keys()) {
      if (!local.has(fileName)) files.push({ name: fileName, verdict: 'only-remote' })
    }

    const manifest = compareManifest(buildDir, remoteDir)
    files.sort((a, b) => a.name.localeCompare(b.name))
    return { entry, files, manifest, drifted: files.some((f) => f.verdict !== 'same') }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

const LABEL: Record<FileVerdict, string> = {
  same: 'unchanged',
  differs: 'differs',
  'only-remote': 'only on the remote — added in the editor',
  'only-local': 'only in your build — not pushed yet',
}

export function diffCommand(name: string | undefined, options: DiffOptions = {}): number {
  const result = diffEnv(name, options)

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          env: result.entry.name,
          drifted: result.drifted,
          manifest: result.manifest,
          files: result.files,
        },
        null,
        2
      )
    )
    return result.drifted ? 1 : 0
  }

  const ui = createUI('gas-app diff')
  const changed = result.files.filter((f) => f.verdict !== 'same')

  if (!result.drifted) {
    ui.item(`"${result.entry.name}" matches your build — nothing was edited in the editor`)
  } else {
    ui.warn(`"${result.entry.name}" differs from your build in ${changed.length} file${changed.length === 1 ? '' : 's'}`)
    const width = Math.max(...changed.map((f) => f.name.length))
    for (const file of changed) ui.info(`  ${file.name.padEnd(width)}  ${LABEL[file.verdict]}`)
    ui.info(`"gas-app push ${result.entry.name}" would overwrite what is on the remote`)
  }

  if (result.manifest !== 'same') {
    ui.info(
      `${MANIFEST_FILE} also ${result.manifest === 'differs' ? 'differs' : LABEL[result.manifest]} — clasp normalises the manifest on push, so this is often that rather than an edit`
    )
  }
  return result.drifted ? 1 : 0
}
