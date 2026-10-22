# CLAUDE-AGENTS.md

Agent support documentation for the Maestro codebase. For the main guide, see [[CLAUDE.md]]. For detailed integration instructions, see [PROVIDER-SUPPORT.md](PROVIDER-SUPPORT.md).

## Provider switching and translation

The Ensemble plugin and composer provider selector have been removed. Change the agent default in Edit Agent. Preserve existing tab provider pins, captured turn ownership and parked native sessions for compatibility; native translation before sending and its warning review remain intact.

A committed native translation adds a **Context translated from ...** marker to the transcript. `ContextTranslationCard` discloses the source and destination versions, verification status, record/resource counts, and accepted limitations. The marker stays separate from subsequent replies and survives transcript persistence.

Changing the agent's default provider in Edit Agent is a plain switch unless **Convert memory and session history** is checked. Plain switching parks native sessions across open and retained tabs through `switchAgentProvider()` and `mapAgentAiTabs()`; explicitly pinned tabs keep their provider. Conversions retain the reviewed-plan and limitation-acceptance controls. Keep `projectResourcesIntoRepo` and `convertProviderHistory` as separate save arguments so opting into conversion does not install resources into the project.

## Supported Agents

| ID              | Name            | Status     | Notes                                                                                                                                                                                   |
| --------------- | --------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code`   | Claude Code     | **Active** | Primary agent, `--print --verbose --output-format stream-json`                                                                                                                          |
| `codex`         | Codex           | **Active** | Full support, `--json`, YOLO mode default                                                                                                                                               |
| `opencode`      | OpenCode        | **Active** | Multi-provider support (75+ LLMs), stub provider session storage                                                                                                                        |
| `factory-droid` | Factory Droid   | **Active** | Factory's AI coding assistant, `-o stream-json`                                                                                                                                         |
| `copilot-cli`   | Copilot-CLI     | **Beta**   | `-p/--prompt`, `--output-format json`, `--resume`, `@image` mentions, permission filters, reasoning stream, models.dev model picker                                                     |
| `grok`          | Grok CLI        | **Beta**   | `-p` headless, `--output-format streaming-json` (JSONL), `--resume`, `--permission-mode plan`, thought/text deltas, models_cache.json model picker                                      |
| `antigravity`   | Antigravity CLI | **Beta**   | `agy -p`, `--output-format stream-json`, `--conversation <id>`, `--model` / `--effort`, 30m `--print-timeout`, thinking, exit codes, and History from its SQLite stores, images by path |
| `qwen3-coder`   | Qwen3 Coder     | **Beta**   | Gemini CLI fork, stream-json headless interface, `--resume`                                                                                                                             |
| `hermes`        | Hermes          | **Beta**   | Nous Research's coding agent                                                                                                                                                            |
| `pi`            | Pi              | **Beta**   | Bring-your-own agent harness                                                                                                                                                            |
| `omp`           | Oh My Pi        | **Beta**   | Multi-model coding agent; prompt must be a positional arg, never stdin                                                                                                                  |
| `terminal`      | Terminal        | Internal   | Hidden from UI, used for shell sessions                                                                                                                                                 |

## Agent Capabilities

Each agent declares capabilities that control UI feature availability. See `src/main/agents/capabilities.ts` for the full interface (24 boolean flags + 1 optional). The table below shows key capabilities; see [PROVIDER-SUPPORT.md](PROVIDER-SUPPORT.md) for the complete list.

| Capability                    | Description                              | UI Feature Controlled      |
| ----------------------------- | ---------------------------------------- | -------------------------- |
| `supportsResume`              | Can resume previous conversations        | Resume button              |
| `supportsReadOnlyMode`        | Has plan/read-only mode                  | Read-only toggle           |
| `supportsJsonOutput`          | Emits structured JSON                    | Output parsing             |
| `supportsSessionId`           | Emits provider session ID                | Session ID pill            |
| `supportsImageInput`          | Accepts image attachments                | Attach image button        |
| `supportsImageInputOnResume`  | Accepts images when resuming             | Attach button on resume    |
| `supportsSlashCommands`       | Has discoverable commands                | Slash autocomplete         |
| `supportsSessionStorage`      | Persists browsable provider sessions     | Sessions browser           |
| `supportsCostTracking`        | Reports token costs                      | Cost widget                |
| `supportsUsageStats`          | Reports token counts                     | Context window widget      |
| `supportsBatchMode`           | Runs per-message                         | Batch processing           |
| `requiresPromptToStart`       | No eager spawn - needs prompt            | Deferred spawn             |
| `supportsStreaming`           | Streams output                           | Real-time display          |
| `supportsModelSelection`      | Supports --model flag                    | Model dropdown             |
| `supportsResultMessages`      | Distinguishes final result               | Message classification     |
| `supportsThinkingDisplay`     | Emits thinking/reasoning content         | Thinking panel             |
| `supportsContextMerge`        | Can receive merged context               | Merge option               |
| `supportsContextExport`       | Can export context                       | Export option              |
| `supportsWizard`              | Supports inline wizard structured output | Wizard agent selection     |
| `supportsGroupChatModeration` | Can serve as group chat moderator        | Moderator dropdown         |
| `usesJsonLineOutput`          | Uses JSONL output in batch mode          | CLI batch parsing strategy |
| `usesCombinedContextWindow`   | Uses combined input+output context       | Context bar display mode   |
| `supportsStreamJsonInput`     | Accepts stream-json input via stdin      | Image input method         |
| `supportsPromptViaStdin`      | CLI reads the prompt from stdin          | Windows prompt delivery    |
| `imageResumeMode?`            | Image handling on resume (optional)      | Resume image strategy      |

### Accessing Capabilities

| Context             | Function                                   | Import                                             |
| ------------------- | ------------------------------------------ | -------------------------------------------------- |
| Main process        | `hasCapability(agentId, 'flagName')`       | `src/main/agents/capabilities.ts`                  |
| Renderer callbacks  | `hasCapabilityCached(agentId, 'flagName')` | `src/renderer/hooks/agent/useAgentCapabilities.ts` |
| Renderer components | `useAgentCapabilities(toolType)` hook      | Same file                                          |

### Display Names & Beta Classification

Centralized in `src/shared/agentMetadata.ts` (importable from any process):

- `getAgentDisplayName(agentId)` - human-readable name with fallback
- `isBetaAgent(agentId)` - beta badge check
- `getAgentLoginCommand(agentId, customPath?)` - the shell command that re-authenticates the provider
- `getAgentPickerMeta(agentId)` / `PICKABLE_AGENT_IDS` - which providers a user may choose, and how they present

The backing data (`AGENT_DISPLAY_NAMES` record, `BETA_AGENTS` set) is module-private. Use the functions above to access it.

### Provider Pickers: One Registry, Three Surfaces

Maestro asks the user to choose a provider in three places, and all three read
`AGENT_PICKER_META` in `src/shared/agentMetadata.ts`:

| Surface                       | Reads                                                     |
| ----------------------------- | --------------------------------------------------------- |
| New Agent modal               | `SUPPORTED_AGENTS` (re-exports `PICKABLE_AGENT_IDS`)      |
| New Agent Wizard tile strip   | `AGENT_TILES` (derived from `AGENT_PICKER_META`)          |
| Group Chat moderator dropdown | `AGENT_TILES`, filtered by what detection found installed |

The record is keyed by `AgentId`, so a new id does not compile until it is either
given picker metadata or explicitly set to `null`. Before that was true, the
three lists were hand-written and drifted: Grok and Qwen3 Coder were selectable
in the New Agent modal for months while being absent from the wizard and
un-pickable as a group chat moderator.

**Order and default are two different things.** `PICKABLE_AGENT_IDS` sorts the
record by display name, so all three surfaces render one alphabetical list and a
provider sits where the user expects no matter which one they open. The record's
key order is therefore irrelevant - put a new entry anywhere. What a picker
auto-selects comes from `AGENT_AUTOSELECT_ORDER` instead: a preference list whose
first installed entry wins. Defaulting to the head of the alphabetical list would
hand a fresh Group Chat to Antigravity CLI.

Note that the `supportsGroupChatModeration` capability flag is advisory - the
moderator dropdown does not filter on it, and offers any installed provider.

## Agent-Specific Details

### Claude Code

- **Binary:** `claude`
- **JSON Output:** `--output-format stream-json`
- **Resume:** `--resume <session-id>`
- **Read-only:** `--permission-mode plan`
- **Standard mode:** permission relay (`--permission-prompt-tool` + `--mcp-config`), also carries `AskUserQuestion` ask-backs; absent in full/read-only/SSH/interactive (TUI wrapper) paths
- **Session Storage:** `~/.claude/projects/<encoded-path>/`

### Codex

- **Binary:** `codex`
- **JSON Output:** `--json`
- **Batch Mode:** `exec` subcommand
- **Resume:** `resume <thread_id>` (v0.30.0+)
- **Read-only:** `--sandbox read-only`
- **YOLO Mode:** `--dangerously-bypass-approvals-and-sandbox` (enabled by default)
- **Session Storage:** `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
- **Tool Display:** `exec --json` items `command_execution` (the `/bin/zsh -lc '...'` wrapper is unwrapped to the real command; a non-zero exit or `status: failed` is a failed badge), `file_change` (`apply_patch`, one line per file), `mcp_tool_call` (`mcp__server__tool`), `web_search`, and `todo_list` (`update_plan` checklist)

### OpenCode

- **Binary:** `opencode`
- **JSON Output:** `--format json`
- **Batch Mode:** `run` subcommand
- **Resume:** `--session <session-id>`
- **Read-only:** `--agent plan`
- **YOLO Mode:** Auto-enabled in batch mode (no flag needed)
- **Multi-Provider:** Supports 75+ LLMs including Ollama, LM Studio, llama.cpp

### Copilot-CLI

- **Agent ID:** `copilot-cli`
- **Binary:** `copilot`
- **JSON Output:** `--output-format json`
- **Batch Mode:** `-p, --prompt <text>`
- **Resume:** `--continue`, `--resume[=session-id]`
- **Read-only:** CLI-enforced via `--allow-tool=read,url`, `--deny-tool=write,shell,memory,github`, `--no-ask-user`
- **Thinking Display:** Streams `assistant.reasoning_delta` / `assistant.reasoning` into Maestro's thinking panel
- **Images:** Prompt-embedded `@/tmp/...` mentions (maps Maestro uploads to Copilot file/image mentions)
- **Session Storage:** `~/.copilot/session-state/<session-id>/` (local and SSH-remote)
- **Model Discovery:** Fetches available models from [models.dev](https://models.dev) (github-copilot provider) with a 3s timeout, falling back to the user's configured model in `~/.copilot/config.json`. See `readCopilotConfiguredModel` / `fetchCopilotModelsFromApi` in `src/main/agents/detector.ts`.
- **Known Limitations:**
  - **SSH interactive mode:** PTY-based interactive Copilot sessions do not go through `wrapSpawnWithSsh()`, so interactive Copilot over SSH remote is not supported. Batch mode (`-p`) over SSH works correctly via the standard child-process spawner.

### Grok CLI

- **Binary:** `grok`
- **JSON Output:** `--output-format streaming-json` (JSONL: `thought`, `text`, `tool_call`, `tool_call_update`, `end`, `error` events)
- **Batch Mode:** `-p/--single <prompt>` (headless, no subcommand)
- **Resume:** `--resume <session-id>` (session ID is a UUIDv7, emitted only on the final `end` event)
- **Read-only:** `--permission-mode plan` (CLI-enforced)
- **YOLO Mode:** `--always-approve` (also used for batch mode)
- **Thinking Display:** Streams `thought` deltas into Maestro's thinking panel
- **Session Storage:** `~/.grok/sessions/<percent-encoded-cwd>/<session-uuid>/` (local and SSH-remote)
- **Model Discovery:** Reads `~/.grok/models_cache.json` (grok-4.5 at 500K context, grok-composer-2.5-fast at 200K), with a static fallback list
- **Reasoning Effort:** `--reasoning-effort` with none, minimal, low, medium, high, xhigh, max (grok-4.5 rejects `none`)
- **Tool Display:** `tool_call` / `tool_call_update` become tool badges. Output comes from the ACP `content` blocks (shell text, file contents, edit diffs), never the raw `rawOutput` object, and a non-zero `exit_code` marks the call failed even though grok reports `completed`
- **Images:** The temp image path is named in the prompt (`imagePromptBuilder`) and grok opens it with `read_file`; there is no attachment flag
- **Usage and Cost:** grok 1.x reports a `usage` line per model call and the turn's totals plus `total_cost_usd` on `end`; only `end` is reported (usage events are summed), with the last call as `absoluteUsage`. History reads `usage.json`
- **Known Limitations:**
  - **Batch-only:** interactive PTY mode is not wired (same posture as Codex)

## Adding New Agents

To add support for a new agent:

1. Add agent ID to `src/shared/agentIds.ts` → `AGENT_IDS` tuple
2. Add agent definition to `src/main/agents/definitions.ts` → `AGENT_DEFINITIONS`
3. Define capabilities in `src/main/agents/capabilities.ts` → `AGENT_CAPABILITIES` (24 boolean flags)
4. Add display name and beta status to `src/shared/agentMetadata.ts` (internal maps, accessed via `getAgentDisplayName()` / `isBetaAgent()`)
5. Add context window default to `src/shared/agentConstants.ts` → `DEFAULT_CONTEXT_WINDOWS`
6. **Register it in the pickers**: add an entry to `AGENT_PICKER_META` in `src/shared/agentMetadata.ts`, or `null` to withhold it. This is what makes the provider appear in the New Agent modal, the wizard tile strip, and the Group Chat moderator dropdown
7. Add a re-auth command to `AGENT_LOGIN_COMMANDS` in `src/shared/agentMetadata.ts`
8. Draw the tile logo: a `case` in `AgentSelectionScreen/components/AgentLogo.tsx`, plus a glyph in `src/renderer/constants/agentIcons.ts`
9. Add install locations to `src/main/agents/path-prober.ts` if the binary does not always land on `$PATH`
10. Sync `AgentCapabilities` interface in renderer: `useAgentCapabilities.ts`, `types/index.ts`, `global.d.ts`
11. (If `supportsJsonOutput`) Create output parser in `src/main/parsers/{agent}-output-parser.ts`, register in `src/main/parsers/index.ts`
12. (If `supportsSessionStorage`) Create session storage extending `BaseSessionStorage` in `src/main/storage/`
13. (If the agent has an output parser) Add error patterns to `src/shared/agentErrorPatterns.ts` - required, not optional: `agent-completeness.test.ts` fails CI when a registered parser has no patterns. The bank is shared so the renderer wizard classifies through the same patterns; `src/main/parsers/error-patterns.ts` is the main-process face of it
14. **Declare provider translation support or its explicit limits**: follow [Provider Translation Contract](PROVIDER-SUPPORT.md#provider-translation-contract) for native session import/export, memory discovery, skill/subagent projection, incremental sync, and directional/versioned validation. A History reader or resume flag alone does not qualify a provider for warning-free switching.

Translation registration lives in `src/shared/maestro-lib/translation/adapters.ts` (`createTranslationRegistry`). Implement `TranslationAdapter.extract`/`stage`, declare each direction's source/destination minimum and tested versions, and use `planTranslation`/`applyTranslation`/`recoverTranslation` through the shared host service. Status (2026-10-17): Claude Code `2.1.296` -> Codex `0.162.1` and Codex `0.162.1` -> Claude Code `2.1.296` remain unverified. These are the minimum versions and initial declared synthetic schema-coverage versions. Isolated live QA on Claude Code 2.1.302 and Codex 0.163.0 verified conversation recall in both directions and access to carried project resource definitions. Execution continuity and repeated incremental synchronization remain uncertified; both directions remain unverified. Project knowledge and explicitly selected user resources are the scope; account-global imports and file-write-only certification are excluded. See the [implemented contract](PROVIDER-SUPPORT.md#implemented-entry-points-and-registration).

Use `planTabTranslation()` / `applyTabTranslation()` for exactly one tab, with `TranslationRequest.tabId` on the existing migration channel. They share the agent-wide archive, checkpoint, resource reconciliation, journal and recovery; other tabs, defaults and queued snapshots stay intact. Agent-wide switches translate open `aiTabs` only and park the remaining identities with `pendingTranslation`. Edit Agent and CLI dry-run show counts for "Translated now" and "Translated on next use". Reopening, waking and History resume do no native translation.

Desktop direct sends and queue processing call `prepareProviderTranslationForSend()`, which wraps the same `prepareTabForSend()` gate that headless `createRuntimeTurns()` uses. Native work lives in `NativeTranslationService`, with thin desktop/runtime hosts. A pending source is imported before resume, even if the destination already has an older native session. Preserve the provider/model/effort captured when sending or queuing. Live source turns defer; new warnings and blocks hold the message for review without losing it. Reuse `translationWarningsAccepted()` for direction/version-bound warning acceptance and the `review-translation` toast action for tab-specific review. See [tab scope and translate-at-send](PROVIDER-SUPPORT.md#tab-scope-and-translate-at-send).

Reuse `translationVersionLimitation()` from `translation/support.ts`: invalid semver or a version below `minVersion` blocks with `unknown-version`; a version at or above the minimum but absent from `testedVersions` warns with `untested-version`, naming the installed and tested versions. A certified direction remains unverified for untested versions. Tested versions describe schema coverage, not native certification; per-record schema blocks still apply.

Translation previews count user/assistant messages separately from native records. Context capacity uses the destination's saved context-window override, model limit, provider configuration, then provider fallback. A serialized-size estimate above that capacity adds a `context-capacity` warning for review; it does not block translation or truncate history.

Keep picker hints and native registration on the renderer-safe declarations in `src/shared/maestro-lib/translation/support.ts`. Edit Agent marks declared destinations with a memory/history preview indicator, reads preflight on selection, and applies migration on Save Changes with activity status. The indicator does not bypass version checks or certify native resume.

SSH translation selects `resolveSshTranslationHost()` and `createSshTranslationFs()` before native access. The native host resolves remote identity and discovery; its shared `TranslationFs` port handles native reads/writes, readback and rollback; archives, checkpoints, journals and process locks stay local. An unresolved remote fails without local fallback. Remote prerequisites include supported provider binaries, POSIX `sh`, `base64 -d`, `realpath` or working `readlink -f`, Git and GNU/BSD filesystem tools. Only the Codex import channel uses remote `codex app-server` with a pinned destination `CODEX_HOME`; ordinary SSH turns stay on `codex exec`. See [SSH boundaries and prerequisites](PROVIDER-SUPPORT.md#ssh-translation-boundaries-and-prerequisites).

Remote knowledge launch bindings require the saved SSH config fingerprint and home through `MAESTRO_TRANSLATION_KNOWLEDGE_REMOTE`; local or mismatched hosts cannot use them. **2026-10-17: SSH live check skipped** under the explicit acceptance input. Both SSH directions remain unverified and native certification is deferred. Fake-remote regression cases were authored and statically checked, not executed; the evidence ledger is [[Plans/provider-translation-layer]].

Managed knowledge stays outside the project: `<userData>/provider-knowledge/<agent-hash>/<operation-id>/` for local agents, or `<remote HOME>/.maestro/provider-knowledge/<agent-hash>/<operation-id>/` for SSH agents. The host supplies `TranslationTransactionHost.knowledgeRoot`; shared launches validate the operation directory against their trusted root and bind `knowledge-index.md` through `MAESTRO_TRANSLATION_KNOWLEDGE`. Claude also receives `--add-dir` and per-launch memory settings. Reuse the existing Memory Viewer. File access does not certify recall.

`TranslationScope.projectResourcesIntoRepo` defaults to false for each switch. Without opt-in, `resource-not-projected` lists omitted instruction aliases, skills and subagents as info while their bytes remain in managed knowledge. Edit Agent's unchecked "Also install skills and subagents into the project (git-excluded)" checkbox and CLI `update-agent <id> --provider <type> --project-resources` call the same migration service. Opt-in writes native resources and journals a Maestro-marked block of repository-relative paths in `<git common dir>/info/exclude`; rollback removes its own entries while preserving later user entries. This repository-local ignore file lives on the provider host and does not untrack existing files. Non-Git projects install with a `resource-git-exclude-unavailable` info note and no exclude edit.

Native extraction checks project ownership at the session origin: the first Claude row with `cwd` or Codex `session_meta.payload.cwd`. Reuse `isPathAtOrUnderRoot()` on paths resolved through the selected native filesystem; origins equal to or inside `identity.projectRoot` are allowed, and outside origins block with `native-project-root-mismatch`. Later cwd changes produce one `native-cwd-drift` info entry per conversation, including moves outside the project; original directories remain source evidence.

Compaction carries the source provider's own latest summary plus later records; Maestro never writes a summary itself. Claude starts at the first `isCompactSummary: true` user row after the last `compact_boundary`. Codex carries the last `compacted.payload.replacement_history` when non-empty, otherwise its legacy `message` summary, then later Responses items. Earlier records remain archive-only with original bytes and checkpoint identities intact. Reuse `activeContextRecords()` from `translation/context-window.ts` for projection, capacity and plan counts; unmarked legacy records remain active. `compaction-window` reports active/archive counts as info, while real branches and sidechains still warn with `native-boundary`. Missing latest summary/history blocks. See [[Plans/provider-translation-native-formats]] for mapping and return-hop behavior.

Reuse native extraction's tool-link validation within the active window: duplicate calls/results, results preceding their calls, missing linkage and invalid message roles block staging. An unanswered call before later user/assistant conversational content still blocks with `unfinished-tool-call`. Trailing unanswered calls retain their portable/native evidence with `interrupted: true`; `projectConversation` omits them from the destination and emits no fabricated result. Extraction adds `interrupted-tool-call-dropped` as a warning naming the call IDs. Tool-only rows and runtime metadata do not advance the conversation. Preserve completed parallel calls and surrounding text; busy source turns still defer before extraction.

Use `limitationsNeedingAcceptance()` from `translation/index.ts` for all acceptance gates. Severity `info` needs no acceptance, `warning` requires review and `block` prevents translation; only blocks drive blocked plan status. Recurring `opaque-runtime-state`, `native-attachment-state`, `historical-instructions` and `native-cwd-drift` entries are info. Possible data or behavior loss and unverified native resume remain warnings. Edit Agent puts info in collapsed Notes; CLI prints `Notes:` separately from warnings.

Reuse selected-root validation for native targets and resource links. Persist the staged destination checkpoint before mapping commit; recovery must preserve later native work and settle the previous operation before another migration. Reuse `commitTranslationSession` to reject changed native source IDs across open/closed tabs and the saved inventory while permitting already applied destination mappings.

Apply `assertTranslationTarget` to native transcript reads and rechecks, not only writes. Confine return-trip managed knowledge to the host's trusted knowledge root and owned native projections to the project. Old `.maestro/provider-knowledge/<agent-hash>/<operation-id>/` journals remain recoverable and reversible with project-root checks, but cannot authorize new writes or launch bindings. Retain link evidence without importing unselected account bodies, and include managed collection limitations in preflight.

Recovery/rollback may mutate only the current operation; historical status is read only. Committed journals cannot be rolled back after another switch. Build import-channel environments with the destination's shared launch resolver and pin the selected account root. Start the channel only for ready plans with no warnings or accepted warnings; info-only plans need no acceptance flag.

Direct `applyTranslation` retries return the saved committed result or refuse existing staging evidence without writes. Use recovery/rollback for non-planned operations or journals with native mappings/writes; never replay an uncertain import.

The host retains the reviewed `planId` on apply after a fresh fingerprint check. It returns a saved committed result only for the current, settled operation; historical retries and unfinished staging require status or recovery rather than a new import.

Journal creation intent separately from confirmed exclusive ownership; rollback must retain unowned collisions and dangling links. Archive and validate all projection/write/mapping backups on write and reload; direct library rollback validates every backup hash before any target mutation. Validate absent rollback targets against the selected root before restoring backups, and restore missing files only for journaled deletions. Keep migration replies open through the CLI/web bridge, and treat a reply timeout as uncertain completion requiring status inspection.

Resume saved turn deferrals through the shared renderer client, preserving their warning acceptance. Store and compare only complete warning entries with `canonicalJson`, including tab, artifact, severity and message. New or changed warnings and legacy code/artifact-only acceptance require renewed review when warnings remain. Info changes do not require review; deferrals without warnings need no acceptance flag.

The host emits one `provider-translation-plan` Sentry info event per built plan through the existing `captureMessage()` utility. Its extra fields are exactly `sourceProvider`, `destinationProvider`, `sourceVersion`, `destinationVersion`, `status`, `verification` and `limitationCounts` (code counts grouped by `info`/`warning`/`block`). Exclude messages, paths, tab/session/agent IDs and content. Plan telemetry does not certify a completed migration or native resume.

The `agent-completeness.test.ts` CI test will fail if required steps are missed. See [PROVIDER-SUPPORT.md](PROVIDER-SUPPORT.md) for comprehensive integration documentation.
