# gas-app-kit

Environment registry, build orchestration, deployment and rollback for Google Apps Script projects.

The GAS build transforms stay in your repo — this owns everything after them: which environment you
are targeting, whether the artefact was actually built for it, and how to get back to the previous
version when it wasn't.

## Install

```bash
pnpm add -D gas-app-kit
```

Requires Node >= 20 and `@google/clasp` v3 on PATH. `clasp login` is yours to run — this tool detects
that you are not authenticated and says so, but never launches a browser prompt on your behalf.

## The registry

One file, `envs.json`, is the source of truth for which environments exist:

```json
{
  "dev": { "scriptId": "1abc…", "deploymentId": "AKfy…", "allowLocalDeploy": true },
  "staging": { "scriptId": "1def…", "deploymentId": "", "allowPrerelease": true },
  "production": { "scriptId": "1ghi…", "deploymentId": "AKfy…", "allowLocalDeploy": false }
}
```

Key order is display order. **Policy flags fail closed: absent means `false`** — a newly registered
environment cannot be deployed from a laptop until you say so in writing.

| flag | effect |
| --- | --- |
| `allowLocalDeploy` | `false` refuses `deploy` outside CI. It **refuses**, it does not fall back to a prompt |
| `allowPrerelease` | whether prerelease versions may target this environment |

Set `GAS_APP_ENVS_JSON` to override the file verbatim — useful when script ids should not be
committed. The variable wins and the file is not read, which makes "commit the ids or not" a one-line
policy decision rather than a code change.

## Commands

```bash
gas-app envs                   # every environment with its state: unprovisioned / undeployed / @version
gas-app envs add dev           # create a new Apps Script project and register it
gas-app envs add dev --script-id 1abc…   # …or register one that already exists
gas-app open [env]             # editor and web-app URLs
gas-app build <env>            # run your build with BUILD_ENV set, then stamp the output
gas-app push <env>             # gate → build → verify the stamp → clasp push
gas-app deploy <env>           # push, then move the deployment pointer
gas-app versions <env>         # what this environment can be rolled back to
gas-app rollback <env> <n>     # repoint at version n — without building anything
```

Global options: `--envs <path>` to point at a registry elsewhere, `-h`, `-v`.
Per-command: `--skip-checks`, `--no-build`, `--description <text>`, `--yes`, `--force`.

Exit codes: `0` success, `1` failure, `2` usage error. Every refused operation is a non-zero exit —
there is no warn-and-continue path.

## What it actually guards

- **The artefact belongs to the environment.** `build` writes a stamp naming the environment it built
  for; `push` refuses if the stamp does not match what you are pushing to. A `pnpm build && clasp
  push` composition cannot make that guarantee, which is why the build is wrapped rather than
  chained.
- **`clasp` rewrites `appsscript.json` inside `rootDir`.** Under the usual `rootDir: build`
  convention that file is a generated artefact, so a working-tree diff is the wrong test — it passes
  while the real damage (a manifest clasp altered being pushed in that same run) still happens. Every
  clasp call is wrapped: the manifest is compared before and after and restored unconditionally.
- **No prompts on any path CI takes.** A prompt inside a wrapper is not a safety measure; it is a
  hang. Refusals are refusals, and `--yes` genuinely bypasses every confirmation, because automated
  recovery is impossible otherwise.
- **Rollback never builds.** The tree being unbuildable is frequently *why* you are rolling back.
  Nothing in that path imports the build.
- **One version, derived once.** `resolveVersion` resolves explicit → git tag → `package.json` plus a
  marker, in one place. `collectBuildInfo` and the deployment description are two renderings of that
  single result, so a build banner and a deployment label cannot disagree.

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

## Status

The registry, clasp safety layer, build wrapper, quality gate, push/deploy and rollback are built and
tested. Still to come: a reusable CI deploy workflow, a runtime endpoint for the deployed build
identity, and build observability.

## License

MIT
