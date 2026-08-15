---
type: architecture
title: Provider Auth Survey
created: 2026-08-15
tags:
  - auth
  - providers
  - architecture
related:
  - '[[design]]'
  - '[[provider-auth]]'
---

# Provider Auth Survey

Ground truth for the Provider Auth Recovery feature. Everything below was read out of the tree at
`feat/provider-auth-recovery` or executed against the provider CLIs installed on this machine on
2026-08-15. Later phases should treat this as the reference and not re-derive it.

The design doc that consumes this survey is [[design]]; the user-facing doc is [[provider-auth]].
Both are added in Phase 06.

## 1. The precedent: quota already solved account identity

Maestro already keys per-account state by a canonical config directory. The auth work copies that
shape rather than inventing a second one.

### `src/main/stores/claudeUsageStore.ts`

- Singleton wrapper over an `electron-store` namespace (`claude-usage-snapshots`), holding
  `snapshots: Record<string, UsageSnapshot>`.
- The record key is the **canonical config-dir key**, produced by `resolveConfigDirKey(env)` at
  line 156:

  ```ts
  export function resolveConfigDirKey(env: NodeJS.ProcessEnv): string {
  	const raw = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  	return path.resolve(raw);
  }
  ```

  Two facts matter for the auth resolver. First, `path.resolve()` is the only canonicalization -
  no `realpath`, no symlink resolution, no case folding. Second, `env` is a **required** argument
  deliberately: the comment states callers must pass the env they actually injected into the spawn,
  so a snapshot can never be silently keyed against `process.env` when the spawn used a different
  env. The auth resolver keeps the same rule.

- Snapshots carry `sampledAt` and expire after `SNAPSHOT_TTL_MS` (24h). Pruning is opportunistic on
  both read and write, never on a timer, and an unparseable `sampledAt` reads as expired so
  corrupted records self-heal.
- The `Store` instance is created lazily inside `getStore()` so a test can `vi.mock('electron-store')`
  before the module is touched. `__resetForTests()` clears the cached singleton.

### `src/main/stores/codexUsageStore.ts`

Same shape, different env var. `resolveCodexHomeKey(env)` at line 103 differs from its Claude
counterpart in one respect worth copying: it treats an **empty string** as unset.

```ts
const raw =
	typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.length > 0
		? env.CODEX_HOME
		: path.join(os.homedir(), '.codex');
return path.resolve(raw);
```

The Claude version uses `??`, so `CLAUDE_CONFIG_DIR=''` resolves to `path.resolve('')` (the process
cwd), not `~/.claude`. That is a latent inconsistency, not a blocker; the auth resolver should use
the Codex semantics (empty means unset) for every provider.

`CodexUsageSnapshot` already carries an `authState` field
(`'authenticated' | 'missing_auth' | 'unauthenticated' | 'error'`). This is the closest existing
thing to a login-state enum, and it is Codex-only.

### `src/main/agents/claude-usage-startup.ts` (the structural template for Phase 02)

426 lines, and the file the probe layer should be modeled on. Key structure:

| Concern              | How it is done                                                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry point          | `runStartupUsageSampling(deps)`, fire-and-forget from `src/main/index.ts` after settings/CLI watchers come up. Never throws: every failure is a `logger.warn` plus a skipped entry.                                                             |
| Dependency injection | `StartupUsageSamplingDeps` takes the stores, the `AgentDetector`, an optional `now()` override for tests, and a `mode`. The sessions store is typed `Pick<Store<SessionsData>, 'get'>` so it is read-only by construction.                      |
| Mode split           | `'startup'` (default) is strict: only sessions that will actually spawn through `maestro-p` AND are inside the 7-day window. `'manual'` (Usage Dashboard Refresh) samples every Claude session, ignoring both filters.                          |
| Session window       | `STARTUP_SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000`, applied as `createdAt >= now - window`. Sessions with no numeric `createdAt` are dropped in startup mode.                                                                                |
| Env merge            | `buildTarget()` does `{ ...agentLevelEnvVars, ...sessionEnvVars }`. Session wins. Agent-level vars come from `agentConfigsStore.get('configs', {})['claude-code'].customEnvVars`.                                                               |
| Dedup                | `targetsByKey = new Map<string, SamplingTarget>()` keyed by `configDirKey`. First session wins on `cwd` / env shape, because the result is a per-account fact, not a per-session one. **This is the pattern Phase 02 dedupes identities with.** |
| Fan-out              | `await Promise.all(targets.map(...))` - all accounts sampled in parallel, each writing its own snapshot.                                                                                                                                        |
| Staleness            | `USAGE_SNAPSHOT_STALE_MS = 5 * 60 * 1000` is exported here and consumed by the spawner, so the 5-minute number is not hardcoded twice.                                                                                                          |

Three guards in `buildTarget()` are directly relevant to the auth probe, and skipping them would
reintroduce bugs this file already fixed:

1. **SSH-remote sessions return null.** A remote session's `CLAUDE_CONFIG_DIR` names a directory on
   the remote host. Sampling it locally reads the wrong host, and if the local path happens to exist
   without a Keychain token, the spawn pops an OAuth browser the user never asked for.
2. **No `cwd` returns null.** Malformed record.
3. **No explicit `CLAUDE_CONFIG_DIR` returns null.** The file refuses to guess the default account:
   `~/.claude` may have stale `.claude.json` metadata pointing at an account whose Keychain tokens
   are gone, and that combination triggers a browser OAuth flow. The comment at line 355 repeats the
   point for manual mode: manual mode deliberately does **not** sweep the filesystem for
   `~/.claude-*` dirs, even though `discoverClaudeConfigDirs()` exists in the same file (it backs a
   listing IPC handler that spawns nothing).

The lesson for Phase 02: **a probe that can pop a browser is not a passive probe.** Any auth probe
command must be verified non-interactive before it is run at startup, or gated the same way.

Also in this file: `discoverClaudeConfigDirs(homeDir)` scans `$HOME` for `.claude` /
`.claude-*` directories that contain a readable `.claude.json`, excluding names matching
`ACCOUNT_DIR_EXCLUDE_RE` (`backup|bak|old|archive|archived|stage|local|server`). And
`getMaestroPBinPath()` documents the dev-vs-packaged binary resolution order
(`process.resourcesPath` -> `__dirname/../cli` -> `cwd/dist/cli`).

### `src/renderer/components/UsageDashboard/quota/useQuotaAccounts.ts`

The renderer's version of the same sourcing rule, and the canonical statement of the env-merge
precedence (line 123):

```ts
const sessionEnv = (s.customEnvVars ?? {}) as Record<string, string>;
const merged = { ...agentLevelEnvVars, ...sessionEnv };
const dir = merged[envVarName];
```

Agent-level merged **under** session-level; session wins. Identical to the main-side sampler, which
is why Phase 01 puts it in one shared `mergeEffectiveEnv()` rather than a third copy.

The account list unions four sources: explicit prop keys, main-side discovered account dirs, every
`<TOOL>_HOME` / `CONFIG_DIR` referenced by a session of the matching `toolType`, and every key
already present in the snapshot store (so an account whose session was deleted keeps its tab).
Sessions with no explicit env var fall back to the implicit default `~/<defaultSubdir>` - note this
is the opposite of the main-side sampler, which skips them. The hook is generic over
`{ toolType, envVarName, defaultSubdir }`, which is a useful shape to copy for a multi-provider auth
panel. Selection state clamps to the first account whenever the current selection disappears.

## 2. `src/shared/providerFailover.ts`

Pure and dependency-free by design (runs in both processes), which is the same constraint Phase 01
puts on `providerAuth.ts`.

- `ANTHROPIC_ENDPOINT_ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']`
  (line 83) - the keys that carry an endpoint's identity.
- `ANTHROPIC_CREDENTIAL_ENV_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']` (line 94) - the
  subset that carries a **secret** rather than an address. The credential resolver's `api-key`
  branch reads exactly these two, and a fingerprint (never the value) is what may be stored.
- The gateway semantics documented around line 101, in `failoverUnsetEnvKeys()`: a non-empty
  `ANTHROPIC_BASE_URL` means the agent is pointed at a **different operator**, so any credential the
  endpoint does not supply itself is stripped rather than inherited - otherwise the user's primary
  Anthropic key is handed to a third party. The function returns keys to _strip_, not keys to set,
  because a merge cannot express removal and the value being removed may come from global shell
  settings or `process.env` rather than the agent's own vars.

Two consequences for the identity model:

1. `ANTHROPIC_BASE_URL` non-empty must outrank the token check when deciding `kind`. A gateway agent
   that also carries a token is still a gateway - the token belongs to the gateway operator, and
   `claude auth login` cannot fix it.
2. "Non-empty" here means `(env[key] ?? '').trim() !== ''`. `resolveFailoverEnv()` also skips blank
   values on merge so a half-filled editor row cannot clobber a working var. The auth resolver
   should treat a whitespace-only value as unset for the same reason.

`resolveFailoverEnv(baseEnv, endpointEnv)` is a third env-merge site, but it is a different merge
(endpoint over agent, with deletions) and should not be folded into `mergeEffectiveEnv()`. Note that
a live failover endpoint changes the effective credential identity of an agent: an agent failed over
to a Z.AI endpoint is a `gateway` identity while it is pinned there.

## 3. Auth error detection today

### `src/main/parsers/error-patterns.ts` (1242 lines)

`auth_expired` is one of seven `AgentErrorType`s. 27 auth patterns across 5 providers:

| Provider        | Block    | Count | Patterns                                                                                                                                                                                                                                               |
| --------------- | -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude-code`   | line 51  | 11    | `invalid api key`, `authentication failed`, `authentication_failed`, `authentication_error`, `oauth token has expired`, `please run.*claude login`, `please run.*\/login`, `unauthorized`, `api error:\s*401`, `api key.*expired`, `not authenticated` |
| `opencode`      | line 275 | 2     | `invalid.*key`, `authentication`                                                                                                                                                                                                                       |
| `codex`         | line 400 | 5     | `invalid.*api.*key`, `authentication.*failed`, `unauthorized`, `\b403\b\|forbidden`, `api.*key.*expired`                                                                                                                                               |
| `factory-droid` | line 601 | 5     | `invalid.*api.*key`, `authentication.*failed`, `unauthorized`, `FACTORY_API_KEY`, `api.*key.*expired`                                                                                                                                                  |
| `copilot-cli`   | line 925 | 4     | `authentication failed`, `not authenticated`, `unauthorized`, `invalid.*token`                                                                                                                                                                         |

`SSH_ERROR_PATTERNS` (line 747) has **no** `auth_expired` bank - SSH auth failures surface as other
types. `terminal` has no patterns at all. The registry (line 1052) maps only the five agents above.

Observations that matter downstream:

- **The patterns cannot tell an expired OAuth token from a bad API key.** Both land on
  `auth_expired`. Only the credential _identity_ knows which remedy applies, which is the entire
  argument for Phase 01.
- **`opencode`'s `/authentication/i` is dangerously broad** - any line containing the word matches.
  Anything that auto-triggers on `auth_expired` (Phase 05's auto-resend) must tolerate a false
  positive from this pattern.
- **Every message string is provider-generic advice**, several of them wrong for the agent's actual
  credential: `claude-code` says `claude login` even for an `ANTHROPIC_API_KEY` agent, and
  `copilot-cli` says `gh auth login` when the real command is `copilot login`.
- `matchErrorPattern()` iterates `ERROR_TYPES_BY_HIT_FREQUENCY` (line 1115), where `auth_expired`
  sits 4th of 7 - rate limits and network errors dominate real traffic. It also skips the regex bank
  entirely for chunks shorter than `ERROR_PATTERN_DEFAULT_MIN_CHUNK_LENGTH` (7); unit tests pass
  `minLength: 0` to opt out.

### `src/renderer/hooks/agent/internal/useAgentErrorListener.ts`

The single consumer path for parsed errors. Three branches: group chat, synopsis (ignored), and
per-session. On the per-session branch an error frame is appended to the target tab and the session
is stamped `agentError` / `agentErrorTabId` / `agentErrorPaused: true` / `state: 'error'`, then
`openModal('agentError', ...)` fires (line 356).

Agent Resilience runs first: `scheduleRetryForError()` (line 158) can claim the error and suppress
both the error frame and the modal, collapsing the outage into one `RetryStatusCard`. `auth_expired`
is not currently claimed by that path, which is what Phase 05 changes. Note the auto-retry path
requires a concrete `tabIdFromSession`.

The Auto Run branch hardcodes the remediation string at line 315:
`'- Re-authenticate with the provider (e.g., run \`claude login\` in terminal)'` - a third place that
assumes claude-code + OAuth.

### The recovery that does not recover

`agentStore.authenticateAfterError()` (`src/renderer/stores/agentStore.ts:309`), in full:

```ts
authenticateAfterError: (sessionId) => {
	const session = getSession(sessionId);
	if (!session) return;
	get().clearAgentError(sessionId);
	useSessionStore.getState().setActiveSessionId(sessionId);
	updateSession(sessionId, (s) => ({ ...s, inputMode: 'terminal', activeFileTabId: null }));
},
```

It clears the error and switches to terminal mode. **No login command is ever run.** The wiring is:

`AgentErrorModal` -> `useAgentErrorRecovery.tsx:67` builds the action (label `'Use Terminal'` for
claude-code, `'Re-authenticate'` otherwise; description `'Run "claude login" in terminal'`) ->
`useModalHandlers.ts:468` supplies `onAuthenticate` -> `handleAuthenticateAfterError` (line 434) ->
the store action above. Existing tests live at `src/__tests__/renderer/stores/agentStore.test.ts:728`
and `src/__tests__/renderer/hooks/useModalHandlers.test.ts:806`; Phase 05 must update them.

### `src/renderer/components/Wizard/services/wizardErrorDetection.ts`

A **second, parallel** auth-pattern bank, provider-agnostic and unaware of the one in
`error-patterns.ts`. Six `auth_expired` entries: `OAuth\s*token\s*has\s*expired`,
`authentication_error`, `invalid\s*api\s*key`, `please\s*run\s*.*login`, `unauthorized|401`,
`not\s*authenticated`. Each carries a `recoveryHint` string; four of the six literally say
`Run "claude login" in your terminal`, and every one sets `canRetry: false`.

This is the manual-hint surface Phase 05 rewires. `detectWizardError()` returns the first match in
array order, and `formatWizardError()` renders `title: message\n\nrecoveryHint`. Since the wizard is
not always driving claude-code, the hint is wrong whenever it is not.

#### Resolved in Phase 05: the two banks are now one (2026-08-15)

The wizard bank is gone. The canonical bank moved to `src/shared/agentErrorPatterns.ts` (unchanged
patterns; `src/main/parsers/error-patterns.ts` is now a thin wrapper that installs the main logger
and re-exports), so the renderer can use it directly. It could not before: the module imported
`main/utils/logger`, which pulls in `fs`/`os`, and the renderer bundle has no Node polyfill.
`detectWizardError(output, agentType)` now takes the agent it is driving and matches against THAT
agent's patterns with `minLength: 0`; what stays in `wizardErrorDetection.ts` is presentation only
(title, recovery hint, and whether resending can help).

Coverage the wizard gained: 11 claude-code auth patterns instead of 6 generic ones, plus the codex,
opencode, factory-droid and copilot banks it never had, plus `permission_denied` and
`session_not_found`, which it used to report as an unclassified generic error.

Three wizard patterns have no canonical counterpart, and all three were dropped **deliberately**
rather than merged in. Each is a bare token that the canonical bank must scan against streaming agent
output line by line, where the same token appears constantly in ordinary prose and code:

| Wizard-only pattern                       | Why it is not adopted                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401` (bare, in `unauthorized\|401`)      | Canonical requires `api error:\s*401`. A bare `401` matches a line number, a port, a byte count. `unauthorized` alone still covers the real case. |
| `429` (bare, in `too many requests\|429`) | Same. Canonical keeps `too many requests` for claude-code and scopes numeric codes with `\b` only where the code is unambiguous (`\b529\b`).      |
| `panic`                                   | An agent discussing a Go panic would be reported as having crashed. `\b(fatal\|unexpected\|internal\|unhandled)\s+error\b` covers a real crash.   |

Also changed while consolidating: the `auth_expired` messages in the claude-code and copilot-cli
banks no longer name a shell command (`claude login`, `gh auth login`). They state what failed and
stop there, because the remedy depends on the credential, and `claude login` is not even a real
command (discrepancy 3 in section 5). The remedy is now the surface's job: the agent error modal,
the wizard error panel, and the Auth Recovery Modal each name the right one.

## 4. Provider CLI auth surfaces (verified on this machine, 2026-08-15)

Recorded so later phases do not re-derive them. `claude`, `codex`, `opencode`, and `copilot` are all
installed here; `droid` is not.

### claude-code

`claude auth` has `login`, `logout`, `status`.

```
$ claude auth status --json
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "...",
  "orgId": "397eecd3-...",
  "orgName": "...'s Organization",
  "subscriptionType": "max"
}
```

Exit code 0 when logged in. **Exit code 1 when logged out**, with the same well-formed JSON on
stdout (`{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}`) - re-verified
2026-08-15 against an empty `CLAUDE_CONFIG_DIR`. The probe therefore ignores the exit code entirely
and parses stdout either way; gating on exit 0 would throw away a perfectly good `loggedIn: false`.
`--json` is the **default** (`--text` opts into human-readable), but pass `--json`
explicitly so a future default flip cannot break the parser. The response also carries `orgId`,
which the playbook's list omitted. Returns promptly and does not open a browser, so it is safe for a
startup pass - unlike `maestro-p --status`, which is why the usage sampler needs its guards and the
auth probe may not.

`claude auth login` options, verified: `--claudeai` (default, Claude subscription), `--console`
(Anthropic Console / API billing), `--sso` (force SSO), `--email <email>` (pre-populate).

### codex

`codex login` with subcommand `status`.

```
$ codex login status
Logged in using ChatGPT
```

Exit code 0. Logged out prints `Not logged in` and **exits 1** (re-verified 2026-08-15 against an
empty `CODEX_HOME`). Plain text, not JSON, so the probe parses a status line plus the exit code. Note
that `Not logged in` contains the logged-in phrase as a substring, so the negative match must be
tested first. Flags on
`codex login`: `--with-api-key` (reads the key from stdin, e.g.
`printenv OPENAI_API_KEY | codex login --with-api-key`), `--with-access-token` (reads an access
token from stdin), `-c key=value` config overrides, `--enable <FEATURE>`. Bare `codex login` starts
the browser flow.

### opencode

`opencode auth` with `list` (alias `ls`), `login [url]`, `logout`.

```
$ opencode auth list
┌  Credentials ~/.local/share/opencode/auth.json
│
●  Anthropic oauth
│
└  1 credentials
```

Exit code 0. Output is ANSI-decorated box drawing, one line per credential as
`<Provider> <method>`. Two things to record: the credential file path is
`~/.local/share/opencode/auth.json` (printed in the header, confirming the default scope Phase 01
uses), and opencode credentials are **per-provider inside one file** - an opencode identity is
plausibly finer-grained than one login. `opencode auth login` is an interactive provider picker.
Strip ANSI with `stripAnsiCodes()` from `src/shared/stringUtils.ts` before parsing.

### copilot-cli

`copilot login` runs an OAuth device flow; the token is stored in the system credential store, or in
a plain-text config under `~/.copilot/` when no credential store is available. From `copilot login --help`,
verbatim precedence order for env tokens: **`COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then
`GITHUB_TOKEN`**. Supported token types: fine-grained PATs with the "Copilot Requests" permission,
OAuth tokens from the GitHub Copilot CLI app, and OAuth tokens from the `gh` app. Classic `ghp_`
tokens are **not** supported. No `copilot auth status` subcommand was found, so login state is not
directly probeable.

Note the mismatch with `COPILOT_ERROR_PATTERNS`, which tells users to run `gh auth login`.

### factory-droid

`droid` is not installed here and no auth surface is verified. It must resolve to
`kind: 'unknown'` / `status: 'unsupported'`, never `logged-out`. Its error bank keys off
`FACTORY_API_KEY`, which suggests API-key auth, but that is inference, not verification.

## 4b. Probe commands chosen in Phase 02

`src/main/agents/auth/auth-probe.ts` runs exactly one command per provider, re-verified on this
machine on 2026-08-15. Nothing here opens a browser or an interactive picker.

| Provider        | Command                     | Signal read                                                 | Exit code used?      |
| --------------- | --------------------------- | ----------------------------------------------------------- | -------------------- |
| `claude-code`   | `claude auth status --json` | `loggedIn` plus `apiProvider` from the JSON body            | No (0 and 1 both OK) |
| `codex`         | `codex login status`        | `Not logged in` first, then a line-anchored `Logged in ...` | Yes, for the 0 case  |
| `opencode`      | `opencode auth list`        | The `N credentials` footer, after ANSI stripping            | Yes, must be 0       |
| `copilot-cli`   | none                        | -                                                           | -                    |
| `factory-droid` | none                        | -                                                           | -                    |

Two findings from re-running the `--help` checks the phase asked for:

- **copilot-cli has no status verb.** `copilot --help` lists exactly `completion`, `help`, `init`,
  `login`, `mcp`, `plugin`, `update`, `version`. `copilot login` runs an interactive device flow, and
  there is no `copilot auth` group at all. The probe spawns **nothing** for copilot and returns
  `unknown`.
- **opencode's `auth list` is probeable but coarse.** `opencode auth --help` (the command is really
  `opencode providers`, with `auth` as an alias) offers `list` / `login` / `logout`; only `list` is
  non-interactive. It exits 0 whether or not credentials exist, so the footer count is the whole
  signal: `0 credentials` reads as `logged-out`, anything higher as `authenticated`. Two caveats
  recorded for later phases: the count spans **all** providers in one `auth.json`, so it answers "is
  anything stored" rather than "is the provider this agent uses logged in"; and against a fresh data
  directory the first run performs a one-time database migration that can take minutes, which lands
  on the probe timeout and resolves to `unknown` (the safe side).

## 5. Discrepancies found against the Phase 01 spec

Recorded here so the next task does not silently paper over them.

1. **opencode has no API-key env vars in `definitions.ts`.** The spec for `resolveCredentialIdentity`
   says to treat "a provider API key recognized by the opencode entry in
   `src/main/agents/definitions.ts`" as `api-key`. The opencode entry (line 358) defines only
   `OPENCODE_CONFIG_CONTENT` in `defaultEnvVars` / `readOnlyEnvOverrides` - there is no API-key list
   to read. The resolver needs an explicit key list of its own, or that branch is unreachable.
2. **`CLAUDE_CONFIG_DIR=''` resolves to the process cwd** in `resolveConfigDirKey`, because it uses
   `??` rather than a length check. `resolveCodexHomeKey` gets this right. Use the Codex semantics
   everywhere in `providerAuth.ts` and leave the existing quota behavior alone.
3. **`claude login` is not a real command.** The CLI exposes `claude auth login` (and `/login` inside
   the TUI). Every user-facing string in the tree that says `claude login` -
   `error-patterns.ts`, `wizardErrorDetection.ts`, `useAgentErrorRecovery.tsx`, and the Auto Run hint
   in `useAgentErrorListener.ts` - is stale. Phase 04 and Phase 05 should emit `claude auth login`.
4. **Copilot's remediation says `gh auth login`** but the CLI's own command is `copilot login`.
5. The playbook asks this doc to cross-link "the two docs Phase 02 and Phase 04 will add". Neither
   of those phases adds a doc; Phase 06 adds both `docs/provider-auth.md` and
   `docs/architecture/provider-auth/design.md`. Those are the two linked above.
