# Cue: resolve the data directory without Electron

First step of running Cue pipelines with the desktop app closed. The plan for
that effort asks the runner to locate Maestro's data directory "without the
desktop framework providing the path, and doing it identically to the app so
both agree on where state lives". This change does that piece and nothing else.

## What changed

`cue-db.ts` and `pipeline-layout-store.ts` each called
`app.getPath('userData')`, which is the engine's only hard Electron dependency
at runtime. Both now call `resolveUserDataDir()`
(`src/shared/userDataDir.ts`), which mirrors the app's own rule:

1. `MAESTRO_USER_DATA` wins. The app publishes its resolved path into the
   environment at startup (`src/main/index.ts`), so in-app behavior is
   unchanged by construction, including demo mode and the dev redirect.
2. Otherwise the platform default plus the app name - and the name is not
   constant: Electron uses `package.json` `name` (`maestro`) unpackaged and
   `build.productName` (`Maestro`) once packaged.
3. Development adds the app's sibling hop to `maestro-dev`, unless
   `USE_PROD_DATA` is set.

## Why the app name matters

The repo already had three fallbacks and they disagree:

| Implementation                       | Fallback name | Correct for   |
| ------------------------------------ | ------------- | ------------- |
| `src/cli/services/storage.ts`        | `Maestro`     | Installed app |
| `src/shared/cli-server-discovery.ts` | `maestro`     | Dev run       |
| `src/shared/cli-activity.ts`         | `maestro`     | Dev run       |

They agree in practice only because the running app publishes
`MAESTRO_USER_DATA` and all three prefer it. A process that starts with no app
running - exactly the standalone runner this is building toward - falls through
to the fallback, and then the spelling decides which database it opens. This
change adds the resolver that knows the difference; adopting it in those three
call sites changes how the app and CLI find each other, so it belongs in its
own change rather than here.

A process with no Electron cannot tell those two spellings apart, so it assumes
the installed one. `assertUserDataDirExists(dir)` exists for the standalone
runner to call before opening anything: an absent directory means the guess was
wrong, and creating it would put an empty database beside the real one. The
error names the candidates it can see and points at `MAESTRO_USER_DATA`.

The mismatch only bites on a case-sensitive filesystem - Linux, where a
headless runner lives. macOS folds `Maestro` and `maestro` into one directory.

## Verification

- `src/__tests__/shared/userDataDir.test.ts` pins each branch: the env
  override, packaged, unpackaged, the dev hop, `USE_PROD_DATA`, and the Windows
  and Linux roots.
- `src/__tests__/main/cue/cue-electron-imports.test.ts` is a ratchet: it lists
  the files under `src/main/cue/` that still import Electron and fails if a new
  one appears, and asserts these two resolve their directory without
  `app.getPath`. The list may shrink, never grow.
- The main and shared suites pass (14918 tests).
- `pipeline-layout-store.test.ts` stubbed `app.getPath` through an `electron`
  module mock. It now points `MAESTRO_USER_DATA` at its scratch directory,
  which is what the store actually reads.

## Not in this stage

- The remaining Electron importers under `src/main/cue/`: the notification
  bridge and executor, the auth-prompt detector (type-only today), and the
  backup manager. Those need ports rather than a path helper, and they are the
  next step.
- Adopting the resolver in the CLI, discovery and activity modules.
- Everything else in the standalone runner: startup, CLI control verbs, and the
  cross-process lock.
