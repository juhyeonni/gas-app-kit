import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { claspJson, AUTH_REASON } from '../src/clasp.ts'

/** The blob clasp v3 actually forwards when the session needs reauth. */
const REAUTH_BLOB = JSON.stringify({
  error: 'invalid_grant',
  error_description: 'reauth related error (invalid_rapt)',
  error_uri: 'https://support.google.com/a/answer/9368756',
  error_subtype: 'invalid_rapt',
})

/** A fake clasp that fails the way the real one does. `mode` picks how. */
function fakeClasp(mode: string, { status = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-clasp-'))
  const bin = path.join(dir, 'fakebin')
  fs.mkdirSync(bin)
  fs.writeFileSync(
    path.join(bin, 'clasp'),
    `#!/usr/bin/env node
const mode = ${JSON.stringify(mode)}
if (mode === 'reauth') process.stderr.write(${JSON.stringify(REAUTH_BLOB)} + '\\n')
if (mode === 'wrapped') process.stderr.write('Could not read deployments.\\n' + ${JSON.stringify(REAUTH_BLOB)} + '\\n')
if (mode === 'other') process.stderr.write('ANYONE access has been disabled by your domain administrator.\\n')
process.exit(${status})
`,
    { mode: 0o755 }
  )
  return dir
}

function withFakeClasp<T>(dir: string, fn: () => T): T {
  const previous = process.env.PATH
  process.env.PATH = `${path.join(dir, 'fakebin')}:${previous ?? ''}`
  try {
    return fn()
  } finally {
    process.env.PATH = previous
  }
}

test('an expired session is named, not forwarded as a raw OAuth blob', () => {
  const result = withFakeClasp(fakeClasp('reauth'), () => claspJson(['list-versions', 'S']))
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, AUTH_REASON)
})

test('the blob is recognised even when it is not the first line', () => {
  const result = withFakeClasp(fakeClasp('wrapped'), () => claspJson(['list-deployments', 'S']))
  assert.equal(result.ok === false && result.reason, AUTH_REASON)
})

test('an auth failure that exits 0 with no JSON is classified too', () => {
  // clasp v3 fails while exiting 0 often enough that the not-JSON path needs
  // the same treatment as the non-zero one.
  const result = withFakeClasp(fakeClasp('reauth', { status: 0 }), () => claspJson(['list-versions', 'S']))
  assert.equal(result.ok === false && result.reason, AUTH_REASON)
})

test('a failure that is not about auth is still forwarded verbatim', () => {
  const result = withFakeClasp(fakeClasp('other'), () => claspJson(['create-deployment']))
  assert.equal(
    result.ok === false && result.reason,
    'ANYONE access has been disabled by your domain administrator.'
  )
})

test('clasp missing from PATH is reported as missing, not as an auth problem', () => {
  const previous = process.env.PATH
  process.env.PATH = path.join(os.tmpdir(), 'gas-app-kit-nothing-here')
  try {
    const result = claspJson(['list-versions', 'S'])
    assert.equal(result.ok === false && result.reason, 'clasp not found on PATH')
  } finally {
    process.env.PATH = previous
  }
})
