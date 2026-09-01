# gas-app-kit

Environment registry, build orchestration, deployment and rollback for Google Apps Script projects.

The GAS build transforms stay in your repo — this owns everything after them: which environment you
are targeting, whether the artefact was built for it, and how to get back to the previous version
when it wasn't.

> **Status: in development.** Only the environment registry (`envs`, `open`) exists so far.

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
  "dev": { "scriptId": "1abc…", "deploymentId": "AKfy…" },
  "staging": { "scriptId": "1def…", "deploymentId": "", "allowPrerelease": true },
  "production": { "scriptId": "1ghi…", "deploymentId": "AKfy…", "allowLocalDeploy": false }
}
```

Key order is display order. Policy flags fail closed: absent means `false`.

Set `KANBEE_ENVS_JSON` to override the file verbatim — useful when script ids should not be
committed. The variable wins and the file is not read.

## Commands

```bash
gas-app envs              # every environment with its state: unprovisioned / undeployed / @version
gas-app open              # editor and web-app URLs for all environments
gas-app open production   # …for one
```

Global options: `--envs <path>` to point at a registry elsewhere, `-h`, `-v`.

Exit codes: `0` success, `1` failure, `2` usage error. Every refused operation is a non-zero exit —
there is no warn-and-continue path.

## As a library

The functions the CLI uses are importable directly, so your own scripts do not have to shell out:

```js
import { loadEnvs, resolveEnv } from 'gas-app-kit'

const env = resolveEnv(loadEnvs(), 'production')
console.log(env.scriptId)
```

## License

MIT
