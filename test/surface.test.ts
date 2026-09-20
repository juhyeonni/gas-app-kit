import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as main from '../src/index.ts'
import * as internal from '../src/internal.ts'

/**
 * The published surface is a choice, not the contents of src/. These assertions
 * are the thing that keeps it one: re-exporting an internal from the main entry
 * makes it semver, and the whole reason for the split was that it had happened
 * by accident once already.
 */

const CORE = [
  'loadEnvs',
  'saveEnvs',
  'resolveEnv',
  'envState',
  'EnvsError',
  'addEnv',
  'push',
  'deploy',
  'listVersions',
  'rollback',
  'runBuild',
  'resolveBuildCommand',
  'collectBuildInfo',
  'resolveVersion',
  'formatDescription',
  'runDoctor',
  'runGate',
  'claspJson',
  'listDeployments',
  'buildWebApp',
  'editorUrl',
  'webAppUrl',
]

const NOT_PUBLIC = [
  'createUI', // the output format is not API
  'brokenLinks', // a fix for one measured monorepo case, not a feature
  'escapeCssForGas', // buildWebApp is documented as replaceable; its internals are not frozen
  'stripGasSyntax',
  'renderIndexHtml',
  'writeStamp',
  'writeClaspConfig',
  'claspConfigPath', // writes files the README says never to edit or commit
  'withManifest',
  'formatVersions',
  'detectPackageManager',
  'registryPath',
]

test('the main entry exports what the README advertises', () => {
  for (const name of CORE) {
    assert.ok(name in main, `${name} is documented and must stay exported`)
  }
})

test('the main entry does not re-export the internals', () => {
  for (const name of NOT_PUBLIC) {
    assert.ok(!(name in main), `${name} belongs to gas-app-kit/internal, not the main entry`)
  }
})

test('the internals are still reachable, just not promised', () => {
  for (const name of NOT_PUBLIC) {
    assert.ok(name in internal, `${name} must stay reachable — a removal is worse than a move`)
  }
})

test('nothing is exported from both entries', () => {
  const both = Object.keys(main).filter((name) => name in internal)
  assert.deepEqual(both, [], 'one home each, or "is this public?" has two answers')
})
