# Account Multiplexing (Virtuosos)

Guide to the account multiplexing feature: intent, architecture, design decisions, event contracts, validation steps, and test coverage. Read this before editing anything under `src/main/accounts/` or the account-related pieces of the spawn path, and use the checklists at the bottom to validate the feature end to end.

**User-facing name:** Virtuosos ("AI Account Providers"). All UI copy says Virtuoso; all internal identifiers (variables, IPC channels, store keys, file names) say account. Keep that split intact.

---

## 1. Intent

Claude Code subscriptions (Pro/Max) enforce per-account usage windows (roughly 5-hour rolling quotas). A single heavy Maestro user hits those limits mid-session, which kills long Auto Run batches and blocks interactive work until the window resets.

Account multiplexing lets one Maestro install drive **multiple Claude accounts**:

1. **Isolation** - each account lives in its own `CLAUDE_CONFIG_DIR` (for example `~/.claude-work`, `~/.claude-personal`), so OAuth credentials never mix.
2. **Routing** - every Claude Code spawn is tagged with an account; selection can be manual (per agent), default, round-robin, or capacity-aware least-used.
3. **Tracking** - token usage is aggregated per account into aligned time windows so limits can be predicted before the provider enforces them.
4. **Automatic recovery** - when an account gets rate-limited the session can switch to another account and resume the interrupted turn; when auth expires the system re-logs-in and resumes; when every account is exhausted, Auto Runs pause and auto-resume once a window resets.

Multiplexing has **full parity for Claude Code, Codex, and OpenCode**; each provider isolates accounts behind its own config-dir env var (see the parity matrix in section 2.3). Providers without a relocatable config dir (Gemini CLI, Factory Droid) are import/observe only, and non-multiplexable agents (Copilot, terminal) are completely untouched: the injector returns early for any agent without a config-dir env var, and with zero accounts registered for a provider the entire system is a no-op for that provider.

**The ENTIRE feature is gated on the `virtuosos` Encore flag** (Settings -> Plugins -> Virtuosos, default off). In `src/main/index.ts` every consumer receives the account machinery through gated getters (`getAccountRegistryGated` etc.) that re-read the flag live on each call: with the flag off there is no env injection, no account error routing, no per-account usage aggregation, no recovery polling, and no `account:*` events. The renderer hides all surfaces (hamburger entry, modal, selector, dashboard tab, badges) and the CLI ignores `--account`/`--account-rotation` with a warning. Toggling the flag on restores everything without a restart; account data in `maestro-accounts.json` is preserved while off.

---

## 2. Architecture

### 2.1 Main process (`src/main/accounts/`)

| Module                              | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `account-registry.ts`               | Source of truth. CRUD over `AccountProfile`s, session-to-account assignments (normalized to base agent IDs), selection strategies (`least-used` with capacity scoring, `round-robin`), switch config, startup reconciliation. Backed by the `maestro-accounts` electron-store.                                                                                                                                                                                                                                                             |
| `account-env-injector.ts`           | The single spawn-time hook. Resolves an account for a session (explicit `accountId` > existing assignment > default > `selectNextAccount`, all scoped to the session's provider) and sets the provider's config-dir env var (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`) in the spawn env. Skips providers without an env var, user-set env vars, and accountless installs. Auto-syncs the provider's missing credential file from its base dir. Emits `account:assigned`.                                                         |
| `account-throttle-handler.ts`       | Reacts to `rate_limited` (and `auth_expired` fallback) errors: records a throttle event in stats, marks the account `throttled`, picks the next account, then either prompts (`account:switch-prompt`) or auto-executes (`account:switch-execute`) per config. Emits `account:throttled` with `noAlternatives: true` when no account is available.                                                                                                                                                                                         |
| `account-switcher.ts`               | Executes a switch: kill process (prefix-matches `${base}-ai-*` process IDs), reassign, emit `account:switch-respawn` (renderer respawns), emit `account:switch-completed`. Tracks `lastPrompts` per process session for resume.                                                                                                                                                                                                                                                                                                            |
| `account-auth-recovery.ts`          | `auth_expired` handler: mark account `expired`, kill process, run the provider's login command (`claude login` / `codex login` / `opencode auth login`, with the provider's env var set), fall back to copying the credential file from the provider's base dir, then mark `active` and reuse the `switch-respawn` channel with `reason: 'auth-recovery'`. Guards against concurrent recovery per session.                                                                                                                                 |
| `account-recovery-poller.ts`        | Timer that periodically re-activates `throttled` accounts whose window has passed and emits `account:recovery-available` with `recoveredAccountIds` (drives Auto Run auto-resume). Started at app-ready, stopped on `before-quit`.                                                                                                                                                                                                                                                                                                         |
| `account-setup.ts`                  | Directory lifecycle for all providers: discover existing account dirs (`~/.claude-*`, `~/.codex-*`, `~/.opencode-*` plus single base dirs incl. `~/.factory`), create new provider-specific account dirs with shared-resource symlinks (claude: `projects/` etc. so `--resume` works across accounts; codex: `config.toml`/`prompts/`), validate/repair symlinks, build provider login commands, read account identity, sync credentials, validate remote (SSH) dirs. Provider is inferred from the dir name via `inferProviderFromDir()`. |
| `account-utils.ts`                  | `getWindowBounds(timestamp, windowMs)`: windows are aligned to intervals from local midnight, shared by aggregation, routing, and the poller. Import from here; do NOT re-derive.                                                                                                                                                                                                                                                                                                                                                          |
| `src/shared/accountProviderMeta.ts` | **Single source of truth for provider parity.** Per-provider env var, dir prefix, base dir, auth files, credential file, login command template, and `supportsCreate` flag, plus `inferProviderFromDir()` (config dir path -> provider). Used by setup, injector, auth recovery, CLI spawner, and the renderer (dropdown gating, selector scoping). Do NOT hardcode `CLAUDE_CONFIG_DIR`/`CODEX_HOME` or `.claude-` prefixes elsewhere.                                                                                                     |

### 2.2 Spawn-path integration points (every Claude spawn goes through exactly one)

| Spawn path                                               | Injection site                                                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop AI turn / switch respawn                         | `src/main/ipc/handlers/process/handle-spawn.ts` (before the maestro-p decision and SSH wrapping; passes statsDB for capacity-aware selection) |
| Group chat (moderator, participant, synthesis, recovery) | `src/main/group-chat/spawnGroupChatAgent.ts` (group-level `chat.accountId` wins)                                                              |
| Context grooming                                         | `src/main/utils/context-groomer.ts` (inherits the parent session's account)                                                                   |
| CLI Auto Run / playbooks                                 | `src/cli/services/batch-processor.ts` via `account-reader.ts` (read-only store access; `--account <name>` or `--account-rotation`)            |

Ordering inside `handle-spawn.ts` matters: injection runs **before** `applyLocalInteractiveSpawnDecision` (maestro-p TUI vs `claude --print`) and **before** SSH wrapping, so the env var flows through every downstream branch. RC's `claude-usage-sampler.ts` keys usage snapshots by `CLAUDE_CONFIG_DIR`, so maestro-p dynamic mode makes its TUI-vs-API decision against the assigned account's quota automatically.

### 2.3 Provider parity matrix

Verified against provider CLIs 2026-07-12. "Full" = create + login + discovery + spawn injection + auto-switch + auth recovery.

| Provider      | Parity      | Env var             | Account dirs                           | Login command                           | Notes                                                                                                                     |
| ------------- | ----------- | ------------------- | -------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| claude-code   | Full        | `CLAUDE_CONFIG_DIR` | `~/.claude-<name>`                     | `CLAUDE_CONFIG_DIR=... claude login`    | Shared resources symlinked from `~/.claude` (projects/, settings.json, ...)                                               |
| codex         | Full        | `CODEX_HOME`        | `~/.codex-<name>` (+ `~/.codex`)       | `CODEX_HOME=... codex login`            | `config.toml` and `prompts/` symlinked from `~/.codex` when present; `auth.json` isolated                                 |
| opencode      | Full        | `XDG_DATA_HOME`     | `~/.opencode-<name>` (+ `~/.opencode`) | `XDG_DATA_HOME=... opencode auth login` | Account dir is the XDG data root; auth lands at `<dir>/opencode/auth.json`. Config stays global via `XDG_CONFIG_HOME`     |
| gemini-cli    | Import only | none                | `~/.gemini` only                       | n/a                                     | No config-dir override exists (google-gemini/gemini-cli#2815). Discover/import, badges, usage tracking work; no isolation |
| factory-droid | Import only | none                | `~/.factory` only                      | n/a                                     | Credentials in OS keyring, no documented dir override. Discover/import + observability only                               |

Selection, defaults, and switching are ALWAYS provider-scoped: `getDefaultAccount(agentType)` / `selectNextAccount(..., agentType)` filter by the account's `agentType` (legacy profiles count as claude-code), the throttle handler only proposes same-provider targets, and the injector never routes a session to another provider's account dir.

### 2.4 Event listeners (`src/main/process-listeners/`)

- `error-listener.ts` routes agent errors for sessions WITH an assignment: `auth_expired` goes to auth recovery (falls back to the throttle handler when recovery is unavailable); `rate_limited` goes to the throttle handler. All other error types, sessions without assignments, and accountless installs take the pre-existing path untouched.
- `account-usage-listener.ts` taps the ProcessManager `usage` event: upserts tokens into the account's current window, emits `account:usage-update`, emits `account:limit-warning` (>= `warningThresholdPercent`, default 80) or `account:limit-reached` (>= `autoSwitchThresholdPercent`, default 95) when a token limit is configured, and auto-reactivates throttled accounts once a full window has passed.

### 2.5 Persistence

- **`maestro-accounts.json`** (electron-store, same `cwd` as sessions/settings): `accounts` map, `assignments` map (keyed by base agent session ID), `switchConfig`, `rotationOrder`, `rotationIndex`.
- **stats.db migration v9** (`src/main/stats/migrations.ts`): adds `account_id` + token/cost columns to `query_events`, plus `account_usage_windows` and `account_throttle_events` tables. `src/main/stats/account-usage.ts` owns all queries (windows upsert, throttle events, daily/monthly aggregation, window history for P90 prediction).

### 2.6 Renderer

| Surface             | File                                                                                                     | What it does                                                                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Virtuosos modal     | `VirtuososModal.tsx` wrapping `AccountsPanel.tsx`                                                        | Discover/create/import accounts, login command, symlink repair, limits, switch config. Opened from the hamburger menu.                                                                      |
| Per-agent selector  | `AccountSelector.tsx` (rendered in `InputArea/components/ToolbarControls.tsx`, claude-code AI mode only) | Shows current account + live usage; manual assign/switch.                                                                                                                                   |
| Switch confirmation | `AccountSwitchModal.tsx` (priority `ACCOUNT_SWITCH`)                                                     | Prompt-mode throttle switches.                                                                                                                                                              |
| Usage dashboard     | `UsageDashboard/AccountUsageDashboard.tsx` (Virtuosos tab) + `AccountUsageHistory.tsx`                   | Per-account windows, trends, P90 predictions (`useAccountUsage.ts`).                                                                                                                        |
| Badges              | `SessionItem.tsx` (Left Bar), `ProcessMonitor`, Symphony cards, session tooltips/context menu            | Show the assigned account name.                                                                                                                                                             |
| App wiring          | `App.tsx`                                                                                                | Subscribes to all `account:*` events: toasts, switch prompt modal, respawn handler, Auto Run pause/resume, auth recovery lifecycle, assignment sync into `Session.accountId`/`accountName`. |

### 2.7 IPC surface

34 `accounts:*` channels in `src/main/ipc/handlers/accounts.ts`, bridged 1:1 by `src/main/preload/accounts.ts` (`window.maestro.accounts.*`), typed in `src/renderer/global.d.ts`. Events emitted main-to-renderer (all verified to have subscribers): `assigned`, `usage-update`, `limit-warning`, `limit-reached`, `throttled`, `switch-prompt`, `switch-execute`, `switch-started`, `switch-respawn`, `switch-completed`, `switch-failed`, `status-changed`, `recovery-available`, `auth-recovery-started`, `auth-recovery-completed`, `auth-recovery-failed`.

---

## 3. Design decisions (the "why")

1. **Assignments are per-AGENT, keyed by base session ID.** Process session IDs carry suffixes (`${base}-ai-${tabId}`, `${base}-terminal`, `${base}-synopsis-${ts}`, `${base}-batch-${n}`) while UI/cleanup/reconcile paths use the bare agent ID. `AccountRegistry` normalizes every assignment key through `normalizeAssignmentSessionId()` (patterns mirror `src/renderer/utils/sessionIdParser.ts`; group-chat participant and groomer IDs intentionally pass through raw since they are their own assignment scopes). `reconcileAssignments()` also migrates legacy suffixed keys. Never key assignments by raw process IDs.

2. **Injection respects explicit user configuration.** A `CLAUDE_CONFIG_DIR` already present in the spawn env (session custom env vars) always wins and skips assignment entirely. This is the escape hatch and MUST be preserved.

3. **Manual switches do not auto-respawn; automatic ones do.** A manual switch (AccountSelector / Edit Agent) means "use the other account from now on" - the last prompt already completed, and re-executing it could repeat side effects (file edits, commits). The respawn+resume path only runs for `throttled`/`auth-recovery` reasons where a turn was actually interrupted, and only when a recorded `lastPrompt` exists.

4. **Resume is a proper batch turn.** The respawn handler in `App.tsx` passes the prompt via the spawn config (batch-mode Claude reads no stdin), sets `agentSessionId` for `--resume`, and preserves the tab's permission mode. Prompts are recorded in BOTH `process:write` (interactive/PTY paths) and `process:spawn` (batch paths, which is how desktop Claude turns actually deliver prompts).

5. **Coordination with Agent Resilience (RC).** `rate_limited` errors are consumed by two systems: the renderer retry engine (`retryStore`, backoff resend on the SAME account) and the throttle handler (switch + respawn on a NEW account). The switch respawn calls `cancelRetry()` for the session's tabs so the prompt is not sent twice. `auth_expired` is in the retry engine's non-retryable set, so auth recovery owns that path exclusively.

6. **Capacity-aware routing.** `selectNextAccount` with the default `least-used` strategy scores accounts by remaining window capacity (via statsDB) with a 0.5x penalty for accounts throttled within the last two windows; accounts without limits sort behind accounts with known headroom; falls back to LRU when stats are unavailable. `round-robin` walks `rotationOrder`.

7. **Windows align to local midnight** (`getWindowBounds`), not to first-use. This makes windows stable across restarts and comparable across accounts, at the cost of not exactly matching Anthropic's rolling windows - limits here are user-configured advisories, not provider mirrors.

8. **The whole feature is layered on top, not threaded through.** Every consumer takes optional `getAccountRegistry` (etc.) getters; a null registry short-circuits everything. Removing accounts from the store restores stock behavior with no migration.

---

## 4. Event flows

### 4.1 Spawn assignment

```
renderer process.spawn({sessionId: base-ai-tab, accountId?: Session.accountId})
  -> handle-spawn: injectAccountEnv(sessionId, toolType, env, registry, accountId, safeSend, statsDB)
       explicit accountId > existing assignment (active) > default account > selectNextAccount
       -> env.CLAUDE_CONFIG_DIR = account.configDir
       -> registry.assignToSession(base, accountId)   // normalized
       -> safeSend('account:assigned') -> App.tsx syncs Session.accountId/accountName
```

### 4.2 Rate-limit switch (automatic mode)

```
agent emits rate_limited -> error-listener (assignment exists)
  -> throttleHandler.handleThrottle
       -> stats.insertThrottleEvent + registry.setStatus(throttled)
       -> selectNextAccount(exclude current, statsDB)
            none -> 'account:throttled' {noAlternatives:true} -> App.tsx pauses Auto Run
            promptBeforeSwitch -> 'account:switch-prompt' -> AccountSwitchModal -> executeSwitch
            else -> 'account:switch-execute' -> App.tsx -> executeSwitch
  -> switcher.executeSwitch: kill (prefix-aware) -> reassign -> 'account:switch-respawn'
  -> App.tsx respawn handler: cancelRetry(tabs) -> update session env -> spawn batch turn
       (prompt + --resume + permissionMode) -> 'switch-completed' toast
```

### 4.3 Auth recovery

```
agent emits auth_expired -> error-listener -> authRecovery.recoverAuth(session, account)
  -> status=expired -> kill -> 'auth-recovery-started' toast
  -> claude login (CLAUDE_CONFIG_DIR=dir) || syncCredentialsFromBase(dir)
  success -> status=active -> 'auth-recovery-completed' (App.tsx clears stale
             auth_expired error state) -> 'switch-respawn' {reason:'auth-recovery'}
  failure -> 'auth-recovery-failed' toast (manual "claude login" instructed)
             (recovery unavailable at wiring time -> throttle handler fallback)
```

### 4.4 All-accounts-exhausted and recovery

```
'account:throttled' {noAlternatives:true} -> App.tsx pauseBatchOnError
  (rate_limited, "All virtuosos have been rate-limited...") -> AutoRun shows the
  pulsing recovery indicator with "Check Now" + Abort
recovery-poller tick (or accounts:check-recovery) -> throttled account window passed
  -> status=active -> 'account:recovery-available' {recoveredAccountIds}
  -> App.tsx resumes matching PAUSED_ERROR Auto Runs + toast
```

---

## 5. Validation and verification

### 5.1 Automated (CI)

Everything below runs in the standard pipeline (`npm run lint && npm run lint:eslint && npm test`). A branch is mergeable only when both CI matrix legs (ubuntu + windows) are green.

Unit test map for the feature:

| Area             | Test file                                                                                                                                         | Covers                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry         | `src/__tests__/main/accounts/account-registry.test.ts`                                                                                            | CRUD, defaults, rotation order, assignment normalization (suffixed process IDs), legacy-key migration, reconciliation, selection strategies, capacity scoring + throttle penalty, provider-scoped defaults/selection, switch config |
| Env injector     | `src/__tests__/main/accounts/account-env-injector.test.ts`                                                                                        | Agent-type guard, user env precedence, explicit/assignment/default/next resolution, credential auto-sync, assigned event, provider parity (CODEX_HOME/XDG_DATA_HOME injection, cross-provider isolation)                            |
| Setup            | `src/__tests__/main/accounts/account-setup.test.ts`                                                                                               | Discovery, dir creation + symlinks, validation/repair, login command, removal, provider parity (inferProviderFromDir, per-provider create/login/sync, base-dir protection)                                                          |
| Switcher         | `src/__tests__/main/accounts/account-switcher.test.ts` + `account-switcher-wiring.test.ts`                                                        | Kill/reassign/respawn sequence, kill-failure tolerance, prompt tracking, event payloads, IPC wiring                                                                                                                                 |
| Throttle handler | `src/__tests__/main/accounts/account-throttle-handler.test.ts`                                                                                    | Throttle recording, prompt vs auto mode, exhausted case, statsDB gating                                                                                                                                                             |
| Auth recovery    | `src/__tests__/main/accounts/account-auth-recovery.test.ts`                                                                                       | Login success/timeout/failure, credential-sync fallback, concurrent-recovery guard, spawn errors, status transitions                                                                                                                |
| Recovery poller  | `src/__tests__/main/accounts/account-recovery-poller.test.ts`                                                                                     | Tick cadence, window-passed reactivation, event payloads, start/stop                                                                                                                                                                |
| Window math      | `src/__tests__/main/accounts/account-utils.test.ts`                                                                                               | Midnight alignment, boundaries, cross-midnight windows, stability                                                                                                                                                                   |
| Error routing    | `src/__tests__/main/process-listeners/error-listener.test.ts`                                                                                     | auth_expired -> recovery, rate_limited -> throttle, recovery-unavailable fallback, no-assignment/no-deps no-ops, capability snapshot side effect                                                                                    |
| Usage listener   | `src/__tests__/main/process-listeners/account-usage-listener.test.ts`                                                                             | Window aggregation, warning/reached thresholds, percent capping, throttle auto-recovery, skip guards, error tolerance                                                                                                               |
| Stats queries    | `src/__tests__/main/stats/account-usage.test.ts`                                                                                                  | Upsert insert/accumulate branches, throttle marshaling, filter building, row mapping, chronological history                                                                                                                         |
| IPC handlers     | `src/__tests__/main/ipc/handlers/accounts.test.ts`                                                                                                | Channel registration, `accounts:check-recovery` behavior (poller present/absent/error)                                                                                                                                              |
| CLI reader       | `src/__tests__/cli/services/account-reader.test.ts`                                                                                               | Store discovery across platforms, account lookup, rotation                                                                                                                                                                          |
| Renderer         | `src/__tests__/renderer/components/AccountSelector.test.ts`, `AccountSwitchModal.test.ts`, `src/__tests__/renderer/hooks/useAccountUsage.test.ts` | Selector data flow, switch modal actions, usage metrics/prediction hook                                                                                                                                                             |
| Store wiring     | `src/__tests__/main/stores/instances.test.ts`                                                                                                     | accountStore creation (BOM-safe deserialize)                                                                                                                                                                                        |
| Dashboard        | `src/__tests__/renderer/components/UsageDashboard*.test.tsx`                                                                                      | Virtuosos tab presence/ordering                                                                                                                                                                                                     |

Known intentional gaps (UI-heavy, exercised manually): `AccountsPanel.tsx`, `VirtuososModal.tsx` (thin wrapper), `AccountUsageHistory.tsx`, `AccountUsageDashboard.tsx` internals, `src/cli/commands/accounts.ts` (print-only).

### 5.2 Manual validation checklist

Run with `npm run dev` (isolated data). Prereqs: a real Claude login in `~/.claude`, and the Virtuosos extension enabled (Settings -> Plugins -> Virtuosos) - with the flag off there is no Virtuosos menu entry, no selector, no badges, no injection, and `maestro-cli accounts` reports the feature as disabled.

Setup

- [ ] Hamburger menu -> Virtuosos opens the modal; "Discover existing" finds `~/.claude-*`, `~/.codex-*`, `~/.opencode-*` dirs plus single base dirs (`~/.codex`, `~/.gemini`, `~/.factory`); creating an account produces a provider-specific dir and a copyable login command (`CLAUDE_CONFIG_DIR=... claude login`, `CODEX_HOME=... codex login`, `XDG_DATA_HOME=... opencode auth login`).
- [ ] Create dropdown: Gemini CLI and Factory Droid options are disabled with "(import only)"; the hint text below explains Discover.
- [ ] Symlink validate/repair buttons behave on an intact and a broken dir.

Routing

- [ ] New claude-code agent auto-assigns the default account (badge next to toolType in the Left Bar; `account:assigned` sync).
- [ ] AccountSelector pill (AI toolbar) lists accounts with live usage; picking one on an idle agent reassigns WITHOUT respawning or re-sending anything; the next message uses the new dir (verify via Process Monitor detail -> Virtuoso field, or `ps eww <pid>` showing CLAUDE_CONFIG_DIR).
- [ ] Manual switch while a turn is running kills the in-flight process (no orphan on the old account).
- [ ] Agent with session-level `CLAUDE_CONFIG_DIR` in custom env vars: injector leaves it alone, no badge appears.
- [ ] Codex agent with a `~/.codex-*` account registered: selector appears, assignment works, `ps eww <pid>` shows CODEX_HOME; a claude-code agent NEVER gets offered the codex account (and vice versa).
- [ ] OpenCode agent with a `~/.opencode-*` account: spawn env carries XDG_DATA_HOME pointing at the account dir; `opencode auth login` under that env writes `<dir>/opencode/auth.json`.
- [ ] Gemini CLI / Factory Droid agent: no selector, no badge, no assignment (import-only providers).
- [ ] Restart the app: assignments survive, `accounts:reconcile-sessions` drops assignments for deleted agents only.

Usage and limits

- [ ] Send a few prompts; Usage Dashboard -> Virtuosos tab shows tokens in the current window; window boundaries align to local midnight intervals.
- [ ] Set a tiny `tokenLimitPerWindow` (for example 1000): warning toast at 80 percent, limit-reached at 95 percent.

Switching and recovery (simulated; enable auto-switching in the Virtuosos panel first, `switchConfig.enabled` defaults to off)

- [ ] With 2+ accounts and prompt mode on, force a rate_limited error (tiny limit or a mocked error): AccountSwitchModal appears; confirming kills, reassigns, respawns with `--resume`, and re-sends the interrupted prompt exactly once (Agent Resilience retry card must NOT also fire).
- [ ] Auto mode (promptBeforeSwitch off): same flow with no modal.
- [ ] Single account only: `account:throttled {noAlternatives}` pauses a running Auto Run with the pulsing "Waiting for virtuoso recovery" banner; "Check Now" triggers the poller; after the window passes the run auto-resumes.
- [ ] Auth expiry (corrupt `.credentials.json` in the account dir): recovery toast sequence fires, login or base-sync restores it, session resumes, stale error modal is cleared.

CLI parity

- [ ] `maestro-cli accounts` lists accounts with their provider. `maestro-cli playbook <id> --account <name>` runs every task under that dir; `--account-rotation` round-robins tasks (verify per-task env var in verbose output). Accounts are provider-scoped: `--account` naming another provider's account warns and is ignored; rotation only cycles accounts matching the session's agent.

### 5.3 Known limitations

- **SSH remotes:** the injected `CLAUDE_CONFIG_DIR` is a local path exported to the remote env. Matching account dirs must exist on the remote host (`accounts:validate-remote-dir` exists for pre-flight checks); there is no automatic remote provisioning.
- **CLI + custom sync path:** `account-reader.ts` probes default userData locations for `maestro-accounts.json`; a custom desktop sync path is invisible to the CLI.
- **Window model:** midnight-aligned windows approximate, not mirror, Anthropic's rolling quotas. Configured limits are advisory tripwires.
- **Gemini CLI / Factory Droid are import-only.** Gemini CLI has no config-dir override (google-gemini/gemini-cli#2815); Factory Droid keeps credentials in the OS keyring with no documented dir override. Both can be discovered/imported for badges, health, and usage tracking, but get no isolated accounts, no auto-switching, and no auth recovery. Revisit if the upstream CLIs ship an override.
- **OpenCode isolation rides on `XDG_DATA_HOME`.** The spawned opencode process (and its children) see the account dir as their XDG data root, so any XDG-aware tool opencode shells out to will also write its data there. Session-level `XDG_DATA_HOME` in custom env vars still wins over injection (same escape hatch as `CLAUDE_CONFIG_DIR`).
- **`switchConfig.enabled` defaults to OFF.** With it off, a throttled account still gets recorded and marked (and `account:throttled` fires with `autoSwitchAvailable: false`), but no switch is proposed or executed. Turn it on in the Virtuosos panel before testing the switch flows. Per-account `autoSwitchEnabled` further filters which accounts are eligible targets, and `promptBeforeSwitch` picks prompt vs auto mode.

---

## 6. Provider switching (Virtuosos vertical swapping)

Layered ON TOP of account multiplexing. The same `virtuosos` Encore flag gates BOTH layers: account multiplexing and these provider-level surfaces all appear together when the flag is turned on.

### 6.1 Modules

| Piece                   | File                                                                                                                                                                           | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error tracker           | `src/main/providers/provider-error-tracker.ts`                                                                                                                                 | Sliding-window counter of consecutive recoverable provider errors (`rate_limited`, `network_error`, `agent_crashed`, `auth_expired`) per session. `recordError()` is fed by the error listener; the ProcessManager `query-complete` event calls `clearSession()` so only CONSECUTIVE failures accumulate. At `errorThreshold` (default 3 in `errorWindowMs`, default 5m) it emits one `provider:failover-suggest` per window with the first configured fallback provider. Config live-updates via `store.onDidChange('providerSwitchConfig')`. |
| IPC                     | `src/main/ipc/handlers/providers.ts` + `src/main/preload/providers.ts`                                                                                                         | `providers:get-error-stats`, `get-all-error-stats`, `clear-session-errors`; `window.maestro.providers.*` + `onFailoverSuggest`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Switch orchestration    | `src/renderer/hooks/agent/useProviderSwitch.ts`                                                                                                                                | Grooms/extracts context from the source tab, then either creates a new session via `createMergedSession` (identity carry-over: name, nudge, bookmarks, SSH config, Auto Run folder; provenance: `migratedFromSessionId`, `migratedAt`, `migrationGeneration`) or, in merge-back mode, walks the provenance chain (`findArchivedPredecessor`) and reactivates the archived predecessor with the new context appended.                                                                                                                           |
| Modal                   | `src/renderer/components/SwitchProviderModal.tsx` (priority `PROVIDER_SWITCH`)                                                                                                 | Provider picker + groom/archive/merge-back options. Opened from the agent context menu ("Switch Provider...") or automatically by a failover suggestion.                                                                                                                                                                                                                                                                                                                                                                                       |
| Archive/unarchive       | `SessionItem.tsx` (dimmed row, "Archived (provider switched)" status) + `UnarchiveConflictModal.tsx`                                                                           | Switched-away sessions are parked, not deleted. Unarchive (context menu) restores them; a name+provider clash prompts archive-the-other or delete-the-other.                                                                                                                                                                                                                                                                                                                                                                                   |
| Observability           | `ProviderPanel.tsx`, `ProviderHealthCard.tsx`, `ProviderDetailView.tsx`, `ProviderDetailCharts.tsx`, `VirtuosoUsageView.tsx` + `useProviderHealth.ts` / `useProviderDetail.ts` | Providers tab in VirtuososModal: live health grid, failover config, per-provider detail with hourly charts (backed by the `byAgentByHour` stats aggregation).                                                                                                                                                                                                                                                                                                                                                                                  |
| Multi-provider accounts | `account-setup.ts` `PROVIDER_DISCOVERY` + `src/shared/accountProviderMeta.ts`                                                                                                  | Full multiplexing parity for codex (`CODEX_HOME`) and opencode (`XDG_DATA_HOME`); discovery scans `~/.codex-*`/`~/.opencode-*` prefixes plus `~/.codex`, `~/.opencode`, `~/.gemini`, `~/.factory` with provider-specific auth detection; AccountsPanel groups accounts by provider and gates the create flow per provider (see section 2.3).                                                                                                                                                                                                   |

### 6.2 Failover flow

```
consecutive provider errors -> error-listener feeds tracker (account routing unaffected)
  -> threshold reached -> 'provider:failover-suggest' {suggestedProvider, recentErrors}
  -> App.tsx (encoreFeatures.virtuosos): warning toast + opens SwitchProviderModal
     pre-scoped to the suggested fallback
  -> user confirms -> useProviderSwitch: groom -> new/merge-back session -> archive source
  -> providers.clearSessionErrors(source) -> navigate to the new session
query-complete on any session -> tracker.clearSession (resets its consecutive count)
```

Coordination notes:

- The tracker only OBSERVES errors; account-level routing (throttle switch, auth recovery) still runs first and usually resolves rate limits by switching accounts. Provider failover matters when a provider fails across accounts (outage, crash loops).
- Provider switching creates a NEW session (or reactivates an archived one) - it never respawns in place, so it does not interact with the account switcher's kill/respawn path.
- Manual entry point: agent context menu -> "Switch Provider..." (non-terminal agents, flag on). Archived agents get "Unarchive" instead.

### 6.3 Tests

`src/main/providers/__tests__/provider-error-tracker.test.ts` (21: thresholds, windowing, per-session isolation, suggestion payloads, config updates), `src/renderer/hooks/agent/__tests__/useProviderSwitch.test.ts` (13: switch orchestration, merge-back chain walking, identity carry-over), `src/__tests__/renderer/hooks/useProviderHealth.test.ts` (13: health status derivation, failover threshold config, event subscription).

### 6.4 Manual validation additions

- [ ] Enable the Virtuosos extension (Settings -> Plugins). "Switch Provider..." appears in agent context menus; Providers tab appears in the Virtuosos modal.
- [ ] Manual switch: pick a target provider, confirm groomed context arrives in the new session, source dims to "Archived (provider switched)", unarchive restores it (conflict modal on name+provider clash).
- [ ] Merge-back: switch A->B, then from B switch back to A with merge-back: the archived A session reactivates (no third session) with the B context appended.
- [ ] Failover: with `providerSwitchConfig.enabled` + a fallback list, force 3 consecutive errors on one provider: warning toast + modal opens pre-scoped; a successful turn in between resets the count.
- [ ] Multi-provider discovery: with `~/.codex` or `~/.gemini` present, Discover lists them under provider-grouped headers.
