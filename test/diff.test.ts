import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { diffEnv } from '../src/commands/diff.ts'

const ENVS = { dev: { scriptId: 'script-1', deploymentId: 'AKfy1', allowLocalDeploy: true } }

/** A consumer whose build/ holds what a push would upload. */
function workspace(build: Record<string, string>) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-diff-ws-'))
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'c', private: true }))
  fs.writeFileSync(path.join(cwd, 'envs.json'), JSON.stringify(ENVS))
  fs.mkdirSync(path.join(cwd, 'build'))
  for (const [name, body] of Object.entries(build)) {
    fs.writeFileSync(path.join(cwd, 'build', name), body)
  }
  return cwd
}

/**
 * A clasp stand-in whose `pull` writes `remote` into the rootDir named by the
 * --project config, which is what the real one does.
 */
function withFakeClasp<T>(remote: Record<string, string>, run: () => T): T {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-diffbin-'))
  fs.writeFileSync(
    path.join(bin, 'clasp'),
    `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args[0] !== 'pull') process.exit(0)
const config = JSON.parse(fs.readFileSync(args[args.indexOf('--project') + 1], 'utf-8'))
const remote = ${JSON.stringify(remote)}
for (const [name, body] of Object.entries(remote)) {
  fs.writeFileSync(path.join(config.rootDir, name), body)
}
process.exit(0)
`,
    { mode: 0o755 }
  )
  const previous = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${previous}`
  try {
    return run()
  } finally {
    process.env.PATH = previous
  }
}

const verdict = (result, name) => result.files.find((f) => f.name === name)?.verdict

test('an untouched script reports no drift', () => {
  const cwd = workspace({ 'Code.gs': 'function main() {}\n' })
  const result = withFakeClasp({ 'Code.gs': 'function main() {}\n' }, () => diffEnv('dev', { cwd }))

  assert.equal(result.drifted, false)
  assert.equal(verdict(result, 'Code'), 'same')
})

test('an edit made in the editor is found', () => {
  const cwd = workspace({ 'Code.gs': 'function main() {}\n' })
  const result = withFakeClasp({ 'Code.gs': 'function main() { hotfix() }\n' }, () => diffEnv('dev', { cwd }))

  assert.equal(result.drifted, true)
  assert.equal(verdict(result, 'Code'), 'differs')
})

test('a file added in the editor is found, and named as such', () => {
  const cwd = workspace({ 'Code.gs': 'a\n' })
  const result = withFakeClasp({ 'Code.gs': 'a\n', 'Patch.gs': 'b\n' }, () => diffEnv('dev', { cwd }))

  assert.equal(result.drifted, true)
  assert.equal(verdict(result, 'Patch'), 'only-remote')
})

test('a .gs that comes back as .js is the same file, not drift', () => {
  // Apps Script stores a name and a type, not a filename. Comparing by full
  // filename would report every file as drifted on such a project.
  const cwd = workspace({ 'Code.gs': 'function main() {}\n' })
  const result = withFakeClasp({ 'Code.js': 'function main() {}\n' }, () => diffEnv('dev', { cwd }))

  assert.equal(result.drifted, false)
  assert.equal(verdict(result, 'Code'), 'same')
})

test('trailing whitespace and a missing final newline are not an edit', () => {
  const cwd = workspace({ 'Code.gs': 'function main() {}\n' })
  const result = withFakeClasp({ 'Code.gs': 'function main() {}   ' }, () => diffEnv('dev', { cwd }))

  assert.equal(result.drifted, false)
})

test('a manifest clasp normalised is reported apart, and is not drift', () => {
  // clasp fills in timeZone, runtimeVersion and exceptionLogging on push, which
  // manifest.ts already documents. Counting that as drift would cry wolf on an
  // ordinary project and the command would stop being believed.
  const cwd = workspace({
    'Code.gs': 'a\n',
    'appsscript.json': JSON.stringify({ timeZone: 'Asia/Tokyo' }),
  })
  const result = withFakeClasp(
    { 'Code.gs': 'a\n', 'appsscript.json': JSON.stringify({ timeZone: 'Asia/Tokyo', runtimeVersion: 'V8' }) },
    () => diffEnv('dev', { cwd })
  )

  assert.equal(result.drifted, false, 'the manifest never sets the drift verdict')
  assert.equal(result.manifest, 'differs')
})

test('a manifest differing only in key order or whitespace is the same manifest', () => {
  const cwd = workspace({
    'Code.gs': 'a\n',
    'appsscript.json': '{"timeZone":"Asia/Tokyo","runtimeVersion":"V8"}',
  })
  const result = withFakeClasp(
    { 'Code.gs': 'a\n', 'appsscript.json': '{\n  "timeZone": "Asia/Tokyo",\n  "runtimeVersion": "V8"\n}\n' },
    () => diffEnv('dev', { cwd })
  )
  assert.equal(result.manifest, 'same')
})

test('the build stamp is never part of the comparison', () => {
  const cwd = workspace({ 'Code.gs': 'a\n', '.gas-app-stamp.json': '{"env":"dev"}' })
  const result = withFakeClasp({ 'Code.gs': 'a\n' }, () => diffEnv('dev', { cwd }))

  assert.equal(result.drifted, false)
  assert.equal(result.files.length, 1)
})

test('nothing built is a refusal that names the build command', () => {
  const cwd = workspace({})
  assert.throws(
    () => withFakeClasp({}, () => diffEnv('dev', { cwd })),
    /Run "gas-app build dev" first/
  )
})

test('the working tree is never written to', () => {
  const cwd = workspace({ 'Code.gs': 'local\n' })
  withFakeClasp({ 'Code.gs': 'remote\n' }, () => diffEnv('dev', { cwd }))

  // A pull into rootDir would destroy the very build being compared.
  assert.equal(fs.readFileSync(path.join(cwd, 'build', 'Code.gs'), 'utf-8'), 'local\n')
  assert.deepEqual(fs.readdirSync(path.join(cwd, 'build')), ['Code.gs'])
})
