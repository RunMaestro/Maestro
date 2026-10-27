# Codex profile steering: blocked by the app-server contract

Status on 2026-10-27: **diagnosis and fallback regression coverage only; profile support is not implemented**.

## Checkout and scope

The working checkout was on `feat/lite-lan-connections` with unrelated local changes and an older invocation parser. Investigation and tests use a separate Maestro-registered worktree on `fix/codex-app-server-profiles-rc-20261027`, based on upstream `rc` `d85a68e42cb6255129809faa15611a89470b9a7b`. The upstream `rc` ref and existing open PRs were checked. No existing focused profile fix was found; open native harness-control PR [#1931](https://github.com/RunMaestro/Maestro/pull/1931) is a separate opt-in transport and does not change the installed Codex CLI contract.

No production behavior, provider profile, global configuration, hook, CI policy, package, or running application is changed by this diagnostic patch.

## Executed installed fallback

The installed `/opt/Maestro/resources/app.asar` exports `parseCodexExecArgs`, unlike the older primary checkout. Loading its actual invocation module in a Node VM and supplying only synthetic arguments produced:

```json
{ "wantsAppServer": true, "parsed": { "ok": false, "reason": "unsupported argument: --profile" } }
```

An assertion that this profile-bearing invocation remains on app-server fails. The real installed `CodexAppServerSpawner.spawn()` was then executed in a VM with unrelated imports stubbed and a fallback spy. It calls `fallbackToCli` exactly once with the identical config object, before spawning any OS child. This is an executable fallback proof, not just a parser hypothesis.

The installed control flow is:

```text
ProcessManager.shouldUseCodexAppServer -> CodexAppServerSpawner.spawn
  parseCodexAppServerInvocation -> unsupported argument: --profile
  fallbackToCli(originalConfig) -> ChildProcessSpawner.spawn -> codex exec
steer without process.codexAppServer -> socket steering client
  missing socket -> "no steering channel is open for it"
```

Relevant installed files: `dist/main/process-manager/ProcessManager.js` (fallback callback and steering routing), `dist/main/process-manager/spawners/CodexAppServerSpawner.js` (`spawn`), and `dist/main/process-manager/steering-client.js` (missing-channel result).

No persisted log for the reported October 27 turn was available in the local log directory. The historical turn's exact start was not observed; the installed fallback path is reproduced independently. Existing turns and queue order were not touched.

## Native Codex contract

The installed binary reports `codex-cli 0.164.0`. Its source explicitly excludes app-server from root `--profile` support, and the AppServer command passes `LoaderOverrides::default()`.

A fresh temporary `CODEX_HOME` contained only a synthetic base config, `cli_auth_credentials_store = "file"`, and `synthetic-manager.config.toml`. Child processes inherited only `PATH` and that test `CODEX_HOME`. No real profile, auth file, secret environment value, or MCP configuration was read. No model or MCP action was requested. These probes all completed in under one second together:

| Synthetic invocation                                                                                           | Observed result                                                                         |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `codex --profile synthetic-manager app-server --print-startup-config`                                          | Exit 1: root profile whitelist excludes app-server                                      |
| Same with `-p synthetic-manager`, `--profile=synthetic-manager`, `-p=synthetic-manager`, `-psynthetic-manager` | Same rejection                                                                          |
| `codex app-server --profile synthetic-manager --print-startup-config`                                          | Exit 2: unexpected argument `--profile`                                                 |
| `codex app-server -c 'profile="synthetic-manager"' --print-startup-config`                                     | Exit 1: legacy profile selector no longer supported                                     |
| `codex app-server --listen stdio:// -c 'model="synthetic-cli"'`                                                | `initialize` and `config/read` succeed, effective model is `synthetic-cli`, EOF exits 0 |

A separate base-only stdio probe returned `synthetic-base`. Thus the stdio start channel and ordinary `-c` override work; profile selection is the blocker. All synthetic config files were removed after the probes.

Since Codex 0.134.0, `--profile name` loads a separate `<name>.config.toml` layer. The ordering is base user config < profile file < project config < CLI/runtime overrides. Converting profile contents into `-c` overrides would move them to a different priority and could change relative-path resolution. `-c profile=...` is obsolete, and `-c config_profile=...` is an unrecognized key, not a profile selector. Neither is a valid fix.

`ThreadStartParams` and config RPC inputs expose no config-profile selector or `LoaderOverrides`. The similarly named permission profile is a different feature. The alternate user-config environment input in the app-server source is debug-only and ignored by release builds.

Sources pinned to the installed version:

- [Official profile semantics and the 0.134.0 change](https://learn.chatgpt.com/docs/config-file/config-advanced#profiles)
- [Codex 0.164.0 CLI: AppServer dispatch and profile whitelist](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/cli/src/main.rs)
- [Native configuration loader and layer ordering](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/config/src/loader/mod.rs)
- [App-server startup options](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/startup_config.rs)
- [App-server release/debug user-config behavior](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/lib.rs)
- [Thread start RPC parameters](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
- [Configuration RPC parameters](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/config.rs)

## Reviewable changes and validation

Tests cover profile flag spellings, parser non-mutation, unchanged `-c` ordering/last explicit effort, exact original-config exec fallback without app-server spawn, and SSH fallback without building a launch script. They describe the current safe boundary and must be replaced with native forwarding assertions when Codex supplies a supported profile entry point.

Targeted command:

```bash
node_modules/.bin/vitest run src/__tests__/main/codex-app-server/invocation.test.ts src/__tests__/main/codex-app-server/ssh-launch.test.ts src/__tests__/main/process-manager/CodexAppServerSpawner.test.ts
```

Final validation: **75 tests passed in three files**; targeted ESLint (`--no-ignore`), Prettier, `git diff --check`, and the main TypeScript project (`tsc -p tsconfig.main.json --noEmit`) passed. The first typecheck used the older primary checkout dependency tree and failed on missing vendor dependencies; reusing the already installed RC dependency tree resolved that without installing packages.

The spawner suite also replays existing recorded steering traffic. This is synthetic protocol coverage; it is not live steering with a real selected profile. No full local suite, build, installation, or restart was run.

## Required continuation

A functional Maestro fix needs a supported Codex app-server profile entry point that applies the native profile loader before setup, including MCP configuration. Once that contract exists, extend the existing invocation parser and both local and SSH launch arguments; preserve explicit override ordering and all existing fallback boundaries. Test malformed/duplicate selectors as Codex itself handles them. Do not accept and discard a selector or read/copy profile secrets into generated command lines.

After Chris reviews/merges an eventual functional fix and separately authorizes an updated installation, the remaining live gate is a fresh Mira turn using the existing selected profile: confirm an actual app-server child, send a harmless steering message during the active turn, observe delivered/absorbed, and verify the same turn incorporates it. No calendar or mail action is needed. Do not interrupt an existing turn to run this check.
