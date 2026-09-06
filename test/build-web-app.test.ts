import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { buildWebApp, stripGasSyntax, escapeJsForGas, escapeCssForGas, renderIndexHtml } from '../src/build-web-app.ts'

test('stripGasSyntax removes an export {...} block', () => {
  const code = 'const a = 1;\nexport { a, b };\n'
  assert.doesNotMatch(stripGasSyntax(code), /export/)
})

test('stripGasSyntax removes a leading export keyword, keeping the declaration', () => {
  const out = stripGasSyntax('export function doGet() {}\n')
  assert.equal(out, 'function doGet() {}\n')
})

test('stripGasSyntax removes import lines', () => {
  const out = stripGasSyntax("import { helper } from './lib.js'\nconst x = 1\n")
  assert.doesNotMatch(out, /^import /m)
  assert.match(out, /const x = 1/)
})

test('stripGasSyntax collapses 3+ blank lines down to one', () => {
  const out = stripGasSyntax('a\n\n\n\n\nb\n')
  assert.equal(out, 'a\n\nb\n')
})

test('escapeJsForGas escapes </script> case-insensitively', () => {
  const out = escapeJsForGas("const s = '</SCRIPT>'")
  assert.doesNotMatch(out, /<\/script>/i)
  assert.match(out, /<\\\/script>/)
})

test('escapeJsForGas escapes :// so no raw scheme separator survives', () => {
  const out = escapeJsForGas("const url = 'https://example.com'")
  assert.doesNotMatch(out, /:\/\//)
  assert.match(out, /:\\u002F\\u002F/)
})

test('escapeCssForGas escapes a closing </style>', () => {
  const out = escapeCssForGas('body::after { content: "</style>" }')
  assert.doesNotMatch(out, /<\/style>/i)
  assert.match(out, /\\3C\/style>/)
})

test('renderIndexHtml wires the include() call and the mount point', () => {
  const html = renderIndexHtml('body { color: red }')
  assert.match(html, /<\?!= include\('app'\) \?>/)
  assert.match(html, /<div id="app">/)
})

/**
 * A minimal but real Vite + esbuild consumer project — no vite.config, so
 * buildWebApp's inline build options are the only ones in effect. Exercises
 * every escaping rule at once: a template literal, a `://` scheme, and a
 * `</script>` inside a string literal, all ending up in the same bundle.
 */
function fixtureProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-app-build-web-app-'))

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }, null, 2))
  fs.writeFileSync(
    path.join(dir, 'appsscript.json'),
    JSON.stringify({ timeZone: 'Etc/UTC', dependencies: {}, exceptionLogging: 'STACKDRIVER' }, null, 2)
  )
  fs.writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html>\n<html>\n<body>\n<script type="module" src="/src/client/main.ts"></script>\n</body>\n</html>\n'
  )

  fs.mkdirSync(path.join(dir, 'src', 'client'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'src', 'client', 'main.ts'),
    [
      "const url = 'https://example.com'",
      "const marker = '</script>'",
      'const greeting = `Hello ${url} ${marker}`',
      'document.body.textContent = greeting',
      '',
    ].join('\n')
  )

  fs.mkdirSync(path.join(dir, 'src', 'server'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'server', 'lib.ts'), "export function helper() {\n  return 'ok'\n}\n")
  fs.writeFileSync(
    path.join(dir, 'src', 'server', 'index.ts'),
    ["import { helper } from './lib.ts'", '', 'export function doGet() {', '  return helper()', '}', '', 'export function rpc() {', '  return helper()', '}', ''].join('\n')
  )

  return dir
}

const tempDirs: string[] = []

test('buildWebApp produces the full bundle from a real vite + esbuild build', async () => {
  const cwd = fixtureProject()
  tempDirs.push(cwd)

  const result = await buildWebApp({ cwd, env: 'test' })

  assert.equal(result.buildDir, path.join(cwd, 'build'))
  assert.ok(fs.existsSync(path.join(cwd, 'build', 'Code.gs')))
  assert.ok(fs.existsSync(path.join(cwd, 'build', 'index.html')))
  assert.ok(fs.existsSync(path.join(cwd, 'build', 'app.html')))
  assert.ok(fs.existsSync(path.join(cwd, 'build', 'appsscript.json')))

  const codeGs = fs.readFileSync(path.join(cwd, 'build', 'Code.gs'), 'utf-8')
  assert.match(codeGs, /function doGet/)
  assert.match(codeGs, /function rpc/)
  assert.match(codeGs, /env {5}: test/)
  assert.doesNotMatch(codeGs, /^import /m)
  assert.doesNotMatch(codeGs, /^export /m)

  const appHtml = fs.readFileSync(path.join(cwd, 'build', 'app.html'), 'utf-8')
  assert.ok(appHtml.startsWith('<script>'))
  assert.ok(!appHtml.includes('`'), 'no backtick survives the client bundle')
  assert.ok(!appHtml.includes('://'), 'no raw scheme separator survives')
  assert.equal(appHtml.split('</script>').length - 1, 1, 'exactly one real closing tag')
  assert.ok(appHtml.endsWith('</script>'), 'the only closing tag is the final one')

  const indexHtml = fs.readFileSync(path.join(cwd, 'build', 'index.html'), 'utf-8')
  assert.match(indexHtml, /<\?!= include\('app'\) \?>/)
})

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})
