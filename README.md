# gas-app-kit

Several environments, a policy gate and one-command rollback for Google Apps Script projects.

> **This is not a starter.** It does not scaffold a project, pick a framework or run a dev server —
> reach for [`@google/aside`](https://github.com/google/aside),
> [`create-gas-app`](https://github.com/vazhioli/create-gas-app) or a template for that, and point
> this at the result. gas-app-kit owns the part those stop at: dev / staging / production
> in one registry instead of a single `.clasp.json`, a refusal when the artefact in `build/` was made
> for a different environment, a flag that keeps production writes off laptops, and `rollback` —
> repointing a deployment at an earlier version in one command, without a build and without the Apps
> Script UI.
>
> If you have one script and one environment, you do not need this yet.

## Install

```bash
pnpm add -D gas-app-kit
```

The package is `gas-app-kit`; the binary it installs is `gas-app`. Run it through your package
manager so the name resolves — **`npx gas-app` fetches an unrelated package** of that name:

```bash
pnpm exec gas-app --help            # pnpm
npx -p gas-app-kit gas-app --help   # npm
```

Every `gas-app …` example below assumes that prefix, or an npm script:

```json
{ "scripts": { "deploy:dev": "gas-app deploy dev" } }
```

Requires Node >= 20 and `@google/clasp` **v3** — v2 is refused by name, because `create-script` was
`create` there and the `--json` flag this tool parses every answer from does not exist. `clasp login`
is yours to run: this tool detects that you are not authenticated and says so, but never launches a
browser prompt on your behalf.

## Two ids, and a version model

Apps Script has two identifiers, and this tool keeps both in `envs.json`.

- **scriptId** (`1abc…`) — the project itself. It is in the editor URL:
  `https://script.google.com/home/projects/`**`<scriptId>`**`/edit`
- **deploymentId** (`AKfy…`) — a *pointer* at one version of that project. One script can have
  several. The web-app URL is built from it:
  `https://script.google.com/macros/s/`**`<deploymentId>`**`/exec`

A **version** is an immutable numbered snapshot of the code — `1`, `2`, `3`, not a semver. A
**deployment** is a mutable pointer at one version. So `deploy` creates a version and moves the
pointer; `rollback` only moves the pointer, which is why it never needs to build.

**`@HEAD`** is the special pseudo-deployment that always serves whatever is in the editor right now.
`push` changes what `@HEAD` serves, immediately. That is why `rollback` never targets it, and why
**container-bound** scripts — one attached to a Spreadsheet or Doc, as opposed to a **standalone**
one — change behaviour the moment you push: `onOpen`, menus and triggers run from HEAD, not from the
deployed version.

**`appsscript.json`** is the Apps Script project manifest: runtime, timezone and OAuth scopes. It
lives at your project root and your build copies it into **`rootDir`** — the directory clasp uploads
from, `build/` by convention and `gasApp.buildDir` if you set one.

## The registry

One file, `envs.json`, is the source of truth for which environments exist:

```json
{
  "dev": { "scriptId": "1abc…", "deploymentId": "AKfy…", "allowLocalDeploy": true },
  "staging": { "scriptId": "1def…", "deploymentId": "", "allowPrerelease": true },
  "production": { "scriptId": "1ghi…", "deploymentId": "AKfy…", "allowLocalDeploy": false }
}
```

Key order is display order. **Policy flags fail closed: absent means `false`** — and `envs add`
writes `false`, so a newly registered environment cannot be written to from a laptop until you
turn the flag on yourself, by editing `envs.json`.

| flag | effect |
| --- | --- |
| `allowLocalDeploy` | `false` refuses both `push` and `deploy` outside CI. It **refuses**, it does not fall back to a prompt |
| `allowPrerelease` | whether prerelease versions may target this environment |

`push`, `deploy` and `rollback` regenerate a throwaway `clasp.<env>.json` in the project root on
every run. It is derived from `envs.json` and never read back, so it is not yours to edit or commit.
`gas-app` can also leave an `appsscript.json.clasp` in your build directory (see *the manifest
guard* below). Add both to `.gitignore`:

```gitignore
clasp.*.json
appsscript.json.clasp
```

Set `GAS_APP_ENVS_JSON` to override the file verbatim — useful when script ids should not be
committed. The variable wins and the file is not read, which makes "commit the ids or not" a
one-line policy decision rather than a code change. **While it is set the registry is read-only:**
`envs add` refuses, and a `deploy` that creates a new deployment can only print the new id for you
to put back into the variable's source. Set it in CI, not in your shell profile.

## Commands

```bash
gas-app envs                   # every environment with its state
gas-app envs add dev           # create a new Apps Script project and register it
gas-app envs add dev --script-id 1abc…   # …or register one that already exists
gas-app envs add dev --type sheets       # …or create one bound to a new Spreadsheet/Doc/etc.
gas-app open [env]             # editor and web-app URLs
gas-app build <env>            # run your build with BUILD_ENV set, then stamp the output
gas-app push <env>             # gate → build → verify the stamp → clasp push
gas-app deploy <env>           # push, then create a version and move the deployment pointer
gas-app versions <env>         # what this environment can be rolled back to
gas-app rollback <env> <n>     # repoint at version n — without building anything
```

`gas-app envs` reports one of four states per environment: `unprovisioned` (no scriptId),
`undeployed` (no deploymentId), `@<n>` (serving version n), and `deployed (version unknown)` —
which is what you get whenever clasp is missing or logged out, since the version has to be read
from Google.

`envs add`'s `--type <type>` is passed straight through to `clasp create-script` (`standalone` is
the default; `sheets`, `docs`, `slides`, `forms`, `webapp`, `api` are the others). A bound `sheets`
script lets server code use `SpreadsheetApp.getActiveSpreadsheet()` with no configuration — at the
cost of the HEAD behaviour described above.

Flags belong to commands, and a flag aimed at a command that does not take it is a usage error
rather than something silently ignored:

| flag | commands |
| --- | --- |
| `--envs <path>` | all — point at a registry elsewhere |
| `--script-id`, `--title`, `--type`, `--force` | `envs add` |
| `--skip-checks`, `--no-build` | `push`, `deploy` |
| `--description <text>` | `deploy` — the deployment label, otherwise derived |
| `--yes` | `deploy`, `rollback` |

To stamp a deployment with a version of your own, use `--description`. `--version` is the boolean
"print the gas-app-kit version" and takes no value.

Exit codes: `0` success, `1` failure, `2` usage error. Every refused operation is a non-zero exit —
there is no warn-and-continue path. An environment that is merely *not deployed yet* is a state, not
a refusal: `open` prints what it has and exits `0`.

## Coming from a raw clasp pipeline

If today you run `pnpm build && clasp push` against a `.clasp.json` you swap by hand:

1. Replace `.clasp.json` with `envs.json` — one entry per environment, each with its scriptId.
   `gas-app envs add <name> --script-id <id>` writes them for you; delete `.clasp.json` afterwards.
2. Replace `clasp push` with `gas-app push <env>`, and `clasp create-deployment` with
   `gas-app deploy <env>`. Your own build script stays exactly where it is — gas-app runs it.
3. Add `clasp.*.json` to `.gitignore`.

clasp v3 can already do more of this than v2 could: `-P, --project <file>` selects a config per
invocation, and `clasp redeploy <deploymentId> -V <n>` is a rollback without the Apps Script UI. The
difference is not what is possible — it is which identifiers you have to keep in your head, and what
is checked before the upload:

| | raw clasp v3 | `gas-app` |
| --- | --- | --- |
| environment switching | `-P clasp.dev.json`, per command | one registry, by name |
| rollback | `clasp redeploy AKfy… -V 12` | `rollback dev 12` — no id to remember, candidates listed first |
| which version an env serves | `list-deployments`, matched by eye | `envs` prints `@12 (v1.2.3)` |
| which env the artefact was built for | unchecked | stamped at build, verified before upload |
| wrong-environment push | possible | refused |
| `appsscript.json` rewritten by clasp | lands in your tree | restored, and you are told |
| production writable from a laptop | always | `allowLocalDeploy: false` refuses |

## Coming from @google/aside

ASIDE sets up TypeScript, lint, tests and bundling, and gives you two environments — `dev` and
`prod`, as `.clasp-dev.json` and `.clasp-prod.json`. Keep all of it. The two compose: ASIDE's
`build` is a script in `package.json`, which is exactly what `gas-app build <env>` wraps.

1. Write `envs.json` with one entry per environment — the two you have, and any third you could not
   add before. `gas-app envs add <name> --script-id <id>` takes the ids out of the two clasp files.
2. Replace ASIDE's `deploy` script with `gas-app deploy <env>`. Nothing about the build changes.
3. Add `clasp.*.json` to `.gitignore`, and delete `.clasp-dev.json` / `.clasp-prod.json`.

What you gain is the part ASIDE leaves out: more than two environments, a policy flag that keeps
production writes off laptops, a refusal when the artefact in `build/` was made for a different
environment, and `rollback`.

## What it actually guards

- **The artefact belongs to the environment.** `build` writes a stamp naming the environment it
  built for; `push` refuses if the stamp does not match what you are pushing to. A `pnpm build &&
  clasp push` composition cannot make that guarantee, which is why the build is wrapped rather than
  chained.
- **A push is not harmless.** `clasp push` replaces the script's HEAD code, and container-bound
  triggers and `onOpen` menus run from HEAD rather than from the deployed version — so the behaviour
  changes for everyone who opens that Sheet, immediately, and `rollback` cannot undo it because it
  only moves the deployment pointer. `push` is therefore gated by the same flag as `deploy`.
- **The manifest guard.** `clasp` rewrites `appsscript.json` inside `rootDir`. Under the usual
  `rootDir: build` convention that file is a generated artefact, so a working-tree diff is the wrong
  test — it passes while the real damage (a manifest clasp altered being pushed in that same run)
  still happens. Every clasp call is wrapped and the manifest compared before and after. A
  difference found *before* the call is a refusal: that manifest has not shipped, and a rebuild
  fixes it. A rewrite found *after* it is a warning — clasp v3 normalises the manifest as a matter
  of course — and clasp's version is kept as `<rootDir>/appsscript.json.clasp`, with the exact `cp`
  that adopts it into your source manifest and stops the warning recurring.
- **A confirmation, or an explicit intent — never a prompt inside a wrapper.** `deploy` and
  `rollback` both confirm. With no terminal to ask on they **refuse** and name the command that
  would have worked; `--yes` (or `CI=true`) is how automation states the intent. A prompt that
  silently answers itself in an npm script is not a safety measure.
- **Rollback never builds.** The tree being unbuildable is frequently *why* you are rolling back.
  Nothing in that path imports the build.
- **One version, derived once.** `resolveVersion` resolves explicit → git tag → `package.json` plus
  a marker, in one place. `collectBuildInfo` and the deployment description are two renderings of
  that single result, so a build banner and a deployment label cannot disagree.

## As a library

The functions the CLI uses are importable directly, so your own scripts do not have to shell out:

```js
import { collectBuildInfo, loadEnvs, resolveEnv } from 'gas-app-kit'

// In your build script: call this once and derive every build-identity display
// from the one returned object. Two calls can disagree.
const info = collectBuildInfo({ env: process.env.BUILD_ENV ?? 'dev' })
// → { version, commit, branch, env, builtAt, dirty }

const env = resolveEnv(loadEnvs(), 'production')
console.log(env.scriptId)
```

ESM only. Types are published alongside.

## Optional: `buildWebApp()`

If you are building an Apps Script **web app** and do not already have a build script, this produces
the bundle — client through Vite, server through esbuild, then HTML that inlines both for
`HtmlService` — so the `build` script that `gas-app build <env>` runs can be two lines instead of a
copy of everyone else's `scripts/build.mjs`:

```js
import { buildWebApp } from 'gas-app-kit'
await buildWebApp()
```

It **reads** `src/server/index.ts`, your Vite client entry (`index.html` at the project root, by
Vite's default), and `appsscript.json` at the project root. It **writes** `Code.gs`, `index.html`,
`app.html` and a copy of `appsscript.json` into `build/`.

`appsscript.json` is a required input, not something this creates. A minimal one to start from:

```json
{ "timeZone": "Asia/Tokyo", "runtimeVersion": "V8", "exceptionLogging": "STACKDRIVER" }
```

Add `oauthScopes` to it when your server code needs a Google service.

`vite` and `esbuild` are optional peer dependencies — install them only if you call this function.
Everything else in gas-app-kit works without them, and nothing obliges you to use this: any build
script that writes into `build/` works just as well.

## Status

The registry, clasp safety layer, build wrapper, quality gate, push/deploy and rollback are built
and tested. Still to come: a reusable CI deploy workflow, a runtime endpoint for the deployed build
identity, and build observability.

## License

MIT
