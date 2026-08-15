---
type: architecture
title: Provider Auth Design
created: 2026-08-15
tags:
  - auth
  - providers
  - architecture
related:
  - '[[survey]]'
  - '[[provider-auth]]'
---

# Provider Auth Design

The internal model behind the Provider Auth Recovery feature. The ground truth this is built on - CLI
surfaces, exit codes, existing precedent in the quota code - is in [[survey]]; the user-facing
documentation is [[provider-auth]]. This doc covers the model itself: what a credential identity is,
what the probe is allowed to conclude, and the invariants every consumer has to honor.

## 1. The problem the model solves

Auth failure was discovered only after a prompt had been spent. An agent spawned, the CLI complained,
`parsers/error-patterns.ts` matched an `auth_expired` regex, and a modal appeared. Fifteen agents on
one Anthropic account produced fifteen of those modals for one underlying fact, and the recovery
action they offered (`agentStore.authenticateAfterError()`) cleared the error and switched to
terminal mode without running a login command.

Both halves of that are the same bug: **login state was tracked against the agent, and it belongs to
the credential.** Everything below follows from moving it.

## 2. Credential identity

`src/shared/providerAuth.ts` maps a session onto the credential it will present.

```
key = `${provider}::${kind}::${scope}::${host}`
```

| Segment    | What it is                                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider` | Agent id (`claude-code`, `codex`, `opencode`, `copilot-cli`, ...).                                                                              |
| `kind`     | Which remedy applies. See the table below.                                                                                                      |
| `scope`    | What distinguishes this credential from another of the same kind: a canonical config dir, a gateway host, a secret fingerprint, or `'default'`. |
| `host`     | `'local'` or `` `ssh:${remoteId}` `` - the machine the credential lives on.                                                                     |

Two sessions that produce the same key share one login, so they are probed once, stored once, and
surfaced once. Resolution is pure: same inputs, same key, no disk, no network, no ambient
`process.env`. That purity is what lets main and the renderer both call
`resolveCredentialIdentity()` and agree, which the store depends on - the renderer looks up snapshots
by a key main wrote.

### Kinds

| Kind             | Set by                                                        | Probe? | Login button? |
| ---------------- | ------------------------------------------------------------- | ------ | ------------- |
| `oauth`          | A config directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, ...)   | Yes    | Yes           |
| `api-key`        | A secret env var                                              | No     | No            |
| `gateway`        | `ANTHROPIC_BASE_URL` pointed at a third-party operator        | No     | No            |
| `cloud-provider` | `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX`          | No     | No            |
| `unknown`        | A provider with no verified auth surface (factory-droid, ...) | No     | No            |

Within a provider the checks run most-specific first: cloud provider, then gateway, then secret, then
config dir. A gateway agent that also carries a token is a gateway - the token belongs to the gateway
operator, which is the same rule `failoverUnsetEnvKeys()` in `shared/providerFailover.ts` already
enforces when it strips inherited credentials from a failover endpoint.

Every non-`oauth` kind resolves to `status: 'unsupported'` without spawning anything. `claude auth
status` reports the OAuth state of a config directory, which says nothing about whether an
`ANTHROPIC_AUTH_TOKEN` aimed at a third-party gateway is still valid.

### Scope details worth keeping

- **Config dirs are canonicalized lexically** (`canonicalizeDirPath`): `~` expansion, trailing
  separators, `.` / `..`, Windows backslashes, and a relative path resolved against `homeDir` rather
  than the process cwd. No `realpath`, no symlink resolution, no case folding - deliberately the same
  semantics as `resolveConfigDirKey()` in `main/stores/claudeUsageStore.ts`, so the two account maps
  cannot disagree about what "the same account" means.
- **An empty env var reads as unset** everywhere (`envValue` trims first). `resolveConfigDirKey()`
  uses `??` and therefore resolves `CLAUDE_CONFIG_DIR=''` to the process cwd; this module uses the
  Codex semantics instead. See [[survey]] §5 discrepancy 2.
- **Secrets are fingerprinted, never stored.** `fingerprintSecret()` returns `fp_` plus the first 8
  hex characters of a SHA-256. This is the only representation of a secret allowed out of the module.
- **`mergeEffectiveEnv(agentLevel, sessionLevel)`** is the one implementation of the env-merge
  precedence (session wins). It existed twice before this feature, once on each side of the IPC
  boundary; every consumer here calls the shared one so the two processes cannot drift.

## 3. Probe rules

`src/main/agents/auth/auth-probe.ts` runs one status command per identity with `execFileNoThrow`. No
PTY, no TUI driving, no blind-typing of `/login`.

| Provider        | Command                     | Signal                                                      | Exit code used?                     |
| --------------- | --------------------------- | ----------------------------------------------------------- | ----------------------------------- |
| `claude-code`   | `claude auth status --json` | `loggedIn` plus `apiProvider` from the JSON body            | No (0 and 1 both carry a good body) |
| `codex`         | `codex login status`        | `Not logged in` first, then a line-anchored `Logged in ...` | Yes, for the 0 case                 |
| `opencode`      | `opencode auth list`        | The `N credentials` footer, after ANSI stripping            | Yes, must be 0                      |
| `copilot-cli`   | none                        | -                                                           | -                                   |
| `factory-droid` | none                        | -                                                           | -                                   |

The negative match is tested before the positive one for codex, because `Not logged in` contains the
logged-in phrase as a substring.

Budgets: `DEFAULT_PROBE_TIMEOUT_MS` is 15s locally, `SSH_PROBE_TIMEOUT_MS` is 60s over SSH. A remote
probe pays for TCP setup, the SSH handshake, agent round trips, and a login shell before the status
command starts, and an unconfigured `ConnectTimeout` can sit for tens of seconds. Waiting longer
costs nothing next to an answer nobody can trust.

`$BROWSER` is neutralized for every probe spawn, copied from `claude-usage-sampler.ts` for the same
reason: an unattended background probe must never be able to pop an OAuth window. `claude auth
status` does not open one, so this is a belt on top of braces.

## 4. Invariants

These are the rules that make the feature safe to trust. Each one exists because breaking it produces
a confidently wrong answer, which is worse than no answer.

### 4.1 Never report `logged-out` from a probe that did not run

A missing binary, a timeout, an unreachable SSH host, an unresolvable SSH remote, an unparseable
payload, and a provider with no status command are all `unknown`. `logged-out` requires a command
that ran and returned a parseable negative.

`ProbeRun.spawnFailure` is what keeps the two apart in code: it marks "could not be run at all", as
distinct from a non-zero exit, which means the command ran and had something to say.

The type system carries the same distinction. `ProviderAuthStatus` has both `unknown` ("not probed
yet, or the probe failed") and `unsupported` ("there is nothing to probe"), so an unprobeable
provider can never be rendered as signed out.

### 4.2 Never probe a non-`oauth` identity

See §2. `UNSUPPORTED_KIND_DETAIL` is a `Record<CredentialIdentity['kind'], string>`, so adding a kind
fails the type check at that table rather than silently falling through to an empty explanation.

### 4.3 A remote identity is probed on its host, or not at all

The probe gates on host consistency in both directions: an `ssh:` identity with no SSH config, and a
local identity handed an SSH config, both refuse rather than probe. Probing a remote identity locally
would file the LOCAL machine's login state under a REMOTE identity's key.

SSH transport failures are converted to `unknown` before any provider parser sees them - exit code
255, plus `SSH_TRANSPORT_FAILURE_RE` against stderr for the cases a login shell on the far side
swallowed the code. Without that, one `ssh: connect to host ...` banner line reaching the codex
matcher (whose logged-out branch is a substring test) reports a perfectly good login as expired.

Same rule as `sshUnresolvedFailure()` in `src/cli/services/agent-spawner.ts`: the user opted into
SSH, so failing loudly beats silently answering for the wrong machine.

### 4.4 One probe per identity, never one per session

`collectAuthTargets()` dedupes into a `Map` keyed by `CredentialIdentity.key`, the same shape
`claude-usage-startup.ts` uses for `configDirKey`. Fifteen agents on one Anthropic account produce
exactly one `claude auth status` spawn, one snapshot, one badge state, one toast, and one command
palette entry. The dedup is not an optimization; it is the feature.

The startup pass fans out with `mapWithConcurrency` at `PROBE_CONCURRENCY = 4` and never throws:
every failure is a warn plus a skipped identity, because a failure here should cost a badge, not a
boot.

### 4.5 No raw secret leaves the process boundary

Producers strip; the store scrubs anyway. `providerAuthStore.setSnapshot()` caps `detail` at 300
characters and runs it through `SECRET_PATTERNS` (bearer tokens, `sk-`, `gh[pousr]_`, and a
catch-all for unbroken 40+ character token-shaped runs). Identities carry a fingerprint, never a
value. The modal's "Show command" reveal shows the command line, which is a subcommand and flags -
no provider login command takes a secret as an argument.

## 5. Storage and freshness

`src/main/stores/providerAuthStore.ts` is a singleton over the electron-store namespace
`provider-auth-snapshots`, one `ProviderAuthSnapshot` per identity key.

Snapshots do **not** expire, unlike the quota store this otherwise mirrors. A quota reading goes
stale and becomes wrong; a login state goes stale and stays useful, since "signed out 40 minutes ago"
is still the best thing we know. `PROBE_STALE_MS` (15 minutes) governs when to RE-PROBE, not when to
forget.

`ProviderAuthSource` records how a status was learned, and consumers key behavior off it:

| Source          | Meaning                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `probe`         | A status command ran and its output was parsed.                                                                  |
| `error-pattern` | An `auth_expired` match in a live agent's output. Reactive, so it can mark an identity before any probe has run. |
| `login-flow`    | The user completed (or abandoned) a login Maestro drove.                                                         |

The source is what separates two very different `unsupported` states in the Left Bar:
`unsupported` from a `probe` means "nothing here to probe" (Factory Droid), which is the normal state
of a healthy agent and must not be badged. `unsupported` from a live failure means a key or gateway
token was rejected, which is badged - with a shield rather than a key, since no sign-in can repair
it.

## 6. Modes

| Mode      | Skips fresh snapshots | Skips stale sessions (7 days) | Skips SSH remotes | Honors the startup setting |
| --------- | --------------------- | ----------------------------- | ----------------- | -------------------------- |
| `startup` | Yes                   | Yes                           | Yes               | Yes                        |
| `manual`  | No                    | No                            | No                | No                         |

SSH is startup-excluded because an unreachable host burns the full probe timeout and a dozen of them
at launch is a dozen connection attempts nobody asked for. A manual refresh is an explicit request
from a user who is present to wait, so it pays that cost.

The local install check does not gate remote sessions: `agentDetector` answers "is this binary on
THIS machine", and an SSH agent runs the provider on the far host by bare binary name.

## 7. Login flow

`src/main/agents/auth/auth-login.ts` spawns the interactive login for one identity into a PTY the
recovery modal renders. Three rules, each of which produces a successful-looking flow that repairs
nothing when broken:

1. **The identity's env, never the app's ambient env.** A login against `.claude-smash` when
   `.claude-gmail` is blocked writes a fresh token into the wrong directory, and the user finds out at
   the next prompt. The env is not re-derived: `collectAuthTargets()` is the same function the probe
   pass uses.
2. **The far machine's login for a far machine's credential**, via `wrapSpawnWithSsh`. An
   unresolvable remote is a hard failure, never a local fallback.
3. **A synthetic process id, never an agent's.** `buildLoginRunSessionId()` mints
   `auth-login-<slug>-<runId>`; `isLoginRunSessionId()` is checked in main before spawning under a
   renderer-supplied id. Without that check a bug could request a login PTY under a live agent's
   session id, which would kill that agent (`ProcessManager.spawn()` kills whatever holds the key)
   and stream login output into its transcript. The slug also rewrites reserved segments
   (`-ai-`, `-terminal`, `-batch-`, `-synopsis-`) that other subsystems key behavior off, since the
   id is built from a config directory path a user controls.

`resolveLoginCommand()` returns `null` for every non-`oauth` kind, which is what removes the sign-in
button rather than any UI-level check. It repeats the binary names from `main/agents/definitions.ts`
rather than importing them, because that module is not renderer-safe.

## 8. Verification and repair

`src/renderer/services/authRecovery.ts` decides whether a login worked.

- **Nothing is claimed without a probe.** A finished browser flow is not evidence: some CLIs keep
  running after the browser step, some redirect to a success page and still fail to write a token.
  The verdict comes from a fresh `providerAuth:reprobe`, and a probe that cannot answer reports
  `unknown` rather than guessing.
- **A repaired login repairs every agent on it.** The error was recorded against the credential, so
  clearing it against one agent would leave the other fourteen badged for a login that already works.
  Clearing is type-scoped: a rate-limit or network error on those agents is still true and survives.
- **Parked work is offered back, never replayed.** Each blocked prompt sits in `retryStore`
  (`noteAuthBlockedPrompt` / `getBlockedPrompts`); a successful probe raises a confirm modal listing
  them, and nothing is sent until the user agrees. Minutes can pass between the failure and the
  login, and the `opencode` auth pattern matches any line containing "authentication", so a parked
  prompt may belong to a turn that never actually failed on auth.

## 9. IPC surface

`window.maestro.providerAuth`, backed by `src/main/ipc/handlers/provider-auth.ts`:

| Method                    | Notes                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getAll()`                | Every snapshot, keyed by identity key.                                                                                                                                                                             |
| `reprobe(key, options?)`  | One credential. `options.source` lets the recovery modal attribute its check to the login flow.                                                                                                                    |
| `reprobeAll()`            | `runStartupAuthProbe(..., mode: 'manual')` - the same function boot calls.                                                                                                                                         |
| `mark(key, request?)`     | Record a failure the renderer observed. Carries the full identity so a never-probed credential can be marked; `status` is limited to `logged-out` / `unsupported`, and `source` to `error-pattern` / `login-flow`. |
| `startLogin(request)`     | Spawn the login PTY. Output flows over the normal `process.onData` channel under `runSessionId`.                                                                                                                   |
| `stopLogin(runSessionId)` | Kill it (modal closed, or the user re-ran the command).                                                                                                                                                            |
| `onChange(cb)`            | Push on every store write, from anywhere in main.                                                                                                                                                                  |

Change broadcasting is registered once against the store rather than per handler, so a write from the
startup pass, a manual re-probe, or the reactive marker all reach the renderer identically.

## 10. Renderer mirror

`src/renderer/stores/providerAuthStore.ts` owns a read cache, main owns the data. Hydration is lazy:
the first consumer to mount pulls the map and installs the `onChange` listener. Same contract as
`claudeUsageStore`.

Two performance constraints shape it, and both are load-bearing rather than incidental:

- A `Session` object is replaced on every log append, so resolving identity per render would re-run a
  SHA-256 fingerprint and a path canonicalization for every agent in the Left Bar on every stdout
  chunk from any of them. Identities are cached per session id, invalidated on a fingerprint of the
  four inputs that change the answer.
- `selectLoggedOutIdentities` returns the PREVIOUS array when the result is unchanged. Zustand v5
  compares selector output with `Object.is`, so a fresh array every call re-renders (and warns)
  forever.

Announcements are per identity and idempotent: the announced-key map is rebuilt on every pass rather
than added to, so an account that comes back and later signs out again announces again, and the map
is written before the toasts fire so a re-entrant pass cannot double-announce.

## 11. Where to look

| Concern                          | File                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Identity model, login commands   | `src/shared/providerAuth.ts`                                                                                            |
| Probe                            | `src/main/agents/auth/auth-probe.ts`                                                                                    |
| Startup pass, target collection  | `src/main/agents/auth/auth-startup.ts`                                                                                  |
| Login PTY                        | `src/main/agents/auth/auth-login.ts`                                                                                    |
| Snapshot store (source of truth) | `src/main/stores/providerAuthStore.ts`                                                                                  |
| IPC                              | `src/main/ipc/handlers/provider-auth.ts`, `src/main/preload/providerAuth.ts`                                            |
| Renderer mirror                  | `src/renderer/stores/providerAuthStore.ts`                                                                              |
| Post-login repair                | `src/renderer/services/authRecovery.ts`                                                                                 |
| UI                               | `AuthRecoveryModal.tsx`, `AuthResendModal.tsx`, `SessionList/AuthIndicator.tsx`, `Settings/ProviderAccountsSection.tsx` |
