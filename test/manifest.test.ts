import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { withManifest, ManifestDriftError, MANIFEST_FILE } from '../src/manifest.ts'

const MANIFEST = JSON.stringify({ timeZone: 'Asia/Tokyo', oauthScopes: ['a', 'b'] }, null, 2)

function workspace({ artefact = true }: { artefact?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-manifest-'))
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), MANIFEST)
  fs.mkdirSync(path.join(dir, 'build'))
  if (artefact) fs.writeFileSync(path.join(dir, 'build', MANIFEST_FILE), MANIFEST)
  return dir
}

const artefactOf = (cwd: string): string => path.join(cwd, 'build', MANIFEST_FILE)

test('returns the callback result unchanged when nothing touches the manifest', () => {
  const cwd = workspace()
  const result = withManifest(() => 'pushed 12 files', { cwd })
  assert.equal(result, 'pushed 12 files')
})

test('an untouched manifest is not rewritten — mtime is preserved', () => {
  const cwd = workspace()
  const before = fs.statSync(artefactOf(cwd)).mtimeMs
  // Push mtime into the past so an unconditional write would be visible.
  const past = new Date(Date.now() - 60_000)
  fs.utimesSync(artefactOf(cwd), past, past)
  const stale = fs.statSync(artefactOf(cwd)).mtimeMs
  assert.notEqual(stale, before)

  withManifest(() => undefined, { cwd })

  assert.equal(fs.statSync(artefactOf(cwd)).mtimeMs, stale)
})

test('a manifest clasp altered is restored and the run is refused', () => {
  const cwd = workspace()
  assert.throws(
    () =>
      withManifest(
        () => {
          fs.writeFileSync(artefactOf(cwd), JSON.stringify({ timeZone: 'Asia/Tokyo' }))
          return 'ok'
        },
        { cwd }
      ),
    (err: Error) => err instanceof ManifestDriftError && err.message.includes('already reached Apps Script')
  )
  assert.equal(fs.readFileSync(artefactOf(cwd), 'utf-8'), MANIFEST, 'restored byte-identical')
})

test('restoration happens on the failure path too, and the original error wins', () => {
  const cwd = workspace()
  assert.throws(
    () =>
      withManifest(
        () => {
          fs.writeFileSync(artefactOf(cwd), '{"stripped":true}')
          throw new Error('clasp push failed: quota exceeded')
        },
        { cwd }
      ),
    // The clasp failure is what the developer needs; drift must not bury it.
    (err: Error) => err.message === 'clasp push failed: quota exceeded'
  )
  assert.equal(fs.readFileSync(artefactOf(cwd), 'utf-8'), MANIFEST, 'restored despite the throw')
})

test('a deleted artefact is restored as well', () => {
  const cwd = workspace()
  assert.throws(() =>
    withManifest(
      () => {
        fs.rmSync(artefactOf(cwd))
      },
      { cwd }
    )
  )
  assert.equal(fs.readFileSync(artefactOf(cwd), 'utf-8'), MANIFEST)
})

test('no manifest in buildDir makes the guard a transparent wrapper', () => {
  const cwd = workspace({ artefact: false })
  assert.equal(withManifest(() => 42, { cwd }), 42)
})

test('an artefact that already differs from the source is refused before clasp runs', () => {
  const cwd = workspace()
  fs.writeFileSync(artefactOf(cwd), JSON.stringify({ timeZone: 'UTC' }))

  let ran = false
  assert.throws(
    () =>
      withManifest(
        () => {
          ran = true
        },
        { cwd }
      ),
    (err: Error) => err instanceof ManifestDriftError && err.message.includes('before clasp ran')
  )
  assert.equal(ran, false, 'the callback must not run')
})
