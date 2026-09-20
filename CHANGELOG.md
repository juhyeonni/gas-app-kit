# Changelog

Notable changes to `gas-app-kit`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Findings from a competitive-landscape and CLI UX review: the tool measured against
`@google/aside`, `ascol` and a raw clasp v3 pipeline, and its own CLI read against
the conventions every other CLI follows.

### Added

- **`gas-app <command> --help`** prints that command on its own: its usage, the flags it takes, and
  the behaviour a flag list cannot convey — which commands confirm, what `rollback` does when the
  version is omitted, what `envs add` creates in your Drive. It printed the global page before,
  which is eleven options of which `versions` accepts two. The help renders from the same list the
  stray-flag check reads, so a flag cannot be accepted by a command whose help omits it. ([#41])
- **`--json` on `envs` and `versions`.** One object to stdout and nothing else, so a pipeline can
  trust that stdout parses or the command failed. A version that could not be read is `null` with a
  `degraded` field saying why — "could not ask" and "no version" are different answers. Refusals
  stay on stderr with the exit codes they had. ([#43])

### Fixed

- **Piping into a reader that stops early no longer ends in a stack trace.** `gas-app --help |
  head -3` failed with an unhandled EPIPE, reproducibly, for a command that did its job. A closed
  reader is not a refusal and no longer exits like one. ([#57])
- **`rollback` says its result may take a moment to be visible.** Google reports the moved pointer
  on a lag, so the next `gas-app envs` could still show the previous version — which under incident
  pressure reads as "the rollback did not work" and invites a second one, which did not take the
  already-there branch either and wrote again. ([#56])

### Fixed

- **`envs.json` keys this tool does not recognise are no longer deleted.** The registry was
  rewritten from four known fields, so an `owner`, a note or a field written by a newer version
  vanished on the next `envs add` or on any `deploy` that recorded a new deployment id. The
  registry is a file the README tells you to hand-edit; what you add to it now survives. This
  also removes a second, byte-identical serializer in `envs-add.ts` — one copy is why both of
  them dropped keys. ([#37])
- **The gate runs the project's package manager instead of `npm`.** The build path detected
  pnpm/yarn/npm and the gate ignored it, so a pnpm project typechecked against a `node_modules`
  layout npm did not create and an environmental failure was reported as a code failure — which
  is what makes `--skip-checks` permanent. `detectPackageManager` now lives in `project.ts` and
  both paths use it. ([#38])
- **An expired clasp session says what to run.** Google's raw OAuth object reached the user —
  `{"error":"invalid_grant","error_description":"reauth related error (invalid_rapt)",…}` — naming
  neither clasp nor `clasp login`. Classified once in the clasp wrapper, so every command gets the
  same sentence, and `envs` now reports that cause instead of a fixed "could not read deployments"
  line. ([#39])
- **`envs.json` is searched from the working directory upward.** Every command failed one
  directory below the project root, which made the tool unusable from inside a monorepo package.
  Load and save resolve the same file, so a run from a subdirectory no longer reads the registry
  above and writes a second one beside itself. ([#40])

### Documentation

- **The clasp comparison no longer claims rollback needs the Apps Script UI.** clasp v3 has
  `redeploy <deploymentId> -V <n>`, and `-P, --project` for per-environment config. The table now
  compares on what actually differs — identifiers you must remember, and what is verified before
  the upload. ([#36])
- **`@google/aside` is named, with a migration path.** It is the multi-environment tool most
  people meet first and the README did not mention it. The two compose: ASIDE's build script is
  what `gas-app build <env>` wraps. ([#42])

## [0.3.0] — 2026-09-20

Closes the 19 findings of a red-team review that read the CLI as someone who had
never used clasp. The theme of almost all of them: a command that ended without
saying what to do next, or one that said something untrue.

### ⚠️ Breaking

- **`deploy` no longer confirms on your behalf when there is no terminal.** It
  treated "stdin is not a TTY" as *yes*, so every npm script, `turbo`, `make`,
  `| tee deploy.log` and IDE task deployed unconfirmed — the opposite of what the
  README promised. Automation must now pass `--yes` or set `CI=true`, which is
  how it states the intent explicitly. ([#9])
- **`push` is gated by `allowLocalDeploy`**, which only `deploy` checked before.
  `clasp push` replaces the script's HEAD code, and container-bound triggers and
  `onOpen` menus run from HEAD rather than from the deployed version — so a push
  changes behaviour immediately and `rollback` cannot undo it. ([#10])
- **`deploy <env> --version 1.2.3` is a usage error** instead of printing the
  package version and exiting 0 without deploying. Use `--description` to label a
  deployment. ([#13])
- **A flag aimed at a command that ignores it is a usage error.** `push --yes`
  and `build --skip-checks` were accepted and silently discarded. ([#17])
- **`open <env>` on an undeployed environment exits 0**, like the argument-less
  form of the same command always has. Not deployed yet is a state, not a
  failure. ([#24])
- **Manifest drift found after a successful push warns instead of exiting 1.**
  Drift found *before* the call is still a refusal. ([#11])
- **clasp v2 is refused by name** during `envs add` preflight, instead of passing
  and then failing deep inside clasp. ([#21])

### Fixed

- `rollback`'s confirmation declined itself before you could type, then exited 0.
  It read fd 0, which `process.stdin.isTTY` has already switched to non-blocking
  mode, so `readSync` threw EAGAIN. The prompt is now one shared implementation
  with `deploy`, which had been fixed for this in 0.1.3 and never carried across.
  ([#8])
- `envs add --force` kept the old `deploymentId` when the scriptId changed,
  leaving an entry whose pointer belonged to the previous script. ([#18])
- `buildWebApp()` died with a raw `ENOENT` out of `copyFileSync` when the project
  had no `appsscript.json` — after three of its four steps had succeeded. ([#12])
- Filesystem failures (a read-only checkout, an unwritable `--envs` path, a full
  disk) reached the user as Node stack traces rather than refusals. ([#22])
- `rollback` ignored `gasApp.buildDir`, leaving the manifest guard watching a
  directory the project may not use. ([#25])

### Changed

- `--help` lists the four flags that were missing and act — `--skip-checks`,
  `--no-build`, `--description`, `--yes` — each with the commands it belongs to.
  A bare `--help` goes to stdout and exits 0. ([#16])
- `envs <anything>` no longer suggests `envs add <anything>` as its only option:
  that command provisions a real Apps Script project in your Drive, and `envs
  list` is a common guess. ([#19])
- `envs add` now prints the editor URL, the next command, and the policy flag
  that would otherwise refuse it. ([#14])
- `push` prints the editor URL, which `deploy` and `rollback` already did.
  ([#25])
- The `deploy` confirmation quotes its label and calls it a new immutable
  version, and says so when no git commit was recorded. ([#25])
- Under `$GAS_APP_ENVS_JSON`, a `deploy` that cannot record a new deployment id
  names the variable rather than telling you to edit a file that is not read.
  ([#23])
- `parseArgs` errors no longer carry Node's own advice about positional
  arguments. ([#25])

### Added

- `deploy` and `rollback` print the deployed web-app URL, so reading it no longer
  needs a second command — which after a rollback, in an incident, is one command
  too many.
- `CHANGELOG.md`, and it ships in the published package.

### Documentation

- The README opens by saying what this is **not**: not a scaffolder, and
  complementary to `create-gas-app` rather than competing with it. ([#15])
- Install shows `pnpm exec gas-app` / `npx -p gas-app-kit gas-app`. Every example
  ran a bare `gas-app`, and `npx gas-app` fetches an unrelated package of that
  name. ([#7])
- scriptId, deploymentId, "version n", `@HEAD`, `rootDir`, `appsscript.json` and
  bound vs standalone are defined, with where to find each id. ([#14])
- The generated `clasp.<env>.json` and `appsscript.json.clasp` files are
  documented, with the `.gitignore` lines. ([#20])
- A migration table for anyone arriving from a raw `clasp push` pipeline. ([#2])
- Expanded npm keywords. ([#3])

## [0.2.0] — 2026-09-06

### Added

- `buildWebApp()` — the Apps Script web-app bundle as a library call: client
  through Vite, server through esbuild, then HTML that inlines both for
  `HtmlService`. `vite` and `esbuild` are optional peer dependencies.

## [0.1.3] — 2026-09-06

### Fixed

- The `deploy` confirmation read `/dev/tty` instead of fd 0, which
  `process.stdin.isTTY` had already made non-blocking.

## [0.1.2] — 2026-09-06

### Added

- `envs add --type` is passed through to `clasp create-script`, so an
  environment can be created bound to a new Spreadsheet, Doc and so on.

## [0.1.1] — 2026-09-01

First published release.

[0.3.0]: https://github.com/juhyeonni/gas-app-kit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/juhyeonni/gas-app-kit/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/juhyeonni/gas-app-kit/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/juhyeonni/gas-app-kit/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/juhyeonni/gas-app-kit/releases/tag/v0.1.1
[#2]: https://github.com/juhyeonni/gas-app-kit/issues/2
[#3]: https://github.com/juhyeonni/gas-app-kit/issues/3
[#7]: https://github.com/juhyeonni/gas-app-kit/issues/7
[#8]: https://github.com/juhyeonni/gas-app-kit/issues/8
[#9]: https://github.com/juhyeonni/gas-app-kit/issues/9
[#10]: https://github.com/juhyeonni/gas-app-kit/issues/10
[#11]: https://github.com/juhyeonni/gas-app-kit/issues/11
[#12]: https://github.com/juhyeonni/gas-app-kit/issues/12
[#13]: https://github.com/juhyeonni/gas-app-kit/issues/13
[#14]: https://github.com/juhyeonni/gas-app-kit/issues/14
[#15]: https://github.com/juhyeonni/gas-app-kit/issues/15
[#16]: https://github.com/juhyeonni/gas-app-kit/issues/16
[#17]: https://github.com/juhyeonni/gas-app-kit/issues/17
[#18]: https://github.com/juhyeonni/gas-app-kit/issues/18
[#19]: https://github.com/juhyeonni/gas-app-kit/issues/19
[#20]: https://github.com/juhyeonni/gas-app-kit/issues/20
[#21]: https://github.com/juhyeonni/gas-app-kit/issues/21
[#22]: https://github.com/juhyeonni/gas-app-kit/issues/22
[#23]: https://github.com/juhyeonni/gas-app-kit/issues/23
[#24]: https://github.com/juhyeonni/gas-app-kit/issues/24
[#25]: https://github.com/juhyeonni/gas-app-kit/issues/25
[#36]: https://github.com/juhyeonni/gas-app-kit/issues/36
[#37]: https://github.com/juhyeonni/gas-app-kit/issues/37
[#38]: https://github.com/juhyeonni/gas-app-kit/issues/38
[#39]: https://github.com/juhyeonni/gas-app-kit/issues/39
[#40]: https://github.com/juhyeonni/gas-app-kit/issues/40
[#42]: https://github.com/juhyeonni/gas-app-kit/issues/42
[#41]: https://github.com/juhyeonni/gas-app-kit/issues/41
[#43]: https://github.com/juhyeonni/gas-app-kit/issues/43
[#56]: https://github.com/juhyeonni/gas-app-kit/issues/56
[#57]: https://github.com/juhyeonni/gas-app-kit/issues/57
