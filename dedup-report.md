# Maestro Code Deduplication and Cleanup Audit

**Updated:** 2026-07-14  
**Scope:** `src/main`, `src/renderer`, `src/shared`, `src/web`, `src/web-desktop`, `src/cli`, `src/maestro-p`, `packages`, `scripts`, `e2e`, and root build configuration  
**Method:** Read-only static analysis by default Task agents (`nan/qwen3.6`), followed by parent reconciliation and targeted source checks  
**Repository changes during audit:** None, except this report

## Purpose

This is the canonical inventory of Maestro duplication, cleanup candidates, rejected abstractions, and structural hotspots. It separates literal duplication from migration work and large-file refactors so that unrelated cleanup does not become one risky rewrite.

## Verdicts

- **Confirmed:** Source evidence establishes equivalent behavior and a clear canonical implementation.
- **Verify then change:** Likely cleanup, but a targeted build, runtime scenario, reference check, or packaging check is required first.
- **Migration:** Still-live behavior that may eventually be removed only through an explicit compatibility migration.
- **Retain:** Similar code has materially different contracts, or abstraction cost exceeds duplication.
- **Structural:** A maintainability hotspot, not duplicate or dead code.

# 1. Confirmed Duplication and Drift

## 1.1 Pianola CLI helpers

### `ensurePianolaEnabled`

- Canonical: `src/cli/commands/pianola.ts:86`
- Duplicate: `src/cli/commands/pianola-orchestrate.ts:96`
- Evidence: Byte-identical behavior and error envelope. `pianola-learn.ts`, `pianola-profile.ts`, and `pianola-supervise.ts` already import the canonical export.
- Circular-import risk: None found.
- Verdict: **Confirmed**.

### `pianolaEnabledNow`

- Locations: `pianola.ts:103`, `pianola-orchestrate.ts:112`
- Evidence: Byte-identical polling-time feature check.
- Verdict: **Confirmed**.

### `parseIntervalSeconds`

- Locations: `pianola.ts:137`, `pianola-orchestrate.ts:171`
- Evidence: Byte-identical parser, default, suffix handling, and minimum.
- Verdict: **Confirmed**.

### `sleep`

- Locations: `pianola.ts:144`, `pianola-orchestrate.ts:186`, `src/cli/services/agent-busy.ts:103`
- Evidence: Byte-identical `setTimeout` promise wrapper.
- Verdict: **Confirmed, low value**. Consolidate only with the larger Pianola helper change.

### Retained Pianola lookalikes

Keep `parsePositiveInt`, `parseConcurrency`, localized `fail` closures, plan/profile input readers, `POLL_TAIL`, and `HISTORY_TAIL`. Their defaults, accepted formats, return contracts, captured context, or operational purposes differ.

## 1.2 Wizard filename sanitizer

- Locations:
  - `src/renderer/components/Wizard/services/phaseGenerator.ts:179`
  - `src/renderer/services/inlineWizardDocumentGeneration.ts:229`
- Evidence: Byte-identical 16-line sanitizer and fallback behavior; exactly two direct callers.
- Canonical: `inlineWizardDocumentGeneration.ts`, which `phaseGenerator.ts` already imports.
- Verdict: **Confirmed**.

## 1.3 Main-process storage helpers

### `MAX_SESSION_FILE_SIZE`

- Locations: `src/main/storage/claude-session-storage.ts`, `codex-session-storage.ts`
- Evidence: Identical `100 * 1024 * 1024` constant used for session-file bounds.
- Verdict: **Confirmed, small**.

### JSON file helpers

- Locations: `opencode-session-storage.ts`, `factory-droid-session-storage.ts`
- Evidence: Equivalent `fs.readFile` + `JSON.parse` + `null`-on-failure helpers.
- Canonical: A protected/static helper on `BaseSessionStorage` or a storage-local shared utility.
- Verdict: **Confirmed**.

### `ACCOUNT_DIR_EXCLUDE_RE` (RETRACTED from storage)

- Locations: `src/main/agents/claude-usage-startup.ts:98`, `src/main/agents/codex-usage-startup.ts:39`
- Evidence: Byte-identical regex (`/(^|[-_.])(backup|bak|old|archive|archived|stage|local|server)([-_.]|$)/i`) used in both Claude and Codex account-directory discovery.
- The original claim that it lives in `claude-session-storage.ts` and `factory-droid-session-storage.ts` is false — neither file contains this symbol.
- Verdict: **Confirmed** (but in the agents domain, not storage).

## 1.4 Cross-runtime wire contracts

Wire contracts used by server and web clients should live in `src/shared`, not in `src/main/web-server` and not in a renderer hook.

### Exact or near-exact duplicates

| Contract                                  | Current locations                                                                          | Verdict                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `AutoRunState`                            | `src/main/preload/web.ts`, `src/main/web-server/types.ts`, `src/web/hooks/useWebSocket.ts` | Confirmed three-way duplicate                                            |
| `LiveSessionInfo`                         | `web-server/types.ts`, `web-server/handlers/messageHandlers.ts`                            | Confirmed exact duplicate                                                |
| `WebClient`                               | `web-server/types.ts`, `messageHandlers.ts`                                                | Confirmed exact duplicate; keep server-only because it contains a socket |
| `WebClientMessage`                        | `web-server/types.ts`, `messageHandlers.ts`                                                | Confirmed; handler version is a strict superset                          |
| `CustomAICommand` / `CustomCommand`       | `web-server/types.ts`, `useWebSocket.ts`                                                   | Confirmed shape duplicate                                                |
| `CueSubscriptionInfo`, `CueActivityEntry` | `web-server/types.ts`, `src/web/hooks/useCue.ts`                                           | Confirmed exact duplicates                                               |
| `AITabData`                               | `web-server/types.ts`, `useWebSocket.ts`                                                   | Confirmed exact duplicate                                                |
| `SessionData`                             | `web-server/types.ts`, `useWebSocket.ts`                                                   | Confirmed; web client adds `autoRunFolderPath`                           |
| Git status/diff result types              | `web-server/types.ts`, `src/web/hooks/useGitStatus.ts`                                     | Confirmed exact duplicates                                               |
| `AutoRunDocument`                         | `web-server/types.ts`, `src/web/hooks/useAutoRun.ts`                                       | Confirmed exact duplicate                                                |
| `GroupChatParticipant`                    | `src/shared/group-chat-types.ts`, `src/main/group-chat/group-chat-storage.ts`              | Confirmed duplicate                                                      |
| Group-chat log message                    | `shared/group-chat-types.ts`, `main/group-chat/group-chat-log.ts`                          | Confirmed duplicate                                                      |
| `GroupChat` storage shape                 | shared model plus extra filesystem fields in `group-chat-storage.ts`                       | Use composition, not copied fields                                       |

### Dependency direction

- Put serializable, genuinely shared protocol types in a dedicated `src/shared/web-protocol.ts` or equivalent domain modules.
- Main server and web client import from shared.
- Keep socket-bearing `WebClient` and other server-runtime types in `src/main`.
- Do not make `src/web` import canonical contracts from `src/main/web-server`.

## 1.5 Renderer settings components

### Toggle rows and keyboard behavior

- General settings sections repeatedly hand-roll clickable rows, `role="button"`, `tabIndex`, Enter/Space handling, and `ToggleSwitch`.
- Existing canonical component: Display settings `ToggleSettingRow`.
- Affected areas include rendering, power, tab behavior, updates, auto-resume, storage, input behavior, and browser settings sections.
- Estimated repeated interaction markup: 150–250 lines.
- Verdict: **Confirmed**. Reuse the established accessible row component where contracts match.

### Settings section headings

- General settings sections repeat uppercase/icon heading markup.
- Existing canonical component: `src/renderer/components/Settings/SettingsSectionHeading.tsx`.
- Verdict: **Confirmed**.

### `SectionCard`

- A simple Display settings card and a feature-rich widgets/output card have related names but different current contracts.
- Verdict: **Verify then change**. Prefer a settings-specific shared card unless making the widget title optional remains semantically clean for every consumer.

## 1.6 Settings defaults drift

| Setting                   | Main/shared                                                                            | Renderer                                            | Decision                                                    |
| ------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------- |
| `defaultShell`            | Main respects `$SHELL` and uses macOS zsh fallback; metadata always falls back to bash | Windows PowerShell, otherwise zsh; ignores `$SHELL` | Create one platform-aware shared resolver                   |
| `sshRemoteIgnorePatterns` | `['.git', '.*cache*']`                                                                 | `['.git', '*cache*']`                               | Align to one documented glob contract                       |
| `sshRemoteHonorGitignore` | `false`                                                                                | `true`                                              | Select and document one default                             |
| `useNativeTitleBar`       | Metadata `false`                                                                       | Windows-dependent                                   | Align CLI metadata and renderer behavior                    |
| `customThemeColors`       | Metadata `{}`                                                                          | Dracula colors                                      | Decide whether empty or materialized defaults are canonical |
| `fileExplorerMaxDepth`    | Missing metadata                                                                       | Renderer default exists                             | Add metadata or explicitly mark internal                    |
| `customAICommands`        | Missing metadata                                                                       | Renderer default exists                             | Add metadata or explicitly mark internal                    |

Verdict: **Confirmed drift**. Do not patch values independently; establish one source of truth.

## 1.7 Build and packaging configuration

### Shared esbuild skeleton

- Scripts: `build-cli.mjs`, `build-maestro-p.mjs`, `build-permission-relay-bridge.mjs`.
- Shared behavior: root resolution, esbuild invocation, Node target, CommonJS output, source maps, permissions, error handling.
- Contractual parameters: entry, output, version define, externals, plugins.
- Verdict: **Confirmed**. Extract a parameterized helper while retaining explicit target entrypoints.

### Electron Builder `extraResources`

- The same resource list appears under macOS, Windows, and Linux configuration.
- Verdict: **Verify then change**. Move common resources to top-level configuration only after confirming Electron Builder merge behavior and packaged paths.

## 1.8 Worktree debug logging

- `[WT-DEBUG]` warning calls remain in:
  - `src/main/ipc/handlers/git.ts`
  - `src/renderer/hooks/worktree/useWorktreeHandlers.ts`
- Calls are observational and have no control-flow consumers.
- Verdict: **Confirmed cleanup**, gated on one worktree discovery/removal smoke scenario.

# 2. Verify Before Consolidating

## 2.1 CLI settings parsing and command wrappers

- `parseValue` is duplicated between `src/cli/commands/settings-set.ts` and `settings-agent.ts`.
- Five settings commands repeat JSON/error/exit envelopes.
- Verdict: **Verify then change**. Preserve exact JSON envelopes, exit codes, and command-specific errors.

## 2.2 Similar text and error extractors

- `extractTextFromContent` appears in `src/main/ipc/handlers/claude.ts` and `src/main/storage/claude-session-storage.ts`, but the storage implementation is a strict superset with `tool_use` handling.
- `extractErrorText` appears in the Copilot and Codex output parsers, but trimming, null handling, and fallback behavior differ.
- Verdict: **Verify then change or retain**. Add caller and edge-case tests first; only extract a policy-parameterized helper if it reduces complexity without hiding provider behavior.

## 2.3 Usage snapshot stores

- `claudeUsageStore.ts` and `codexUsageStore.ts` repeat lazy-store, expiry, CRUD, and test-reset mechanics.
- Provider keys and snapshot types differ.
- Verdict: **Verify then change**. A small generic storage primitive may help; do not force provider discovery/sampling into the same abstraction.

## 2.4 Provider usage startup flows

- Claude and Codex startup files have parallel orchestration shapes, but data sources differ materially: wrapper-binary sampling versus OAuth/API behavior.
- Verdict: **Retain unless a tiny orchestration helper emerges naturally**. Reject a broad generic sampler framework.

## 2.5 Process-manager compatibility re-exports

- `src/main/process-manager/index.ts` re-exports parser utilities/types for backward compatibility.
- Production usage appears limited, but exported-symbol references need LSP confirmation before removal.
- Verdict: **Verify then change**.

## 2.6 `DEFAULT_CAPABILITIES` compatibility re-export

- Canonical definition: `src/shared/types.ts:144`.
- Compatibility re-export: `src/main/agents/capabilities.ts:17`.
- `AGENT_CAPABILITIES` in the main-process module is a separate per-agent override table and is not a duplicate of the shared defaults.
- Verdict: **Verify then change**. Run LSP references on the re-export, migrate importers to `src/shared/types.ts`, then remove only the compatibility re-export.

## 2.7 Windows development entrypoint

`dev.mjs` and `start-dev.ps1` are not equivalent:

- `dev.mjs`: shared console, readiness polling, CDP support, production-data mode, signal cleanup.
- `start-dev.ps1`: detached windows, Bun/Bunx commands, fixed wait, Windows-specific UX.

Verdict: **Retain pending Windows UX verification**. Separately investigate `dev.mjs` internally spawning npm despite the project-wide Bun/Bunx rule.

# 3. Live Migration Work — Not Garbage

## 3.1 `Session.shellLogs`

`shellLogs` remains actively read and written.

### Live readers

- `src/renderer/hooks/tabs/internal/useScrollLogHandlers.ts`
- `src/renderer/hooks/agent/internal/helpers/exitGitRefresh.ts`
- `src/renderer/hooks/session/useSessionRestoration.ts`
- `src/main/web-server/types.ts`

### Unguarded writers include

- remote, Symphony, Wizard, Pianola, worktree, and normal session creation
- `src/renderer/hooks/agent/internal/useAgentUserInputListener.ts`

Verdict: **Migration, not garbage**. Removal requires replacement behavior for scrolling/deletion, git refresh detection, restoration, web compatibility, persisted sessions, and terminal-tab-less sessions.

## 3.2 `process:runCommand`

The handler is deprecated but has active callers:

- `src/renderer/hooks/input/useInputProcessing.ts`
- `src/renderer/hooks/remote/useRemoteHandlers.ts`
- `src/renderer/components/DebugPackageModal.tsx`

The web command bridge can also reach terminal execution. `spawnTerminalTab` is not a drop-in replacement because it creates persistent PTY state.

Verdict: **Migration**. Migrate callers first, then remove the handler, preload API, global type, `ProcessManager` method, and runner path.

# 4. Structural Hotspots

These are maintainability targets, not duplicate or dead code.

## `src/renderer/stores/settingsStore.ts`

- Approximately 3,240 lines.
- Mixes defaults, state shape, setters, IPC persistence, migrations, sanitization, and a roughly 790-line `loadAllSettings` path.
- Bounded seams:
  1. renderer defaults
  2. category-specific loading/migrations
  3. setter/persistence helpers

## `src/renderer/components/AppModals/AppModals.tsx`

- Approximately 1,287 lines.
- Large props interface, broad store selectors, and many modal domains.
- Bounded seam: extract the existing modal-domain groups with narrow props/selectors.

## `src/renderer/hooks/agent/useAgentExecution.ts`

- Approximately 916 lines.
- Spawn, retry, queue, error, and store coordination.
- Bounded seams: error policy, queue behavior, and spawning.

## `src/web/hooks/useWebSocket.ts`

- Approximately 1,290 lines; protocol types occupy roughly the first 638 lines and hook behavior spans roughly lines 690–1,288.
- Bounded seam: move shared wire contracts to `src/shared`; keep hook lifecycle behavior together unless further evidence supports splitting.

## Pianola CLI orchestration

- `pianola-orchestrate.ts` and `pianola.ts` remain large and mixed-responsibility.
- Do the confirmed helper dedup first. Treat larger command decomposition as an independent change.

## Release workflow

- `.github/workflows/release.yml` is large, but platform/architecture duplication often encodes real packaging differences.
- Only extract reusable workflow pieces after proving inputs, secrets, artifacts, and failure behavior remain explicit.

# 5. Retain — Intentional or Correctly Abstracted

- Agent event listener hooks: same subscription skeleton, materially different IPC payloads and store semantics.
- `useSessionCrud` and `useSessionLifecycle`: distinct data-operation and lifecycle contracts.
- Provider output parsers: distinct wire formats behind a correct shared interface/factory.
- PTY, child-process, and OpenCode-server spawners: distinct process models.
- Electron/web-desktop shims: intentional runtime adaptation through Vite aliases.
- Renderer prompt-loader caches: separate prompt domains coordinated by `promptInit.ts`.
- `dev-port.mjs`: shared utility already used by both development entrypoints.
- Web versus desktop `GroupChatMessage`: log model and broadcast model have different contracts.
- Web versus desktop group/file-tree/usage models where required versus optional fields encode transport behavior.
- Platform-specific release steps where toolchains and architecture verification differ.
- E2E fixtures and shared test factories: audited as distinct, well-contracted helpers.

# 6. Existing Canonical Utilities and Clean Areas

No meaningful duplication was found in these audited areas:

- `src/shared/plugins` core capability/permission/registry separation
- `src/prompts`
- ambient `src/types`
- `src/shared/pianola` domain modules
- renderer Markdown and BlockView rendering pipelines
- renderer UI primitives
- renderer SessionList, TabBar, MainPanel, InputArea, QuickActions, and UsageDashboard components, excluding explicit settings findings above
- E2E electron/plugin/signing fixtures
- parser factory and error-pattern registry
- base session-storage pagination/search mechanics
- package dependency and TypeScript/Vite target configuration
- committed build artifacts/logs in the audited repository tree

# 7. Ordered Cleanup Queue

## Queue A — Small, high-confidence

1. Remove `[WT-DEBUG]` instrumentation after the worktree smoke scenario.
2. Canonicalize `sanitizeFilename`.
3. Consolidate Pianola gate, polling gate, and interval parser.
4. Remove same-module web-server type duplicates (`LiveSessionInfo`, handler-local `WebClient`, and handler-local `WebClientMessage`).
5. Consolidate small storage constants/helpers.

## Queue B — Shared contracts and UI patterns

6. Choose and document canonical settings-default semantics, then align main, metadata, and renderer implementations.
7. Create shared web wire-contract modules and migrate server/web/preload types by domain.
8. Reuse `ToggleSettingRow` and `SettingsSectionHeading` in General settings.
9. Consolidate group-chat shared/storage types using composition.
10. Consolidate settings CLI parsing/error wrappers after contract tests.

## Queue C — Build and compatibility cleanup

11. Extract the parameterized esbuild helper and verify all three artifacts.
12. Centralize Electron Builder resources after packaging verification.
13. Audit and remove process-manager compatibility re-exports with LSP references.
14. Migrate `DEFAULT_CAPABILITIES` importers to `src/shared/types.ts`, then remove the compatibility re-export.
15. Evaluate a generic usage snapshot-store primitive; keep provider sampling separate.

## Queue D — Explicit migrations

16. Design and execute `process:runCommand` caller migration.
17. Design `shellLogs` replacement and persisted-session migration.

## Queue E — Structural refactors

18. Split settings defaults/loading/setters.
19. Split AppModals by domain.
20. Split agent execution by error/queue/spawn policy.
21. Extract shared WebSocket protocol types.
22. Reassess larger Pianola and release-workflow decomposition afterward.

# 8. Verification Matrix

All implementation work should use Bun/Bunx only.

| Change family                  | Required proof                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Pianola helpers                | Disabled error envelope, enabled plan commands, mid-run feature revocation, interval boundary behavior                                   |
| Filename sanitizer             | Wizard and inline document save paths with traversal/control-character inputs                                                            |
| Settings defaults              | Platform matrix for Windows/macOS/Linux and `$SHELL`; clean-profile CLI/app agreement                                                    |
| Web contracts                  | Type diagnostics plus desktop-to-web AutoRun, session, Cue, Git, and group-chat message flows                                            |
| Settings UI rows/headings      | Keyboard accessibility and browser visual comparison in light/dark themes                                                                |
| Build helper                   | `bun run build:cli`, `bun run build:maestro-p`, and `bun run build:permission-relay-bridge`; compare produced paths and runtime metadata |
| Packaging resources            | Platform package inspection for CLI artifacts and prompt resources                                                                       |
| Worktree logging               | Create/discover/remove worktree flow with no functional regression                                                                       |
| Usage stores                   | Expiry, key selection, CRUD, and test-reset behavior for both providers                                                                  |
| `process:runCommand` migration | Local terminal, SSH terminal, Debug Package reveal, and web command bridge                                                               |
| `shellLogs` migration          | Restored old session, terminal-tab-less session, scroll/delete behavior, git refresh, and web session API                                |

# 9. Audit Limitations

- This was static analysis; no cleanup implementation or runtime verification was performed.
- Dynamic plugin and IPC consumers require runtime proof before exported APIs are deleted.
- Similar types were only marked duplicate when their serialization contracts matched; transport adapters were retained.
- Two Task agents initially returned malformed terminal payloads during deeper audits. Findings included here were recovered from their source work or rerun, then reconciled against contradictory evidence.
- Line numbers may move as the repository changes; symbols and paths are the durable references.

# 10. Extended Research Findings

This section records the subsequent five-agent research round. It preserves new findings without silently promoting similar-but-different implementations to confirmed duplication.

## 10.1 Current working-tree correctness blocker

`src/main/preload/plugin-panel.ts` currently ends its message listener with an unused nested `hasBoundedJson` function. The current file:

- references undefined `MAX_PAYLOAD_BYTES`;
- never validates `type` or `commandId`;
- never calls `ipcRenderer.sendToHost`;
- therefore does not perform the forwarding behavior described by its own header.

A targeted diff shows this is an **uncommitted working-tree change**, not established baseline duplication: the prior forwarding block was replaced by the nested byte-counting function. Do not treat it as routine deduplication or overwrite it while cleanup work proceeds. Resolve the correctness regression with the owner of the in-progress change first.

The `ALLOWLIST_MEMBER_FORBIDDEN` regexes reported as different by one agent are equivalent JavaScript character-class spellings. No finding is recorded for them.

## 10.2 Main IPC and compatibility findings

### `handlerOpts` proliferation

- Roughly 25 IPC handler files define small `handlerOpts` helpers.
- At least three contracts exist: context/operation only, full options with `logSuccess`, and context/operation plus optional `extra`.
- Canonical direction: add deliberately named constructors to `src/main/utils/ipcHandler.ts` only if the three variants remain explicit.
- Verdict: **Verify then change**. Do not replace the variants with one weakly typed catch-all.

### `GraphBucket`

- Identical preload interfaces appear in `src/main/preload/directorNotes.ts` and `src/main/preload/files.ts`.
- `src/shared/history.ts` already defines the equivalent cached graph-bucket shape.
- Verdict: **Verify then change** after checking preload/shared dependency direction and `HistoryGraphData`.

### `getActiveGroomingSessionCount`

- Byte-identical exports appear in `src/main/utils/context-groomer.ts` and `src/main/ipc/handlers/context.ts`.
- Canonical: the context-groomer utility; the handler can import or re-export it.
- Verdict: **Confirmed**.

### Deprecated grooming APIs

Static tracing found no production callers for the old `createGroomingSession`, `sendGroomingPrompt`, or `cleanupGroomingSession` preload/IPC trio. The renderer now uses the single-call `groomContext` API. `activeGroomingSessionId` is initialized to `null` and was not observed being assigned, making `cancelGrooming` and its cleanup path appear ineffective.

- Verdict: **Migration/verify**, not immediate deletion.
- Required proof: LSP references, dynamic IPC-channel search, cancellation behavior tests, quit-handler behavior, and external/preload API compatibility.

### Test-only compatibility candidates

- Agent detection/command helpers appear to be imported only by agent-spawner tests.
- `detectHaltMarker` is re-exported from the batch processor while production callers import the shared halt-marker module directly.
- Verdict: **Verify then change**. Run exported-symbol references and account for external consumers before removal.

### Active compatibility retained

`window.maestro.claude` is deprecated in favor of the agent-session API but still has production callers. Retain until callers are migrated.

## 10.3 Renderer feature findings

### `getActiveUnifiedRef`

- Inline copy: `src/renderer/hooks/modal/useQuickActionsHandlers.ts`.
- Canonical utility: `src/renderer/hooks/tabs/internal/unifiedCloseHelpers.ts`.
- Evidence: same terminal → file → browser → AI priority.
- Verdict: **Confirmed**.

### Modal close wrappers

Fifteen or more handlers wrap `getModalActions().setXxxModalOpen(false)` in otherwise empty callbacks. The shim is documented as legacy.

- Verdict: **Verify then change**.
- Preferred direction: first migrate from the legacy `getModalActions` shim to typed modal-store actions; introduce a generic close hook only if it preserves type safety and does not hide modal-specific side effects.

### Retained renderer patterns

- `createTab` callers already use the canonical utility; a defaults convenience wrapper is optional, not required.
- Unified bulk close and single-tab close have different UX and cleanup contracts.
- Cue pipeline hooks are correctly decomposed by state, mutation, persistence, and layout.
- Remote IPC listeners and renderer custom-event listeners are intentional two-layer adapters.
- File-preview open logic is already centralized through dependency injection.
- Modal layer hooks correctly share layer-stack infrastructure.

## 10.4 Shared utility findings

### `isPlainObject`

Equivalent local guards exist in CLI narrative parsing, agent-run validators, campaign validators, and several plugin parsing/storage modules.

- Verdict: **Confirmed small duplication** where bodies and trimming policy match.
- Canonical direction: a narrowly named shared unknown-object guard.
- Do not couple unrelated validators merely to remove a three-line helper.

### `isNonEmptyString`

Agent-run and campaign validators differ on whitespace-only strings.

- Verdict: **Retain or standardize by explicit policy**. This is behavioral divergence, not literal duplication.

### Formatting helpers requiring policy decisions

| Helper                     | Locations                                     | Verdict                                                               |
| -------------------------- | --------------------------------------------- | --------------------------------------------------------------------- |
| `truncateText`             | shared formatter, DocumentGraph node, MindMap | Verify; ellipsis form and maximum-length semantics differ             |
| `formatCost`               | shared formatter, Symphony contributor stats  | Verify; sub-cent display differs                                      |
| `formatTokens`             | shared formatter, CLI output formatter        | Verify; rounding, approximation marker, decimals, and billions differ |
| `formatTimestamp`          | shared formatter, Cue backup tab              | Retain; local fixed format is intentionally narrower                  |
| `formatNumber`             | shared formatter, Symphony IPC table          | Retain; abbreviated versus exact counts                               |
| `formatCacheAge` re-export | Symphony modal helper namespace               | Retain intentional indirection                                        |

## 10.5 Plugin platform findings

### SDK/host contract duplication

`packages/plugin-sdk/src/index.ts` independently declares large portions of:

- plugin permissions and capability metadata;
- host API compatibility;
- manifest validation;
- contribution types;
- plugin events;
- RPC host methods.

This is high-risk drift because the published SDK is the author-facing contract while the host enforces `src/shared/plugins` at runtime.

- Verdict: **Architecture decision required**.
- Preferred options:
  1. generate SDK declarations/runtime validators from one source;
  2. package shared plugin-contract modules cleanly; or
  3. retain the boundary but add automated semantic drift tests.
- Do not make a published SDK import repository-relative application source.

### Plugin helper duplication

- `serializedJsonByteLength` appears in shared contributions and the SDK; the current preload copy belongs to the working-tree correctness blocker above.
- `isSafeRelativeEntry` appears in manifest, contribution, and SDK paths with small policy differences.
- `isPlainObject` and `isNonEmptyString` repeat across plugin validators.
- `WINDOWS_RESERVED` repeats in plugin store and KV-store modules.

Verdict: **Confirm exact policy first**, then consolidate shared host helpers. Public SDK changes require compatibility tests and release discipline.

### Retained plugin boundaries

Keep host-only unattended/high-risk policy, permission broker behavior, action guards, signature verification, panel-host constants, renderer contribution adapters, and test harnesses in their current layers unless a concrete drift is proven.

## 10.6 Additional compatibility and stale-state findings

### Notification compatibility

Deprecated toast type/variant fields remain across renderer notification stores and web notification contracts.

- Verdict: **Verify then migrate**. Trace rendering, web broadcast, and persisted notification consumers before removal.

### Cue-domain lookalikes

The extended main-domain scan found similar process lifecycle, failed-result, fetch-timeout, and stdout-cleaning patterns. The observed implementations differ in partial-event filtering, signatures, or execution domain.

- Verdict: **Insufficient evidence for consolidation**.
- In particular, stdout extraction differs on `event.isPartial`; do not merge until the intended Cue output contract is documented and tested.

## 10.7 Extended priority list

1. Resolve the uncommitted `plugin-panel.ts` correctness regression separately from deduplication.
2. Remove the local `getActiveUnifiedRef` copy.
3. Remove the duplicate `getActiveGroomingSessionCount` implementation.
4. Verify and centralize `GraphBucket`.
5. Design explicit IPC handler-option constructors before touching handler files.
6. Decide the SDK/host contract-source strategy and add drift enforcement.
7. Migrate or remove deprecated grooming APIs only after cancellation and dynamic-channel proof.
8. Evaluate modal shim removal before introducing generic close hooks.
9. Standardize only formatter/validator policies that product behavior actually wants unified.
10. Audit notification compatibility fields with renderer and web flows.

## 10.8 Extended research limitations

- One main-domain Task agent failed while yielding; only findings recoverable from its completed source trace were retained.
- Compatibility findings are static and require LSP/runtime confirmation for public preload APIs.
- The plugin-panel issue is present in uncommitted working-tree changes and is not attributed to baseline Maestro.
- No repository source files were modified during research; only this report was updated.
- Cue domain kill helpers (`killCueProcess`, `killShellProcess`, `killCliProcess`) are near-byte-identical with a bug in `killCueProcess`'s sync SIGKILL path.
- `failedResult` closures in three executors are byte-identical — extractable as a shared factory.
- Timeout patterns differ intentionally (listener-swapping vs flag-based); `runProcess` should migrate to the flag pattern.
- Two `extractCleanStdout` implementations diverge on `isPartial` filtering — retain with rename.
- ~25 handler files define `handlerOpts` with three distinct contracts — named constructors in `ipcHandler.ts` would eliminate ~200 lines.

## 10.9 Cue kill / process lifecycle — near-identical with bug

Three kill helpers exist across the Cue domain, each managing a separate process pool:

| Kill helper        | File                                    | Line |
| ------------------ | --------------------------------------- | ---- |
| `killCueProcess`   | `src/main/cue/cue-process-lifecycle.ts` | 184  |
| `killShellProcess` | `src/main/cue/cue-shell-executor.ts`    | 53   |
| `killCliProcess`   | `src/main/cue/cue-cli-executor.ts`      | 112  |

**Behavioral comparison (Windows path):** All three do `taskkill /pid <pid> /t /f` with identical `execFile`/`execFileSync` calls and identical `SIGKILL_DELAY_MS = 5000`.

**Divergence 1 — async error check (locale-dependent vs locale-independent):**

- `killCueProcess` (line 199): checks `error.message.toLowerCase()` for `'not found'` / `'no running instance'` — locale-dependent string matching.
- `killShellProcess` (line 71): checks `child.exitCode !== null || child.signalCode !== null` — locale-independent, correct.
- `killCliProcess` (line 123): same exit-code check as shell.

**Divergence 2 — synchronous POSIX escalation (bug in `killCueProcess`):**

- On Windows with a PID, all three helpers stay in the `taskkill` branch; no deferred signal timer is scheduled.
- On non-Windows or without a PID, `killCueProcess` (lines 209–217) sends `SIGTERM` and schedules a deferred `SIGKILL` even when `sync` is true. The event loop may exit before that timer fires.
- `killShellProcess` (lines 77–86) and `killCliProcess` (lines 129–138) escalate immediately in synchronous shutdown mode.

**Verdict:** `killShellProcess` and `killCliProcess` contain the safer synchronous POSIX behavior. Fix `killCueProcess` first; then consider a single shared helper with explicit timer/return semantics.

**Process pool management:** Each executor owns a separate process map and stop/stop-all operations. This is structural similarity, not yet a consolidation target; cancellation, return, and cleanup semantics need contract tests before introducing a registry abstraction.

## 10.10 `failedResult` closures — confirmed byte-identical

Three closures build identical `CueRunResult` failure objects:

| Closure        | File                                 | Line |
| -------------- | ------------------------------------ | ---- |
| `failedResult` | `src/main/cue/cue-executor.ts`       | 157  |
| `failedResult` | `src/main/cue/cue-cli-executor.ts`   | 292  |
| `failedResult` | `src/main/cue/cue-shell-executor.ts` | 117  |

**Evidence:** All three produce `{runId, sessionId, sessionName, subscriptionName, pipelineName, event, status: 'failed', stdout: '', stderr: message, exitCode: null, durationMs, startedAt, endedAt}` — byte-identical field list and value assignments.

**Verdict: Confirmed duplication.** A module-level factory `createFailedResult(config: {runId, session, subscription, event, startTime}): CueRunResult` would eliminate 3 × 15 lines.

## 10.11 Fetch-timeout patterns — intentional divergence

| Timeout             | File                               | Domain        | Pattern                        |
| ------------------- | ---------------------------------- | ------------- | ------------------------------ |
| `runProcess`        | `cue-process-lifecycle.ts:345–357` | Agent spawn   | Listener-swapping (race-prone) |
| `executeCueShell`   | `cue-shell-executor.ts:291–298`    | Shell command | `timedOut` flag (correct)      |
| `runMaestroCliSend` | `cue-cli-executor.ts:256–262`      | CLI dispatch  | `timedOut` flag (correct)      |

**Verdict: Retain.** The `runProcess` path uses the older listener-swapping approach; the newer executors use the `timedOut` flag pattern (documented in cue-shell-executor comments at lines 268–272). The domains serve different execution models and should remain separate, but `runProcess` should migrate to the flag pattern.

## 10.12 stdout-cleaning — meaningful behavioral divergence

| Function             | File                       | Line | Filter                                          |
| -------------------- | -------------------------- | ---- | ----------------------------------------------- |
| `extractCleanStdout` | `cue-process-lifecycle.ts` | 89   | `event.isPartial && event.text` — only partials |
| `extractCleanStdout` | `cue-executor.ts`          | 73   | `event.text` — all text events                  |

**Secondary divergence:** `cue-process-lifecycle.ts:111` uses `get(msgId) ?? ''`; `cue-executor.ts:98` uses `get(msgId)` with `!existing` check.

**Impact:** Process-lifecycle strips to partials for internal telemetry; executor produces full text for user-visible output. Not a bug — different consumers.

**Verdict: Retain with documentation.** Rename `cue-process-lifecycle.ts` version to `extractPartialStdout` to make the contract explicit. Merging would require a parameterized mode.

## 10.13 `handlerOpts` — three contracts, ~25 duplicate definitions

| Contract | Signature                                                         | Return type                                            | Files                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A        | `(operation: string) → Pick<...>`                                 | `Pick<CreateHandlerOptions, 'context' \| 'operation'>` | `coworking.ts:37`, `cross-agent.ts:42`, `cue.ts:45`, `cue-backup.ts:33`, `cue-stats.ts:23`, `director-notes.ts:60`, `groupChat.ts:120`, `history.ts:164`, `maestro-cli.ts:7`, `pianola.ts:54` |
| B        | `(operation: string, logSuccess: boolean) → CreateHandlerOptions` | Full options                                           | `autorun.ts:27`, `bmad.ts:28`, `debug.ts:38`, `documentGraph.ts:11`, `marketplace.ts:57`, `openspec.ts:29`                                                                                    |
| C        | `(operation: string, extra?: Partial<...>) → Pick<...>`           | Pick with spread                                       | `context.ts:36` (with `logSuccess: false`), `feedback.ts:68`                                                                                                                                  |
| Edge     | `(operation: string, context: string) → Pick<...>`                | Pick with override                                     | `agents.ts:53`                                                                                                                                                                                |

**Verdict: Verify then change.** Named constructors in `src/main/utils/ipcHandler.ts` would eliminate ~200 lines of boilerplate. The `agents.ts` context-override and `context.ts`/`feedback.ts` `extra` spread are edge cases.

# 11. Main Web Stack Audit (`src/main/web-server/**`)

## 11.1 Factory vs WebServer — intentional separation, not duplication

**Files involved:**

- `web-server-factory.ts` (3,115 lines)
- `WebServer.ts` (1,300 lines)
- `src/main/index.ts:754–1094` (factory instantiation)
- `src/main/ipc/handlers/web.ts:99–598` (live server lifecycle)

**Architecture:** `WebServer` is the Fastify instance + route registration + WebSocket message dispatch. `createWebServerFactory` in `web-server-factory.ts` is the _dependency injection layer_: it creates the `WebServer`, wires every single callback setter with the actual business logic (reading from sessionsStore/groupsStore, forwarding to renderer via `mainWindow.webContents.send('remote:*')`, etc.), and returns it.

**Proof of non-duplication:**

- `WebServer` has **zero** business logic. Every method delegates to `LiveSessionManager`, `CallbackRegistry`, `BroadcastService`, `WebSocketMessageHandler`, or one of the three route classes.
- `web-server-factory.ts:178–3113` creates a `WebServer` instance, calls every `server.setXxxCallback(...)` with the _actual implementation_, and returns it. The returned function `createWebServer()` is called from:
  +- `src/main/index.ts:1091` (initial setup)
  +- `src/main/index.ts:3024` (CLI server deps)
  +- `src/main/ipc/handlers/web.ts:108` (`ensureCliServer`)
  +- `src/main/ipc/handlers/web.ts:440` (`live:startServer` IPC handler)
- The two call sites (`ensureCliServer` for CLI-only mode, `live:startServer` for Live Mode) create _separate_ `WebServer` instances with the _same_ factory. This is intentional: CLI mode and Live Mode have different lifecycle needs (token rotation, discovery file management).

**Verdict: Retained.** The factory is not a duplicate of `WebServer.ts` — it is the wiring layer. The codebase intentionally separates Fastify lifecycle from IPC callback implementation. Removing the factory would require inlining 2,900+ lines of callback closures into `WebServer.ts`, making it a 4,000-line monolith.

## 11.2 IPC callback duplication in web-server-factory.ts

**The core finding:** `web-server-factory.ts` contains **~2,900 lines** of nearly identical IPC request-response boilerplate. Each callback follows this exact pattern:

```
1. Check mainWindow is not null → warn
2. Check isWebContentsAvailable(mainWindow) → warn, return fallback
3. Create responseChannel = `remote:${operation}:response:${randomUUID()}`
4. Set up ipcMain.once listener with resolved flag + clearTimeout on timeout
5. Send via mainWindow.webContents.send('remote:...', ...args, responseChannel)
6. setTimeout to clear timeout and resolve fallback
7. Return Promise that resolves with result or fallback
```

This pattern repeats for **50+ callbacks**: `executeCommand`, `interruptSession`, `switchMode`, `selectSession`, `selectTab`, `newTab`, `closeTab`, `renameTab`, `starTab`, `reorderTab`, `toggleBookmark`, `openFileTab`, `refreshFileTree`, `openBrowserTab`, `openTerminalTab`, `newAITabWithPrompt`, `refreshAutoRunDocs`, `configureAutoRun`, `setSessionAutoRunFolder`, `getAutoRunDocs`, `getAutoRunDocContent`, `saveAutoRunDoc`, `getSettings` (partial), `setSetting`, `createGroup`, `renameGroup`, `deleteGroup`, `moveSessionToGroup`, `getGitStatus`, `getGitDiff`, `createSession`, `createWorktreeSession`, `deleteSession`, `renameSession`, `updateSessionCwd`, `updateSessionSsh`, `updateSessionConfig`, `getGroups` (partial), `stopAutoRun`, `resetAutoRunDocTasks`, `resumeAutoRunError`, `skipAutoRunDocument`, `abortAutoRunError`, `listPlaybooks`, `createPlaybook`, `updatePlaybook`, `deletePlaybook`, `getGroupChats`, `startGroupChat`, `getGroupChatState`, `stopGroupChat`, `sendGroupChatMessage`, `mergeContext`, `transferContext`, `summarizeContext`, `getUsageDashboard`, `getAchievements`, `createGist`, etc.

**Partial mitigation exists:** Lines 2126–2167 define a `remoteRequest<T>()` helper that abstracts the pattern for 8 callbacks (`resetAutoRunDocTasks`, `resumeAutoRunError`, `skipAutoRunDocument`, `abortAutoRunError`, `listPlaybooks`, `createPlaybook`, `updatePlaybook`, `deletePlaybook`). However, the remaining 40+ callbacks are still hand-written.

**Estimated duplicated/removable LOC:** ~1,200 lines of boilerplate across ~50 callbacks. With the `remoteRequest` helper extended to cover all IPC callbacks, this would collapse to ~200 lines of declarative callback definitions.

**Confidence: High.** The pattern is mechanically identical across all 50+ callbacks. The `remoteRequest` helper proves the abstraction is already designed and working.

**Risk: Medium.** Each callback has subtle differences: timeout duration (5s vs 10s vs 15s vs 30s vs 60s), fallback values (`false`, `null`, `[]`, `{}`), and result shapes (boolean, structured `{success, error}`, `WebPlaybook`, etc.). A refactoring must preserve these variations.

**Callers/tests:** None found specifically testing the factory's callback wiring. The callbacks are exercised through IPC when web clients connect.

**Minimum verification:** Start a Live Mode session, execute commands through the web UI, verify all operations still work after refactoring.

## 11.3 Settings serialization triple-copy

**Three identical settings builders exist:**

| Location                          | Purpose                                                       | Lines |
| --------------------------------- | ------------------------------------------------------------- | ----- |
| `web-server-factory.ts:1363–1379` | `getSettings` callback for web clients                        | 17    |
| `web-settings-snapshot.ts:38–53`  | `buildWebSettingsSnapshot()` for broadcast after `setSetting` | 16    |
| `CallbackRegistry.ts:526–549`     | `getSettings` fallback defaults                               | 24    |

**Evidence:** All three read the same 10 keys (`activeThemeId`, `fontSize`, `enterToSendAI`, `defaultSaveToHistory`, `defaultShowThinking`, `osNotificationsEnabled`, `audioFeedbackEnabled`, `colorBlindMode`, `conductorProfile`, `maxOutputLines`, `shortcuts`) with the same defaults and cast pattern.

`web-settings-snapshot.ts` already exists as a canonical builder but is **not used** by the factory's `getSettings` callback (lines 1363–1379 hand-roll the same logic). The `CallbackRegistry.getSettings` fallback also hand-rolls defaults.

**Estimated duplicated/removable LOC:** 37 lines (two of the three copies are removable).

**Verdict: Confirmed.** The factory should import `buildWebSettingsSnapshot` from `web-settings-snapshot.ts` for its `getSettings` callback. The `CallbackRegistry.getSettings` fallback defaults should either call the shared builder or document why its defaults differ.

**Risk: Low.** Settings keys and defaults are stable; the builder is the single source of truth already.

## 11.4 BroadcastService broadcast pattern duplication

**Every `BroadcastService.broadcastXxx()` method follows this exact pattern:**

```typescript
broadcastToAll({ type: 'event_type', ...payload, timestamp: Date.now() });
```

This pattern is repeated in `WebServer.ts` through the 30 `broadcastToWebClients`, `broadcastSessionStateChange`, `broadcastSessionAdded`, `broadcastThemeChange`, etc. proxy methods (lines 1079–1199). Each proxy is a **single-line pass-through** with zero additional logic.

**Estimated duplicated/removable LOC:** 30 methods, ~90 lines in `WebServer.ts`.

**Verdict: Verified then change.** These are pure delegation methods. The callers in `src/main/` call `webServer.broadcastSessionStateChange(...)` which calls `this.broadcastService.broadcastSessionStateChange(...)`. Direct calls to the service are feasible, or the proxy methods should be removed from `WebServer`'s public API in favor of documented service access.

**Risk: Low-Medium.** The `WebServer` broadcast methods are called from `src/main/ipc/handlers/web.ts` and `src/main/index.ts`. Removing them requires updating all callers.

## 11.5 WebServer.broadcast\* proxy methods — detailed audit

**File:** `WebServer.ts`, lines 1079–1199

**Methods (all single-line delegations to BroadcastService):**
`broadcastToWebClients`, `broadcastNotificationEvent`, `broadcastToSessionClients`, `broadcastToAll`, `broadcastSessionStateChange`, `broadcastSessionAdded`, `broadcastSessionRemoved`, `broadcastSessionsList`, `broadcastActiveSessionChange`, `broadcastTabsChange`, `broadcastThemeChange`, `broadcastBionifyReadingModeChange`, `broadcastCustomCommands`, `broadcastSettingsChanged`, `broadcastAutoRunState`, `broadcastAutoRunDocsChanged`, `broadcastUserInput`, `broadcastGroupChatMessage`, `broadcastGroupChatStateChange`, `broadcastContextOperationProgress`, `broadcastContextOperationComplete`, `broadcastCueActivity`, `broadcastCueSubscriptionsChanged`, `broadcastToolEvent`

**Verdict: Verified then change.** Each proxy is `{ args } → this.broadcastService.<method>(args)`. The `WebServer` class has already extracted routes, handlers, services, and managers — these proxy methods are the last remaining surface-level delegation that adds no value.

## 11.6 Message handler boilerplate duplication

**File:** `messageHandlers.ts`, ~5,430 lines

**Pattern:** Every handler method (50+ `handleXxx` methods) follows this structure:

```typescript
private handleXxx(client, message) {
  const x = message.x as type;  // destructure
  logger.info(...)                // log
  if (!required) { this.sendError(...) return; }
  if (!this.callbacks.x) { this.sendError(...) return; }
  this.callbacks.x(args)
    .then((result) => {
      this.send(client, { type: 'xxx_result', ... });
    })
    .catch((error) => {
      this.sendError(client, `Failed to xxx: ${error.message}`);
    });
}
```

**Specific duplicates:**

- **Tab operations** (8 handlers, ~200 lines): `handleSelectTab`, `handleNewTab`, `handleCloseTab`, `handleRenameTab`, `handleStarTab`, `handleReorderTab`, `handleToggleBookmark`, `handleOpenFileTab` — all identical structure with different response type strings.
- **Session operations** (6 handlers, ~180 lines): `handleCreateSession`, `handleDeleteSession`, `handleRenameSession`, `handleUpdateSessionCwd`, `handleUpdateSessionSsh`, `handleUpdateSessionConfig`.
- **Group operations** (5 handlers, ~150 lines): `handleGetGroups`, `handleCreateGroup`, `handleRenameGroup`, `handleDeleteGroup`, `handleMoveSessionToGroup`.
- **Git operations** (3 handlers, ~90 lines): `handleGetGitStatus`, `handleGetGitDiff`, `handleGetGitBranches`.
- **Group chat operations** (5 handlers, ~150 lines): `handleGetGroupChats`, `handleStartGroupChat`, `handleGetGroupChatState`, `handleStopGroupChat`, `handleSendGroupChatMessage`.
- **Context operations** (4 handlers, ~120 lines): `handleMergeContext`, `handleTransferContext`, `handleSummarizeContext`, `handleCreateGist`.

**Estimated repeated LOC:** ~1,000 lines of structurally similar boilerplate across 50+ handlers. Net savings are unproven because validation, response typing, and error text remain handler-specific.

**Verdict: Verify before consolidation.** The transport skeleton repeats, but field names, response type strings, validation, callback semantics, and error behavior are part of the wire contract. Prefer a few domain-scoped helpers after contract tests; reject one generic dispatcher until it demonstrably reduces code without hiding protocol behavior.

**Risk: High.** Refactoring must preserve exact response types, validation order, callback availability errors, and client-visible error text.

## 11.7 LiveSessionManager + BroadcastService dual state management

**Live session state is tracked in two places:**

1. `LiveSessionManager.liveSessions` (Map<sessionId, LiveSessionInfo>) — tracks which sessions are marked "live"
2. `BroadcastService.previousAutoRunStates` (Map<sessionId, {running, completedTasks}>) — tracks previous AutoRun state for diff-based broadcasting

**Additionally:** `WebServer.ts` owns `this.webClients: Map<string, WebClient>` (line 161), `LiveSessionManager` owns its own state, and `BroadcastService` has its own state. This creates a **three-owner system** for web-server runtime state.

**Estimated overlapping LOC:** ~100 lines of state declaration across the three classes.

**Verdict: Verified then change.** The state is intentionally separated by concern (live session tracking, AutoRun state diffs, client connections), but the separation is unclear in the public API. `WebServer` exposes `setSessionLive`, `setSessionOffline`, `getLiveSessions`, `isSessionLive` — and `LiveSessionManager` exposes the same methods plus `getAutoRunStates`. The boundary between "what the server owns" vs "what the manager owns" is not documented.

## 11.8 StaticRoutes duplicate serveDesktopIndex calls

**File:** `staticRoutes.ts`, lines 210–232

All five routes call `this.serveDesktopIndex(reply)` — identical handler:

- `/${token}` (line 210)
- `/${token}/` (line 215)
- `/${token}/desktop` (line 221)
- `/${token}/desktop/` (line 224)
- `/${token}/session/:sessionId` (line 230)

The trailing-slash variants and the legacy deep-link exist for backward compatibility but share no logic.

**Estimated duplicated/removable LOC:** ~15 lines (route registration duplication).

**Verdict: Verified then change.** Consolidate to a single handler method and register all path variants. The legacy deep-link should ideally serve a redirect, not the full index.

**Risk: Low.** All paths serve the same content; changing to a redirect only for the deep-link would improve semantics.

## 11.9 CallbackRegistry dead code / unused fallback defaults

**File:** `CallbackRegistry.ts`, lines 526–549

The `getSettings()` method returns hardcoded fallback defaults (`{ theme: 'dracula', fontSize: 14, ... }`) when no callback is set. Static tracing suggests the path may be unreachable because:

1. The factory sets `getSettingsCallback` (line 1363) with a real implementation.
2. The `CallbackRegistry` is created inside the factory's closure.
3. No test currently exercises the fallback path.
4. The fallback defaults may drift from the actual settings store defaults.

**Potential removable LOC:** 24 lines.

**Verdict: Verify before deletion.** Establish a constructor invariant or test proving callback registration precedes every `getSettings()` read. Then remove the fallback and choose an explicit missing-registration contract—prefer a thrown initialization error over silently returning `null`.

## 11.10 Cross-module session/group/chat transformation duplication

**Session list enrichment with live info is duplicated 3 times:**

| Location                       | Lines                             |
| ------------------------------ | --------------------------------- |
| `apiRoutes.ts:104–112`         | REST API /api/sessions            |
| `messageHandlers.ts:1172–1180` | WebSocket get_sessions handler    |
| `wsRoute.ts:120–130`           | WebSocket initial sync on connect |

All three compute: `{ ...s, agentSessionId: liveInfo?.agentSessionId || s.agentSessionId, liveEnabledAt: liveInfo?.enabledAt, isLive: isSessionLive?.(s.id) || false }`.

**Estimated duplicated/removable LOC:** ~90 lines of enrichment logic duplicated 3 times.

**Verdict: Confirmed.** Extract a `enrichSessionsWithLiveInfo(sessions, getLiveSessionInfo, isSessionLive)` helper.

## 11.11 Retained — intentional divergence

- **WebServer lifecycle vs IPC handler lifecycle**: `ensureCliServer` (CLI-only) and `live:startServer` (Live Mode) manage separate server lifecycles intentionally. CLI mode needs discovery file persistence; Live Mode needs token rotation.
- **WebSocket message handlers vs API routes**: The WebSocket path handles real-time bidirectional communication with subscription model; the REST API is stateless. Different contracts justify separate code.
- **Factory callbacks that read directly from stores** (`getSessions`, `getGroups`, `getSettings`) vs those that forward to renderer (`executeCommand`, `createSession`): Direct reads are self-contained; renderer-forwards need IPC round-trips. The distinction is architectural, not duplication.
- **`resolveSessionGitContext`** (line 1986) vs `resolveSessionSshConfig` (line 3017): Different SSH config shapes (one for git execution, one for marketplace imports) serve different domains.
- **Cue subscription callbacks** use direct main-process calls (correct, as the engine lives in main), while most others use IPC to renderer. The distinction is documented in comments (lines 2659–2788).
- **`handleSendCommand`** in `messageHandlers.ts` has genuine additional logic (busy-state guard, inputMode resolution, image handling, force dispatch) that the API route's `POST /api/session/:id/send` does not have. Different contracts.

## 11.12 Clean areas

- **`BroadcastService`**: Well-structured, each method is a distinct broadcast type with no internal duplication.
- **`LiveSessionManager`**: Clean state management with proper cleanup on shutdown. ~177 lines is appropriate for its scope.
- **`CallbackRegistry`**: Despite the dead fallback defaults (11.9), the callback storage and getter/setter architecture is clean and well-typed.
- **`bridgeHandlers.ts`**: The IPC bridge abstraction (`handleBridgeInvoke`, `installWebContentsBridgeHook`) is well-structured with no duplication.
- **`web-settings-snapshot.ts`**: A clean, single-responsibility module. The only issue is that the factory doesn't use it (11.3).
- **Route registration architecture**: The extraction of `ApiRoutes`, `StaticRoutes`, and `WsRoute` from `WebServer.ts` was successful — each route class has a clear contract and no internal duplication.

# 12. CLI Command Envelope Duplication (`src/cli/commands/**`)

Every CLI command repeats a try/catch → JSON error envelope → `process.exit(1)` pattern.
The shape is:

```ts
try { … } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (options.json) {
        console.error(JSON.stringify({ error: message }));
    } else {
        console.error(formatError(`Failed to …: ${message}`));
    }
    process.exit(1);
}
```

This pattern appears in at least 22 commands (settings-set, settings-get, settings-list, settings-reset,
settings-agent × 4, list-groups, list-agents, list-playbooks, list-sessions, show-agent,
show-playbook, stats, clean-playbooks, director-notes-history, director-notes-synopsis,
cue-trigger, cue-list, cue-pipeline via `reportError()`, cadenza, goal-run, auto-run, dispatch,
gist, create-agent, create-group, create-ssh-remote, prompts-get).

**Estimated repeated boilerplate:** ~22 commands × 6 lines = ~130 gross lines. Net savings depend on how many commands share stdout/stderr, JSON-envelope, cleanup, and exit-code contracts.

**Canonical direction:** First characterize those contracts with command-level tests. Then introduce one or more narrowly named output helpers; do not force every command through one `emitErrorExit()` policy.

**Risk: Medium.** JSON versus human output, stdout versus stderr, cleanup, and exit codes are observable CLI behavior.

**Verification:** Exercise representative commands from each contract family in JSON and human modes, including transport, validation, and cleanup failures.

**Overlap:** This is a distinct finding from section 2.1 (settings `parseValue` duplication).

## 12.1 `reportError` in `cue-pipeline.ts`

- Location: `src/cli/commands/cue-pipeline.ts:46-53`
- Evidence: Identical JSON-enveloped error + `process.exit(1)` pattern, but uses `console.log` (not `console.error`)
  for JSON output — a behavioral deviation from the canonical `console.error` used by all other commands.
- Verdict: **Verify then change**. The `console.log` vs `console.error` difference may be intentional for piping
  but is undocumented and inconsistent with every other CLI command.

## 12.2 `parseValue` duplication (already reported in 2.1 — confirmed)

- `src/cli/commands/settings-set.ts:22-43` and `src/cli/commands/settings-agent.ts:72-88`
- Byte-identical 17-line parser for CLI string-to-type coercion.
- Verdict: **Confirmed**. Extract to `src/cli/utils/parseValue.ts`.

# 13. Refresh Scripts Duplication (`scripts/refresh-*.mjs`)

Three prompt-refresh scripts (`refresh-bmad.mjs`, `refresh-openspec.mjs`, `refresh-speckit.mjs`)
each define their own `httpsGet` helper — nearly identical implementations with only the `User-Agent`
header and a single timeout difference distinguishing them.

| Function   | BMAD                  | OpenSpec  | SpecKit   |
| ---------- | --------------------- | --------- | --------- |
| `httpsGet` | 108–138 (has timeout) | 43–68     | 48–74     |
| `getJson`  | 140–143               | (inlined) | (inlined) |
| `getText`  | 145–152               | (inlined) | (inlined) |

**Evidence:** All three use `https.get()` with redirect following, status-200 check, data accumulation,
and the same `reject` on non-200. BMAD adds a `setTimeout` callback; OpenSpec/SpecKit omit it.

**Estimated duplicated code:** ~30 lines × 3 = ~90 lines; shared core could be ~15 lines.

**Canonical direction:** A shared `scripts/lib/http.mjs` with a `fetchGithub(url, options?)` helper.

**Risk:** Low — these are developer tooling scripts, not production code.

**Verification:** Run `bun scripts/refresh-speckit.mjs` (dry) to confirm no regression.

# 14. Build Script Shared Skeleton (`scripts/build-*.mjs`)

Already reported in section 1.7. This audit confirms:

| Script                              | Entry                                 | Output                                | Externals      | Plugins       |
| ----------------------------------- | ------------------------------------- | ------------------------------------- | -------------- | ------------- |
| `build-cli.mjs`                     | `src/cli/index.ts`                    | `dist/cli/maestro-cli.js`             | `['fsevents']` | `rawMdPlugin` |
| `build-maestro-p.mjs`               | `src/maestro-p/index.ts`              | `dist/cli/maestro-p.js`               | `['node-pty']` | none          |
| `build-permission-relay-bridge.mjs` | `src/main/permission-relay/bridge.ts` | `dist/cli/permission-relay-bridge.js` | none           | none          |
| `build-preload.mjs`                 | 3 preloads                            | `dist/main/preload*.js`               | `['electron']` | none          |

All four share: `__dirname` resolution, `rootDir = path.resolve(__dirname, '..')`,
esbuild `bundle: true`, `platform: 'node'`, `target: 'node20'` (or `'node18'` for preload),
`format: 'cjs'`, `sourcemap: true`, `minify: false`, `fs.chmodSync(outfile, 0o755)`,
and identical `console.log`/`console.error`/`process.exit(1)` error handling.

**Estimated duplicated skeleton:** ~15 lines × 4 = ~60 lines.

**Verdict:** **Confirmed** — extract to `scripts/lib/build.mjs` with parameters for entry, output, externals, plugins.

# 15. `__dirname` Resolution Pattern

All 7 scripts in `scripts/` that need `__dirname` use the identical:

```ts
const __dirname = path.dirname(fileURLToPath(import.meta.url));
```

Files: `build-cli.mjs:15`, `build-maestro-p.mjs:15`, `build-permission-relay-bridge.mjs:24`,
`build-preload.mjs:15`, `refresh-bmad.mjs:16`, `refresh-openspec.mjs:21`, `refresh-speckit.mjs:23`.

**Verdict:** **Retain** — this is a standard ESM idiom; not worth abstracting for 7 instances.

# 16. Installer Scripts Duplication (`scripts/install-maestro-p/`)

`maestro-p-install.sh` (POSIX) and `maestro-p-install.ps1` (Windows) implement the same install flow:

1. Verify Node.js >= 20
2. Verify Bun
3. Warn about missing `claude` CLI
4. Download `maestro-p.js` + `package.json`
5. Run `bun install` for node-pty prebuild
6. Verify node-pty loads
7. Install shim to PATH
8. Verify version

**Evidence:** Same step ordering, same prerequisites, same download URLs, same verification logic.
Only shell syntax and path conventions differ.

**Estimated duplicated logic:** ~50 lines of equivalent flow per script.

**Verdict:** **Retain** — cross-platform installers must be native shells (POSIX sh / PowerShell)
for reliability; a shared core would require a runtime dependency and introduce cross-platform
execution risks. The duplication is intentional.

# 17. CDP Dev Helpers (`scripts/cdp-*.mjs`)

`cdp-eval.mjs` and `cdp-drive.mjs` share identical CDP connection boilerplate:

| Shared code            | cdp-eval.mjs                                | cdp-drive.mjs |
| ---------------------- | ------------------------------------------- | ------------- |
| Port resolution        | `process.env.MAESTRO_CDP_PORT \|\| '12345'` | Same          |
| `/json/list` fetch     | Line 13                                     | Line 15       |
| Page target selection  | `find(t => t.type === 'page')`              | Same          |
| WebSocket construction | Same options                                | Same options  |
| `send()` pattern       | `pending.set(msgId, resolve)`               | Same          |
| Message dispatch       | `msg.id && pending.has(msg.id)`             | Same          |

**Estimated duplicated boilerplate:** ~30 lines.

**Verdict:** **Verify then change**. Extract a shared `cdp-connect.mjs` that returns `{ ws, send, close }`.
Both scripts are developer tooling, so risk is low.

# 18. Release Workflow — Architecture Verification Duplication

`.github/workflows/release.yml` contains three near-identical "Verify native modules in package" steps:

| Step        | Platform                           | Script                      |
| ----------- | ---------------------------------- | --------------------------- |
| Windows x64 | `matrix.platform == 'win'`         | Inline PowerShell (300–330) |
| Linux x64   | `matrix.platform == 'linux'`       | Inline bash (360–407)       |
| Linux ARM64 | `matrix.platform == 'linux-arm64'` | Inline bash (410–448)       |

All three check for `pty.node` and `better_sqlite3.node` in the unpacked resources directory,
verify architecture with `file` command, and fail on mismatch.

Additionally, `.github/scripts/verify-native-arch.sh` and `.github/scripts/rebuild-and-verify-native.sh`
share ~25 lines of identical architecture-pattern matching and native-module path resolution.

**Verdict:** **Verify then change**. The platform-specific paths (unpacked directory names, module filenames)
are real differences (Windows uses `conpty.node` + `conpty_console_list.node`), but the verification
logic could be parameterized. The shell scripts should be merged into a single `verify-native-arch.sh`
that accepts an optional `--modules` parameter for platform-specific module lists.

# 19. `set-version.mjs` Spawns `npm` Despite Bun/Bunx Rule

`scripts/set-version.mjs:59` uses `spawn(command, commandArgs, { shell: true, … })` where
`command` comes from `args[0]` — the caller passes `npm run build` or `npm run build && electron-builder …`.
This is the same `dev.mjs` issue flagged in section 2.7: the project mandates Bun/Bunx but
the dev scripts invoke `npm` directly.

**Verdict:** **Retain for now** — changing this requires verifying that `bun run` produces identical
side-effects for `build:preload` (which calls `node scripts/build-preload.mjs`).

# 20. maestro-p `sleepSync` vs `sleep` Duplication

`src/maestro-p/args.ts:120-123` defines:

```ts
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
```

`src/maestro-p/session-watcher.ts:171-173` defines:

```ts
function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
```

Both are 3-line blocking/resume helpers used in polling loops. They serve different purposes
(sync backoff vs async delay) and are correctly separate.

**Verdict:** **Retain** — different execution domains (sync vs async).

# 21. `emitJsonl` Event Type Duplication (`src/cli/output/jsonl.ts`)

`src/cli/output/jsonl.ts:149-164` defines a 15-member `CliEvent` union type that mirrors
the event types emitted by `emitStart`, `emitDocumentStart`, `emitTaskStart`, `emitTaskComplete`,
`emitDocumentComplete`, `emitLoopComplete`, `emitComplete`, `emitHalt`, `emitError`,
`emitGroup`, `emitAgent`, `emitPlaybook`, `emitSetting`, `emitSettingSet`, `emitSettingReset`.

Each emitter function repeats the `type: '…'` literal that matches a union member.
This is intentional type safety, not duplication — the union ensures exhaustiveness.

**Verdict:** **Retain** — this is a well-contracted discriminated union.

# 22. Clean Areas (New Scope)

No meaningful duplication was found in these audited areas:

- `src/cli/output/verbosity.ts` — single-purpose state module, no duplicates
- `src/cli/output/formatter.ts` — CLI-specific formatting with documented differences from shared/formatters
- `src/maestro-p/package-info.ts` — single shared version constant, correctly used
- `src/maestro-p/plan-mode.ts` — single-purpose ExitPlanMode detector, no duplicates
- `src/maestro-p/stream-json-input.ts` — single-purpose image translation, no duplicates
- `src/maestro-p/json-emitter.ts` — single-purpose protocol emitter, no duplicates
- `src/maestro-p/jsonl-tailer.ts` — single-purpose JSONL polling, no duplicates
- `src/maestro-p/session-watcher.ts` — single-purpose session discovery, no duplicates
- `scripts/dev-port.mjs` — shared utility already used by both `dev.mjs` and `dev-demo.mjs`
- `scripts/notarize.js` — Electron Builder plugin hook, single consumer
- `scripts/setup-git-hooks.mjs` — single-purpose git hook installer
- `scripts/check-python.mjs` — single-purpose Python 3.12 distutils warning
- `scripts/ensure-electron.mjs` — single-purpose electron unpack repair
- `scripts/gen-cli-reference.mjs` — single-purpose reference generator
- `scripts/sync-release-notes.mjs` — single-purpose release note sync
- `scripts/refresh-bmad.mjs`, `refresh-openspec.mjs`, `refresh-speckit.mjs` — each fetches from a different upstream repo with different processing logic; the shared `httpsGet` is the only duplication
- `src/cli/commands/session.ts` — single-purpose session inspector, no duplicates
- `src/cli/commands/auto-run.ts` — single-purpose auto-run launcher, no duplicates
- `.github/workflows/stale.yml` — single-purpose stale bot, no duplicates
- `.github/workflows/plugin-sdk-publish.yml` — single-purpose SDK publish, no duplicates
- `.github/workflows/ci.yml` — single-purpose CI, no duplicates

# 23. Ordered Cleanup Queue — Additions

## Queue A — Small, high-confidence

24. Extract shared `httpsGet` into `scripts/lib/http.mjs` for refresh scripts (~60 lines saved).
25. Extract shared esbuild skeleton into `scripts/lib/build.mjs` (~60 lines saved).
26. Consolidate CDP dev helpers into `scripts/lib/cdp.mjs` (~30 lines saved).

## Queue B — Contract and build verification

23. Characterize CLI error-output contracts, then consolidate only compatible command families.
24. Merge `verify-native-arch.sh` and `rebuild-and-verify-native.sh` into a single parameterized script.
25. Parameterize release.yml native-module verification steps.

## Queue C — Developer tooling

29. Replace `npm` invocations in `dev.mjs` and `set-version.mjs` with `bun`/`bunx` after verifying side-effects.

# 24. Verification Matrix — Additions

| Change family                | Required proof                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| CLI error envelopes          | Run `maestro-cli settings get nonexistent` and `maestro-cli list agents --json` in error path; verify JSON output and exit code 1    |
| `reportError` JSON vs stderr | Run `maestro-cli cue pipeline add` with invalid JSON file; verify `console.error` vs `console.log` behavior                          |
| Shared httpsGet              | Run each `refresh-*.mjs` and verify identical upstream fetch behavior                                                                |
| Shared esbuild               | `bun run build:cli`, `bun run build:maestro-p`, `bun run build:permission-relay-bridge`; compare produced paths and runtime metadata |
| CDP helpers                  | Run `node scripts/cdp-eval.mjs '1+1'` and verify output matches standalone behavior                                                  |
| Shell script merge           | Run `./.github/scripts/verify-native-arch.sh x64` and `arm64` on a built tree                                                        |

# 25. Expanded Domain Audit — Reconciled Findings

Eight additional Task audits covered renderer workspace UI, renderer feature UI, renderer hooks/stores/services, the main web stack, provider/session infrastructure, remaining main infrastructure, CLI/build automation, and cross-platform/preload/shared surfaces. This section records new findings and overrides overconfident verdicts from raw agent reports.

## 25.1 Main-process SSH lookup and resolution

### Remote lookup duplication

`src/main/stores/getters.ts:121` already exports `getSshRemoteById`, but local lookup helpers or inline store searches remain in:

- `src/main/ipc/handlers/agentSessions.ts`
- `src/main/ipc/handlers/agents.ts`
- `src/main/ipc/handlers/autorun.ts`
- `src/main/ipc/handlers/marketplace.ts`
- `src/main/ipc/handlers/ssh-remote.ts`
- large filesystem and git handler call families

Several variants intentionally reject disabled remotes while the canonical getter only matches by ID.

- Estimated removable duplication: **45–60 lines**.
- Verdict: **Verify then change**. Make enabled-state policy explicit rather than adding a hidden boolean option to a generic getter.

### Spawn-pipeline adapter creation

Repeated `createSshRemoteStoreAdapter(settingsStore)` → `getSshRemoteConfig(...)` sequences appear in:

- `process/process/wrap-spawn-for-ssh.ts`
- `process/process/resolve-claude-spawn-context.ts`
- `tabNaming.ts`
- `process.ts`

- Estimated removable boilerplate: **60–80 lines**.
- Verdict: **Verify then change**. Prefer a named spawn-context resolver over exposing adapter construction at every call site.

### Rejected SSH abstraction

Do not merge all remote lookup and spawn resolution into one helper. ID lookup, enabled-policy enforcement, session SSH configuration, remote working-directory resolution, and command construction are different contracts.

## 25.2 Renderer store primitives

### Value-or-updater resolution

Byte-identical `resolve<T>(valueOrUpdater, previous)` helpers appear in:

- `sessionStore.ts`
- `batchStore.ts`
- `fileExplorerStore.ts`
- `groupChatStore.ts`
- `uiStore.ts`

- Estimated removable duplication: **approximately 16 lines net** after one `resolveUpdater` utility.
- Verdict: **Confirmed, small**.

### Legacy notification color resolution

`notificationStore.ts` and `centerFlashStore.ts` independently map legacy variants to the same colors and prefer explicit `color` over the derived value.

- Estimated removable duplication: **approximately 10–15 lines**.
- Verdict: **Confirmed after type compatibility check**.

### Rejected store abstractions

- Do not create a generic store solely to share two `__resetForTests` implementations. Test-only reset code is clearer inline.
- Do not generate renderer IPC services from string paths. Existing `createIpcMethod` call sites preserve differing defaults, rethrow behavior, and compound calls; a macro-like factory would trade visible code for configuration.
- Do not generate tab handlers from generic callback factories. Tab-specific state transitions and dependencies are the behavior.

## 25.3 TabBar implementation family

The four main tab types repeat a real interaction and presentation family:

| Pattern                        | Locations                           | Raw repeated LOC | Verdict                                                                      |
| ------------------------------ | ----------------------------------- | ---------------: | ---------------------------------------------------------------------------- |
| Inline `ShortcutHint`          | AI overlay, browser, file, terminal |              ~28 | Confirmed                                                                    |
| Middle-click close             | AI, browser, file, terminal         |              ~36 | Confirmed behavior; consolidate only with a shared tab interaction primitive |
| Close-button propagation       | AI, browser, file, terminal         |              ~28 | Confirmed behavior                                                           |
| Coarse-pointer select/overlay  | AI, browser, file, terminal         |              ~32 | Verify; overlay policy may differ                                            |
| Drag-start setup               | Four tab types                      |              ~48 | Verify icon and drag-image differences                                       |
| Active/hover/border style memo | Five tab/chip types                 |             ~175 | Verify; GroupTabChip has a different active color                            |

Preferred direction: start with `ShortcutHint`. For event handlers and styles, avoid a collection of `makeXHandler` factories that allocates and obscures dependencies; consider a cohesive shared tab-chip primitive only if the complete prop contract stays smaller than the duplicated code.

Additional verification:

- `AITab.tsx` re-exports `getTabDisplayName`; run LSP references before removing the compatibility surface.
- `MainPanelContent` and Quick Actions remain structural hotspots, not deduplication candidates.

## 25.4 Renderer feature UI

### Existing modal primitive is bypassed

`src/renderer/components/ui/Modal.tsx` already owns portal, layer, backdrop, resize, and focus behavior. Several feature modals still assemble subsets of that shell manually.

- Verdict: **Inventory and migrate by modal contract**.
- The raw audit's **2,500–3,500 line** saving estimate is rejected: it counted substantial modal-specific headers, bodies, and animation as shell duplication and included modals already using the primitive.
- Required proof: per-modal priority, persisted resize key, focus behavior, backdrop dismissal, escape handling, and minimize/restore animation.

### Smaller reusable presentation patterns

- `CueHelpModal` and `HistoryHelpModal` repeat icon/title/body section markup. A `HelpSection` component is a plausible **~100–150 line** reduction.
- Symphony and Marketplace headers share layout, help-popover, refresh, cache-status, and close structure. A feature-header shell is plausible, but content and registration actions remain feature-owned.
- Repeated feature-card borders are design-system styling, not sufficient reason for a generic card data model.
- Agent status pills share visual chrome but not status semantics; reuse only a presentational badge primitive.

### Feature UI retained

History components, Coworking hosts, ProcessMonitor hooks/views, Symphony helper modules, Marketplace tiles, and Director Notes tabs are appropriately decomposed. `FeedbackChatView`, `AgentSessionsModal`, and `HistoryDetailModal` are large single-feature modules; splitting them moves lines and improves ownership but is not deduplication.

### Possible dead hook

`SymphonyModal/hooks/useDocumentCycle.ts` needs LSP-reference verification. No deletion verdict is recorded without that proof.

## 25.5 Cross-platform and preload findings

### Shared history type

The preload Director Notes surface defines a `UnifiedHistoryEntry` shape also present in `src/shared/history.ts`.

- Verdict: **Verify then change** using LSP references and preload compilation.
- Keep preload API objects narrow; importing a shared wire type is different from collapsing namespaced preload APIs.

### Group-chat preload types

Preload group-chat models resemble shared group-chat types but may intentionally represent the serialized IPC boundary.

- Verdict: **Verify field-for-field**. Use composition or imports only when optionality and serialization match.

### Web and renderer UI primitives

Web `Button`, `Card`, and `Badge` resemble renderer primitives but include PWA/offline behavior and compile into a different surface.

- Verdict: **Architecture investigation, not confirmed duplication**.
- Do not place React components in `src/shared` merely to share markup. A dedicated UI package is justified only if both bundles can consume it without Electron dependencies, styling drift, or platform conditionals.

### Clean cross-platform areas

Preload namespace organization, preload response wrappers, web utilities, web shortcut filtering, Cue contracts, domain constants, and E2E fixtures are intentional and should remain.

## 25.6 Provider/session correction and clean areas

The expanded provider audit corrected and confirmed the `ACCOUNT_DIR_EXCLUDE_RE` location now recorded in section 1.3: the duplicate is in Claude and Codex usage-startup modules, not session-storage providers.

No additional provider-wide abstraction is recommended:

- storage implementations correctly extend `BaseSessionStorage`;
- provider parsers preserve distinct event/content/error contracts;
- Qwen intentionally extends the Claude parser;
- local, SSH, PTY, child-process, and OpenCode-server spawners have different process models;
- usage samplers use materially different data sources.

## 25.7 Main infrastructure retained

No redundant window manager, window registry, crash handler, state persistence module, cross-agent router, logger, marketplace service, or Symphony runner was found.

Module-level plugin sandbox maps and timers lack a global disposal surface, but Electron process exit currently owns their lifetime. This is a lifecycle design consideration, not garbage or duplication.

Do not blanket-replace timer maps with the scalar `debounce` utility. Per-key debounce, polling, delayed escalation, queued processing, and buffered flushes are different mechanisms.

## 25.8 Reconciliation overrides for sections 11–24

The following verdict refinements override stronger wording in the raw web/CLI audit sections:

1. The `web-server-factory.ts` request/response pattern is real, but replacing 50+ callbacks with one generic bridge requires typed channel, timeout, error, and teardown contracts. Treat the projected reduction as **verify then change**, not automatic deletion.
2. `messageHandlers.ts` repeats protocol handling structure, but one generic dispatcher would hide response type strings and domain validation. Prefer a few domain-scoped helpers after contract tests.
3. `WebServer.broadcast*` methods are a public facade over `BroadcastService`; removing proxies mostly moves callers and may save little net LOC.
4. `CallbackRegistry` fallback settings appear unreachable in the current factory, but deletion requires a constructor invariant or a test proving callback registration precedes every read.
5. CLI error-envelope consolidation must preserve stdout versus stderr, JSON mode, exit codes, and command-specific cleanup. It remains **verify then change** despite broad structural repetition.
6. Refresh-script HTTP helpers, CDP connection plumbing, and native-module verification are suitable build-tooling candidates because their parameter differences are explicit.

## 25.9 New cleanup priority additions

30. Consolidate the five renderer `resolveUpdater` copies.
31. Extract the shared TabBar `ShortcutHint`.
32. Consolidate legacy notification color resolution.
33. Centralize SSH remote lookup after documenting enabled-state policy.
34. Centralize spawn SSH adapter/config resolution.
35. Migrate exact shared/preload history types.
36. Extract `HelpSection` after visual verification.
37. Evaluate a cohesive TabBar interaction/style primitive; reject isolated handler factories.
38. Inventory manual modal shells against `ui/Modal.tsx`.
39. Verify `useDocumentCycle` references.

## 25.10 Expanded audit limitations

- All findings remain static-analysis results until their verification scenarios run.
- Agent estimates are approximate and often gross repeated lines rather than net savings after replacement code.
- Concurrent agents initially wrote raw web/CLI sections directly into this report despite read-only instructions; section 25 is the parent reconciliation and controls where verdicts conflict.
- One temporary renderer-feature report was folded into this canonical file and removed.
- No Maestro source files were changed by this audit.

# 26. Specialized Surface Audits — Reconciled Findings

Five further Task audits covered shared symbols, Electron bridge symmetry, plugin runtime internals, test infrastructure, and the repository dependency/build graph. Two agents failed during final output, and two initially returned metadata-only payloads; their source evidence was recovered from transcripts before reconciliation.

## 26.1 Shared validators and policy helpers

### `isRecord` — expanded evidence for section 10.4

The additional scan found more names for the same unknown-object guard already recorded as `isPlainObject` in section 10.4:

- `src/shared/agent-run/pianola-adapter.ts`
- `src/shared/campaign/validators.ts`
- `src/shared/pianola/pianola-tasks.ts`
- `src/shared/pianola/storage.ts`
- `src/shared/plugins/mcp-protocol.ts`

All use `typeof value === 'object' && value !== null && !Array.isArray(value)`.

- Verdict: **Part of the existing section 10.4 finding**, not a separate helper or savings estimate.
- Canonical direction remains one narrowly named shared unknown-object/record guard in an object/validation utility.

### `hasInvalidOptionalStrings`

Byte-identical implementations exist in:

- `src/shared/agent-run/validators.ts`
- `src/shared/campaign/validators.ts`

- Plausible net saving: **approximately 3 lines**.
- Verdict: **Confirmed but low value**. Consolidate only alongside broader validator cleanup.

### `isNonEmptyString` policy correction

Two actual policy families exist:

- `value.length > 0` accepts whitespace-only strings.
- `value.trim() !== ''` rejects whitespace-only strings.

The families must not be described in reverse. Standardize only after deciding which fields permit whitespace.

### `isAdaptiveModeDefaultOn`

`src/shared/agentConstants.ts` exports `isAdaptiveModeDefaultOn(_agentId)`, which ignores the agent and always returns `false`. It has multiple production callers, so it is not dead code; it is a policy indirection with a currently meaningless parameter.

- Verdict: **Policy decision**. Either document the universal-off policy and replace it with a constant, or implement the intended per-agent policy. Do not remove it as garbage without deciding the product default.

### Shared surface retained

Duration formatter variants, shared barrels, prompt bundles, Cue contracts, path/color/math utilities, agent/campaign lifecycle types, and provider-specific validators have distinct contracts. No barrel-induced compatibility debt was established.

## 26.2 Electron bridge symmetry

The bridge audit produced several false positives by searching only `src/main/ipc/handlers` for event producers. Parent verification found:

- `power:setEnabled` and `power:isEnabled` are registered in `src/main/ipc/handlers/system.ts`.
- `globalHotkey:registrationFailed` is sent from `src/main/index.ts`.
- `app:systemResume` is sent from `src/main/index.ts`.
- `browser-tab:shortcutKey` is sent from `src/main/app-lifecycle/guest-webview-security.ts`.
- `app:deepLink` is owned by `src/main/deep-links.ts`.

These preload listeners are **not orphaned** and the power setting path is **not broken**.

### Deprecated notification alias

`notification.onTtsCompleted` and `notification.onCommandCompleted` subscribe to the same channel. Current renderer consumers use `onCommandCompleted`; static search found only the deprecated declaration and preload implementation for `onTtsCompleted`.

- Potential removal: **approximately 6 lines plus its global type declaration**.
- Verdict: **Verify then remove** using LSP references and preload API compatibility checks.

### Exposed but currently unconsumed namespaces

Tunnel, font detection, shell detection, update operations, and several app lifecycle methods have handlers or event producers but sparse renderer usage.

- Verdict: **Retain pending product/API review**. An exposed preload method with no current renderer caller is not dead when it represents an optional feature, external automation surface, or event subscription.

## 26.3 Plugin runtime audit

The deep plugin-runtime audit mostly reinforced existing section 10 findings:

- repeated plugin `isPlainObject` and `isNonEmptyString` guards;
- near-duplicate `isSafeRelativeEntry` policies;
- repeated `WINDOWS_RESERVED` regex;
- correctly shared payload-byte helpers and host-view limits.

No new high-value runtime deletion was established. Plugin command registry, background supervisor, renderer grouping adapters, host action handlers, sandbox bootstrap, capability arrays, and E2E harnesses remain distinct or intentionally self-contained.

The stricter `isSafeRelativeEntry` implementation is not automatically canonical: rejecting additional path spellings is security-compatible but still requires manifest compatibility tests for existing plugins.

## 26.4 Test infrastructure

### Per-file Lucide mocks

Dozens of tests declare local `vi.mock('lucide-react', ...)` blocks despite a global Proxy-based icon mock in `src/__tests__/setup.ts`.

- Gross repeated code: **hundreds of lines**, potentially more than 1,000.
- Verdict: **Verify in batches**. Local mocks sometimes provide ad-hoc test IDs or markup relied upon by assertions. Remove only those whose tests pass against the global mock; change assertions to target product semantics rather than mock-specific emoji or SVG structure.

### Session and tab test factories

The canonical `mockSession.ts` and `mockTab.ts` helpers are wrapped or reimplemented across renderer tests. Twenty-plus files add small ID/CWD overrides, and `ThinkingStatusPill.test.tsx` carries a separate session object body.

- Verdict: **Consolidate exact factories**, but retain test-specific overrides as explicit options.
- Avoid replacing platform-path test cases with `/test/project` when the path itself is the behavior under test.

### Cue executor factory

`cue-executor.test.ts` contains a local `createMockSession` equivalent to `cue-test-helpers.ts`, while other Cue tests already import the helper.

- Potential net saving: **approximately 10 lines**.
- Verdict: **Confirmed test cleanup**.

### Electron mocks

Many main-process tests repeat small `vi.mock('electron', ...)` blocks, but their `app.getPath`, `ipcMain`, `BrowserWindow`, packaging, and platform contracts differ.

- Verdict: **Share opt-in factory pieces**, not one mutable global Electron mock. Test isolation and explicit platform behavior outweigh maximum line deletion.

### Test infrastructure retained

Independent worktree config copies are normal checkout contents, not repository duplication. E2E fixtures, plugin signing fixtures, listener-leak helpers, path-expect helpers, theme mocks, and local-storage helpers are legitimate canonical test utilities.

## 26.5 Dependency and build graph

### CI package-manager drift

`.github/workflows/ci.yml` uses `npm ci`, `npx prettier`, `npx eslint`, and `npm run`, while repository-local validation and project rules use Bun/Bunx.

- Verdict: **Confirmed workflow drift**.
- Required proof: run the complete Linux and Windows CI matrix with Bun lockfile/install semantics before cutover.

### Forced native rebuild

The root `postinstall` always runs `electron-rebuild -f -w node-pty,better-sqlite3`.

- Verdict: **Performance investigation**. The forced rebuild may be necessary for Electron ABI correctness; do not remove `-f` until fresh install, cache-hit install, Electron upgrade, and packaged-app native loading are verified.

### Web-desktop chunk configuration

`vite.config.web-desktop.mts` contains explicit `dayjs` and `khroma` chunk rules despite no direct source import found by the agent.

- Verdict: **Verify transitive bundle membership**. Manual chunk rules may intentionally isolate transitive dependencies; source grep alone cannot prove dead configuration.

### Unreferenced build assets

`build/new-icon/` and `build/archive/` appear unreferenced by current build configuration and are not ignored.

- Verdict: **Verify then remove**. Confirm packaging, release, documentation, and manual design workflows before deleting binary/icon assets.

### Dependency false positive

Do **not** remove `@types/adm-zip` or `@types/archiver`. The installed `adm-zip@0.5.17` and `archiver@7.0.1` package manifests contain no bundled TypeScript declaration entry and publish only JavaScript files.

### Active dependency set

Direct evidence confirmed active use of Lucide, confetti, diff rendering, syntax highlighting, D3, archive libraries, SQLite, picomatch, Markdown/YAML tooling, WebSocket, QR code, Electron devtools, and development instrumentation dependencies.

Electron Builder resource-array duplication and `dev.mjs` npm usage were already covered by earlier report sections and are not counted again.

## 26.6 New cleanup priority additions

40. Consolidate `hasInvalidOptionalStrings` during validator cleanup.
41. Decide and document Adaptive Mode default policy.
42. Verify and remove deprecated `notification.onTtsCompleted`.
43. Migrate exact test session factories to canonical helpers.
44. Remove the Cue executor's local session factory copy.
45. Trial removal of per-file Lucide mocks in representative batches.
46. Convert CI from npm/npx to Bun/Bunx after matrix verification.
47. Prove or remove unreferenced build icon archives.
48. Inspect web-desktop bundle output before changing manual chunks.

## 26.7 Audit limitations

- Bridge reachability crosses IPC handlers, main-process event producers, preload exposure, renderer consumers, and optional public APIs; absence in one layer is not deletion proof.
- Test duplication estimates are gross and assertion-sensitive.
- Dependency conclusions did not include a full lockfile/transitive graph.
- No runtime tests, builds, or package removals were performed.
- No Maestro source files were changed; only this canonical report was updated.

## 27. Clone Saturation Wave 1 - Reconciled Findings

Five default Task agents searched structural clone families rather than directory samples. Two agents returned `NO_NEW_DUPLICATION`; one failed during final output after improperly spawning its own scouts, so its evidence was recovered from the original agent and reconciled conservatively. No Maestro source files were changed.

### 27.1 Confirmed exact or near-exact clones

#### Quoted argument parsing

- `src/main/utils/agent-args.ts:51-63` and `src/main/process-manager/spawners/PtySpawner.ts:62-75` use the same quoted-token regex, quote stripping, and empty fallback.
- Verdict: **Confirmed, small**. Export one parser from the existing argument utility and exercise empty, mixed-quote, and unterminated-quote behavior before migrating the PTY caller.

#### Plugin state and grant-file persistence

- `src/main/plugins/plugin-store-main.ts` repeats the same missing-file fallback, JSON parse/validate fallback, directory creation, tab-indented JSON serialization, temporary-file write, and rename in `readPluginState`/`readGrantsFile` and `writePluginState`/`writeGrantsFile`.
- Verdict: **Confirmed, local extraction**. Use private generic read/write functions in this module; do not generalize across the security boundary until failure semantics match `atomic-json-store`.

#### Authorization-ledger tombstones

- `src/main/plugins/authorization-ledger.ts:336-360` repeats epoch bump, entry deletion, prior-tombstone filtering, tombstone insertion, and persistence in `revoke` and `uninstall`; only their preconditions differ.
- Verdict: **Confirmed, local extraction**. Preserve the authoritative-uninstall precondition and route only the shared mutation through one private method.

#### Home-directory expansion

- `src/main/process-manager/utils/envBuilder.ts` repeats the same `~/` expansion in `buildPtyTerminalEnv`, `collectMaestroEnvVars`, and `buildChildProcessEnv`; `LocalCommandRunner` contains another copy.
- Verdict: **Confirmed**. One path-expansion helper should own Windows/home-directory semantics.

#### Minimal error-message extraction

- `src/main/ipc/handlers/agent-run.ts:27-29` and `src/renderer/hooks/agentRun/useAgentRun.ts:40-42` define the same `Error.message`/`String(value)` function.
- Verdict: **Confirmed but currently zero-value**. A shared import would save little or no code. Retain unless a broader error-normalization cleanup creates a natural home.
- Rejected overlap: `src/web-desktop/sentry-shim.ts:15-24` is intentionally different; it JSON-serializes non-string objects before falling back to `String`.

### 27.2 Confirmed structural duplication with drift

#### Cue YAML mutation pipeline

- `cue-engine.ts` subscription and settings writers plus `cue/cue-self-destruct.ts` all read, parse, mutate, dump, and write `cue.yaml`, but use different dump options and atomic-write behavior.
- Verdict: **Confirmed correctness hotspot**. Define a repository mutation contract covering serialization options, atomicity, error behavior, and comment-preservation expectations before consolidating callers.

#### Cue query traversal

- `src/main/cue/cue-query-service.ts:getStatus` and `getGraphData` independently traverse active sessions, track reported sessions, then load inactive-session configuration; only their projections and filters differ.
- Verdict: **Confirmed**. Extract traversal/data loading while retaining explicit projection functions.

#### Provider-local session metadata

- Codex, Factory Droid, and OpenCode storage providers each duplicate substantial local-versus-remote metadata construction inside the same provider. Both paths parse metadata, scan transcript records, and calculate previews/counts/duration/tokens; drift already exists, including `byModel` only on one path.
- Verdict: **Confirmed within-provider duplication**. Consolidate each provider independently; do not introduce one cross-provider parser.

#### Transcript parsing for read and search

- Claude and Codex storage providers reparse the same transcripts separately for full message reads and searchable-message extraction. Copilot already demonstrates the safer pattern: one parsed-event stream feeds both projections.
- Verdict: **Confirmed**. Introduce provider-local parsed-event functions, then derive display and search views.

#### Sandbox payload-size checks

- `src/main/plugins/plugin-sandbox-host.ts` repeats JSON serialization, `MAX_MESSAGE_BYTES` enforcement, and message-send error handling across command, tool, and child-message paths.
- Verdict: **Confirmed, security-sensitive**. Share the byte-bound check without collapsing distinct request/response authorization paths.

#### Managed-process base fields

- `PtySpawner`, `ChildProcessSpawner`, and `OpencodeServerSpawner` independently construct the same `ManagedProcess` base fields, with drift such as missing `maestroEnvVars` on one path.
- Verdict: **Confirmed design drift**. Define a typed base constructor/factory; keep transport-specific fields explicit.

#### Capability truth split

- `src/main/agents/definitions.ts` expresses support through argument fields while `src/main/agents/capabilities.ts` repeats the same facts as booleans. Adding or changing an agent requires synchronized edits.
- Verdict: **Confirmed source-of-truth duplication**. Derive capability booleans from definitions where semantics are exact; retain explicit overrides only for exceptions.

### 27.3 Verify-before-consolidation families

- Scalar trailing-edge debounce hand-rolls remain in settings watching, Cue config, marketplace watching, persistence, and Pianola despite `src/main/utils/debounce.ts`. Migrate only callsites whose cancellation and return semantics match.
- Atomic temporary-file/rename writes recur across Cue, transcript mirror, plugin stores, KV storage, and the authorization ledger. Their sync/async, JSON/text, permissions, error, and security semantics differ; expand `atomic-json-store` only behind contract tests.
- `CueRunResult` success/running/final envelopes repeat fields across executors and run-manager, but represent different lifecycle states. Prefer named constructors per state over one permissive envelope factory.
- Session-provider delete flows share guards and failure envelopes, but transcript boundaries and remote-delete support differ. Consolidate within provider or by proven sub-step only.
- PTY exit, generic exit handling, and explicit process killing all flush/emit/delete state, but ownership and timing differ. Treat this as lifecycle verification, not an automatic helper.
- Renderer session-group deletion and session deletion repeat a five-line active-session fallback. The clone is real but a helper would likely increase code; document the invariant or consolidate only during nearby lifecycle work.
- Two inline-wizard services return similar failure objects and invoke `onError`, but one logs and their service contracts differ. Verify a common result type before extracting behavior.

### 27.4 Clean areas and rejected candidates

- The renderer component saturation agent found no net-new duplication after excluding every previously reported family. Existing shared modal, list-navigation, debounce, click-outside, search, and UI primitives are used consistently.
- Tests, E2E, scripts, configs, workflows, and assets produced no net-new finding beyond sections 13, 14, 17, 18, 26.4, and 26.5.
- E2E fixture setup, target-specific Vitest/Vite configs, installer scripts, and plugin/browser harnesses have distinct contracts and remain retained.

### 27.5 Cleanup priority additions

49. Canonicalize quoted argument parsing.
50. Extract plugin-store state/grant persistence locally.
51. Extract authorization-ledger tombstone mutation.
52. Define and migrate one Cue YAML mutation contract.
53. Share Cue query session traversal.
54. Consolidate local/remote metadata inside each provider.
55. Parse provider transcripts once for read and search.
56. Centralize `~/` expansion.
57. Create a typed `ManagedProcess` base constructor.
58. Derive agent capabilities from one source of truth.
59. Share sandbox payload-byte enforcement.
60. Verify scalar debounce migrations and atomic-write contracts.

### 27.6 Wave limitations

- Findings are static-analysis results until their targeted verification scenarios run.
- Gross repeated lines are not net savings; several small clones should remain local because imports or generalized APIs would add more code.
- The recovered main-process report included nested-agent evidence despite an explicit no-spawn constraint. Every recovered item was downgraded unless it had exact paths and a narrow, testable consolidation direction.

## 28. Clone Saturation Wave 2 - Reconciled Findings

Five default Task agents searched orthogonal semantic categories. Two categories produced no new duplication. One agent failed while yielding and its report was recovered directly; all source files remained read-only.

### 28.1 Existing renderer hooks bypassed

#### `useClickOutside`

- At least six components hand-roll ref containment, document `mousedown` registration, and cleanup despite `src/renderer/hooks/ui/useClickOutside.ts` supporting conditional activation, delayed activation, multiple refs, and arbitrary close-side effects.
- Pure or directly compatible callers include `SshRemoteModal`, `RepositoryDetailView`, `DocumentSelector`, `BrowserProfileMenu`, and likely `AgentConfigPanel`. `SessionList` has a separate DOM-selector exclusion that the hook does not model.
- Verdict: **Confirmed bypassed utility**. Migrate compatible callsites; retain exceptional hit-testing unless the hook gains an explicit exclusion predicate justified by multiple callers.

#### `useListNavigation`

- `FileSearchModal`, `CommandHistoryPopover`, `useTemplateAutocomplete`, `GroupChatInput`, and `InlineToolbar` hand-roll ArrowUp/ArrowDown/Enter selection.
- `src/renderer/hooks/keyboard/useListNavigation.ts` already supports clamped or wrapped navigation, selection, reset, number keys, Vim keys, and paging.
- Verdict: **Confirmed bypassed utility**. Migrate only after comparing each caller's Escape handling, initial index, focus ownership, wrapping, and event propagation.

#### Escape delegation

- `DocumentSelector`, `SessionList`, `EmptyStateView`, and `BrowserProfileMenu` attach local Escape listeners while layer-stack infrastructure already provides ordered Escape callbacks for registered overlays.
- Verdict: **Verify then change**. Menus that are not layer-stack participants must not be forced into modal semantics. First establish overlay ownership and focus restoration; migrate only registered layers.

### 28.2 Inline Wizard auto-scroll state machine

- `StreamingDocumentPreview` and `WizardConversationView` both track user scrolling, compare remaining scroll distance against a threshold, suppress automatic scrolling after user movement, and scroll to the bottom while auto-scroll remains active.
- Intentional options differ: 50px versus 80px threshold, filename reset, a resume button, and forced scroll after a new user message.
- Verdict: **Confirmed configurable behavior**. Extract a focused `useAutoScrollToBottom` hook only if its options preserve these four differences explicitly.

### 28.3 Comment-JSON installer persistence

- `src/main/coworking/installers/claude-code.ts`, `factory-droid.ts`, and `opencode.ts` contain byte-identical comment-JSON `readConfig`/`writeConfig` pairs; only their config paths and domain mutations differ.
- `codex.ts` is intentionally excluded because it reads and writes TOML text.
- Verdict: **Confirmed**. Extract installer-local generic comment-JSON readers/writers around the existing atomic file writer. Preserve per-installer paths and mutation logic.

### 28.4 Path normalization family

- `src/renderer/utils/worktreeDedup.ts` and `src/main/storage/copilot-session-storage.ts` share separator conversion, duplicate-separator collapse, and trailing-separator removal. Copilot additionally folds Windows drive-letter case.
- `src/main/stats/utils.ts` performs only separator conversion; `TabSwitcherModal` performs only trailing-separator removal.
- `src/shared/plugins/permissions.ts` is deliberately excluded: it resolves `.` and `..` at a security boundary and therefore has a materially different contract.
- Verdict: **Confirmed core with policy variants**. Define comparison-path semantics and tests before moving the core to shared code; avoid a loosely specified boolean option if named wrappers communicate case-folding policy better.

### 28.5 Rejected candidates

- Three test-local copies of `validatePathWithinFolder` are test duplication, not a new production abstraction. Do not export an IPC-handler private solely to reduce test lines; test through the observable handler or move the pure security predicate only if production reuse appears.
- Eight Electron quit listeners have different resources, events, ordering needs, and teardown contracts. A global lifecycle registry would centralize registration without deleting behavior and could add ordering risk.
- `RepositoryTileSkeleton` and dashboard `SkeletonBox` have similar pulse styling but belong to different feature surfaces. One additional instance does not justify cross-feature coupling.
- Existing `truncateText` variants, test mocks, bridge contracts, E2E fixtures, scripts, workflows, and SDK mirrors were already recorded or intentionally retained.

### 28.6 Cleanup priority additions

61. Migrate compatible click-outside handlers to `useClickOutside`.
62. Migrate compatible keyboard lists to `useListNavigation`.
63. Verify Escape ownership against the layer stack.
64. Extract configurable Inline Wizard auto-scroll behavior.
65. Share comment-JSON installer persistence.
66. Define and centralize comparison-path normalization.

### 28.7 Wave limitations

- The UI agent proposed creating a new list-navigation hook even though one already exists. Reconciliation corrected the direction to migration into the current hook.
- Net savings depend on compatibility with existing hook event propagation and focus behavior; static shape alone is insufficient.
- No runtime or visual verification was performed, and no Maestro source files were changed.

## 29. Clone Saturation Wave 3 - Reconciled Findings

Five more default Task agents audited deep main, deep renderer, peripheral runtimes, support infrastructure, and a repository-wide adversarial clone inventory. Main-process and support scopes returned `NO_NEW_DUPLICATION`. Two narrow formatter families were net-new.

### 29.1 HTML escaping

- `src/renderer/utils/groupChatExport.ts` and `src/renderer/utils/tabExport.ts` contain the same five-character HTML escaper.
- `src/renderer/components/FilePreview/markdownFast/escapeHtml.ts` already exports the equivalent implementation; the only output-byte difference is `&#039;` versus `&#39;` for apostrophes, which browsers decode identically.
- `TextPreviewFast.escapeHtmlForPre` remains excluded because its preformatted-text context intentionally does not escape apostrophes.
- Verdict: **Confirmed semantic duplicate**. Move the canonical five-character escaper to a neutral renderer utility rather than importing from a feature-specific `markdownFast` directory. Add raw-output expectations because rendered equivalence does not imply byte-identical export files.

### 29.2 Decimal duration formatting

- `src/cli/commands/director-notes-history.ts:formatDurationMs` and `src/shared/formatters.ts:formatDurationDecimal` have identical thresholds, precision, units, and output.
- The shared formatter is already consumed elsewhere in CLI output.
- Verdict: **Confirmed exact duplicate**. Replace the local function with the shared import and exercise the director-notes table output boundaries at 1 second, 1 minute, and 1 hour.

### 29.3 Rejected renderer async-guard abstraction

- Twelve effects use a closure-local `cancelled` boolean, and seven callsites use a monotonic request ID to reject stale async responses.
- These are related idioms, not interchangeable implementations: effect cleanup cancellation and latest-request ordering have different lifetimes and correctness guarantees. A generic hook would hide dependency/reset semantics and showed no defensible net savings after callbacks and imports.
- Verdict: **Retain local idioms**. Prefer `AbortSignal` only where the underlying operation supports actual cancellation; do not replace stale-result guards with cosmetic shared state.

### 29.4 Cleanup priority additions

67. Centralize renderer HTML escaping in a neutral utility.
68. Replace CLI `formatDurationMs` with `formatDurationDecimal`.

### 29.5 Wave limitations

- Entity spelling in exported HTML is externally observable as bytes even when browser rendering is identical.
- No runtime, export, or CLI verification was performed, and no Maestro source files were changed.

## 30. Clone Saturation Wave 4 - Reconciled Findings

Five default Task agents inverted the audit through exact-clone, control-flow, canonical-utility-bypass, and compatibility scans. The exact-clone inventory produced many one-line coincidences; only candidates with a plausible contract and positive net value are retained below. One renderer agent violated the read-only contract by editing `useInputKeyDown.ts`; that exact hunk was detected and reverted before reconciliation.

### 30.1 Preload listener registration

- More than forty methods across `src/main/preload/{groupChat,process,system,agentRun,coworking,plugins,sessions,...}.ts` repeat the same event-argument adapter, `ipcRenderer.on`, and exact-listener removal.
- Payload tuple types and channels differ, but listener ownership and teardown are identical.
- Verdict: **Confirmed high-volume duplicate**. Add one typed preload-local subscription helper that strips the Electron event argument and returns the exact cleanup closure. Preserve specialized wrappers that transform payloads or subscribe to multiple channels.

### 30.2 Command-panel state and mutations

- `BmadCommandsPanel`, `OpenSpecCommandsPanel`, `SpecKitCommandsPanel`, and `AICommandsPanel` repeat command/metadata loading, edit/save/reset state, expanded-set mutation, error capture, and date formatting.
- Verdict: **Confirmed bounded feature-family duplication**. Extract a command-panel hook parameterized by the existing namespace/API adapter; keep rendering and feature-specific command shapes explicit.

### 30.3 SSH execution timeouts

- `probeRemoteMaestroP.ts` and five paths in `ipc/handlers/agents.ts` repeat `execFileNoThrow`, a typed rejecting timeout promise, and `Promise.race`.
- Verdict: **Confirmed**. One main-process SSH execution helper should own timer cleanup, timeout errors, and child-process result typing. The helper must clear its timer after command completion; merely copying the current `Promise.race` can leave redundant timers alive.

### 30.4 CLI command-family duplicates

#### Environment arguments

- `create-agent.ts`, `create-ssh-remote.ts`, and `update-agent.ts` repeat `KEY=VALUE` splitting, malformed-entry reporting, JSON/human output selection, and process exit.
- Verdict: **Confirmed parser family**. Separate pure parsing from CLI rendering/exiting so the parser can be tested without terminating the process.

#### Cadenza and Movement

- `cadenza.ts` and `movement.ts` repeat body-file resolution and almost the entire Maestro-client send/success/error envelope.
- Verdict: **Confirmed sibling-command duplication**. Share the body resolver and a narrowly typed command sender; do not create a universal CLI dispatcher that erases response types.

#### Notification validation

- `notify-toast.ts` and `notify-flash.ts` duplicate allowed colors plus timeout parsing, positivity/finite checks, caps, and millisecond conversion. Toast has additional dismissibility behavior and a different cap.
- Verdict: **Confirmed validation core**. Share color parsing and a timeout parser with an explicit maximum; retain command-specific behavior.

- The three named `emitErrorJson` functions in dispatch/send/session are additional exact evidence for the broad CLI error-envelope finding already recorded in section 12, not a separate cleanup item.

### 30.5 Security and media contracts

#### Browser-tab URL policy merge artifact

- The apparent duplicate in `window-manager.ts` is inside an unresolved merge-conflict side, not two intentional live implementations. That side copies predicates from `guest-webview-security.ts` and also narrows partition matching compared with canonical `src/shared/browserTabPartition.ts`.
- Verdict: **Resolve the merge conflict, do not abstract the duplicate**. Keep `guest-webview-security.ts` plus the shared partition matcher and delete the conflicting copied side when the owning change is reconciled.

#### Image data URLs and MIME mapping

- Attachments, feedback, and group-chat handlers separately parse base64 image data URLs, decode buffers, and derive extensions. Regex precision and filename policy differ.
- Attachments and session-image storage also maintain overlapping extension-to-MIME mappings.
- Verdict: **Confirm the common decode contract first**. Centralize strict media-type parsing and MIME lookup; keep filename generation, size limits, and destination policy at each boundary.

### 30.6 Additional bounded duplicates

- Feedback image and ZIP upload paths repeat GitHub content-upload request construction, response parsing, and raw-URL fallback inside the same handler. Extract one local upload function while retaining media-specific preparation.
- Usage Dashboard has two identical sparkline builders. Move the helper to the feature's existing utility module, not a repository-wide shared package.
- Three activity graph components repeat the same short date-range label. A renderer date formatter is justified if locale/options remain identical.
- Two coworking prefixed-ID format/parse pairs are exact except for prefix. A local prefix-bound factory can prevent parser drift.
- Multiple copy actions combine `safeClipboardWrite`, transient copied state, and reset timers. This is **verify then change**: a hook is valuable only if it clears overlapping timers and unmount cleanup while preserving local indicators, 1500/2000ms durations, and the separate global `flashCopiedToClipboard` UX.
- Compatible keydown subscriptions may use existing `useEventListener`; do not add a keyboard wrapper solely to hide two registration lines.

### 30.7 Rejected exact-clone noise

- `delay`/`sleep` in auto-updater and Copilot shutdown expands the existing section 1 `sleep` family. The agent's claimed 46 gross lines was incorrect: the wrappers are one and three lines. Consolidate only with the existing sleep cleanup.
- Generic retry loops in updater, CLI-server startup, and stats persistence have different retry predicates, return/throw behavior, delay schedules, logging, and side effects. One universal retry helper would obscure policy.
- Renderer loading `try/catch/finally` blocks are standard control flow with different data/error ownership. A callback-heavy generic hook has no proven net value.
- Async cancellation booleans and request counters remain intentionally local per section 29.3.
- HH:mm formatting, filename timestamps, duration constants, account-prefix checks, sorting expressions, confidence clamps, error strings, UUID fragments, and one-line allowlists are too small or policy-specific to justify new global abstractions.
- Claude/Codex usage stores, MCP installers, SDK mirrors, and generic CLI errors were already covered.

### 30.8 Cleanup priority additions

69. Introduce a typed preload subscription helper.
70. Extract the four command-panel state/mutation hook.
71. Centralize SSH execution timeout handling.
72. Share pure CLI environment parsing.
73. Consolidate Cadenza/Movement body and send helpers.
74. Share notification color and timeout validators.
75. Resolve the browser-tab security merge conflict toward canonical modules.
76. Define strict image data-URL and MIME helpers.
77. Extract feedback GitHub upload construction locally.
78. Evaluate a timer-safe copy-feedback hook.
79. Consolidate feature-local sparkline and date-label helpers.

### 30.9 Wave limitations

- The exact-clone agent overstated several net savings and proposed global modules for feature-local helpers. Reconciliation narrows placement and removes one-line abstractions.
- Static similarity cannot prove event propagation, timer cleanup, process-exit, security, or serialization compatibility.
- No runtime verification was performed. The only unintended source edit made by an audit agent was reverted; the canonical report remains the only intended changed file.

## 31. Clone Saturation Wave 5 - Reconciled Findings

Five default Task agents ran a convergence audit. Four reported `NO_NEW_DUPLICATION`, but the exact-clone and adversarial evidence exposed three actionable families plus two verify-first families. The exact agent violated the no-delegation constraint by spawning scouts; its source-backed findings were reconciled rather than accepted wholesale.

### 31.1 `fetchWithTimeout`

- `src/main/cue/cue-telemetry.ts` and `src/main/ipc/handlers/leaderboard.ts` implement the same `AbortController`, timeout abort, fetch, and `finally` cleanup. One supplies a default empty `RequestInit`; behavior is otherwise equivalent.
- Verdict: **Confirmed**. Move one helper to `src/main/utils`; retain the explicit timeout at each callsite and test abort classification.

### 31.2 Cue default-source drift

- `src/shared/cue/contracts.ts:DEFAULT_CUE_SETTINGS` defines `timeout_minutes: 30`, `max_concurrent: 1`, and `queue_size: 512`.
- Several Cue runtime callsites repeat hardcoded fallbacks. At least `cue-run-manager.ts:816-818` uses `queue_size ?? 0`, which contradicts the canonical `512` and changes queue behavior when session settings are absent.
- Verdict: **Confirmed correctness drift caused by duplicated defaults**. Replace runtime literals with canonical constant fields and add a test proving missing session settings use the exported defaults.

### 31.3 `escapeRegExp`

- A feature-local canonical implementation exists under File Preview, while equivalent regex escaping is repeated across group-chat export, markdown configuration, Auto Run search, command search/navigation, Cue search, filename document state, CSV rendering, session items, Settings search, and terminal output search.
- Verdict: **Confirmed broad utility duplication**. Move `escapeRegExp` to a neutral renderer utility and migrate exact equivalents. Keep implementations with intentionally different literal/wildcard semantics.

### 31.4 Existing IPC-handler utility bypass

- Memory and prompts IPC handlers repeat success/error envelopes and logging already modeled by `src/main/utils/ipcHandler.ts:createIpcHandler`.
- Verdict: **Verify then migrate**. Confirm handler-specific logging, serialization, and success payload shapes, then use the existing utility instead of creating another dispatcher.

### 31.5 Verify-first infrastructure families

- Five archive producers repeat stream creation, archiver setup, close/error listeners, piping, content append, and finalization. Formats and error propagation differ. A shared helper is justified only if it exposes format plus content-writing callback without weakening stream errors.
- Two coworking main-to-renderer request/response flows repeat sender validation, unique response channels, `Promise.withResolvers`, timeout cleanup, send, response parse, and exact listener removal. A local generic round-trip helper may prevent sender/timer leaks, but payload parsing and channel typing must stay explicit.

### 31.6 Rejected candidates

- `toErrorMessage` is already recorded in section 27.1 and remains zero-value.
- Archive, coworking, and IPC candidates are not automatic consolidations; contract tests precede abstraction.
- Low-net constant, error-string, and formatting coincidences remain rejected under section 30.7.

### 31.7 Cleanup priority additions

80. Extract main-process `fetchWithTimeout`.
81. Replace Cue fallback literals with `DEFAULT_CUE_SETTINGS`.
82. Move and reuse neutral `escapeRegExp`.
83. Migrate compatible memory/prompts handlers to `createIpcHandler`.
84. Evaluate a contract-safe archive stream helper.
85. Evaluate a typed coworking response-channel round trip.

### 31.8 Wave limitations

- Four agents' saturation sentinels were overridden by a source-verified finding from the fifth; the wave therefore does not meet the stop condition.
- No runtime verification was performed, and no Maestro source files were changed.

## 32. Clone Saturation Wave 6 - Reconciled Findings

Five more default Task agents audited main, renderer, peripheral, exact-clone, and adversarial residuals. Three returned `NO_NEW_DUPLICATION`. Exact and renderer scans produced one small confirmed helper plus two verify-first hook families.

### 32.1 SSH remote ID precedence

- `useWorktreeHandlers.ts` and `worktreeSpawn.ts` define the same `sshRemoteId || sessionSshRemoteConfig?.remoteId || undefined` helper; `useAutoRunHandlers.ts` adds only a nullable-session guard.
- Verdict: **Confirmed, small but policy-bearing**. Move remote-ID precedence to a neutral renderer session/worktree utility so Auto Run and worktree creation cannot drift.

### 32.2 Scroll-position hook overlap

- `useScrollLogHandlers` and canonical `useScrollPosition` both track at-bottom state and scroll position. The former additionally writes AI-tab and shell-log state through domain callbacks.
- Verdict: **Verify then delegate**. Replace only the measurement/listener portion with `useScrollPosition`; retain tab/log persistence in the thin domain wrapper. The agent's claimed 117-line saving is unproven.

### 32.3 Modal and panel pointer resizing

- `useResizableModal` and `useResizablePanel` repeat pointer-start coordinates, move deltas, min/max clamping, transition suppression, window listener ownership, and persistence on pointer-up.
- Verdict: **Confirmed shared mechanism, different products**. Extract a low-level pointer-resize primitive only after tests pin modal two-axis sizing, panel axis constraints, persisted dimensions, and unmount cleanup.

### 32.4 Flash auto-dismiss scheduling

- Multiple renderer handler families repeat a 2000ms `setFlashNotification(null)` timer.
- Verdict: **Verify then change**. Prefer one timer-owning flash store/action if the state is shared; otherwise a hook must clear overlapping timers and unmount cleanup. Do not replace imperative focus timers with the same abstraction.

### 32.5 Rejected candidates and corrections

- `useSessionDebounce` is a keyed per-session timer/composed-updater mechanism, not a scalar duplicate of `useDebouncedCallback`. Section 25.7 already prohibits this replacement.
- Remote/worktree validation shares generic effect/debounce syntax but has different state, validation, and cancellation contracts. No callback-heavy `useDebouncedValidation` is justified.
- Imperative delayed focus has action-specific timing and focus-restoration ownership; `useAutoFocus` would misrepresent it as mount behavior.
- Modal header shells overlap the already reported modal primitive/header findings. Two matching footer class strings are not a component contract.
- The apparent browser-tab security duplicate from section 30.5 was confirmed as an unresolved merge-conflict side and corrected above.

### 32.6 Cleanup priority additions

86. Centralize SSH remote-ID precedence.
87. Delegate scroll measurement to `useScrollPosition`.
88. Extract a tested pointer-resize mechanism.
89. Centralize flash auto-dismiss timer ownership.

### 32.7 Wave limitations

- Renderer net-savings estimates were gross structural estimates; reconciliation rejects the claimed 628-line total.
- One unresolved source merge conflict remains user-owned and was not modified.
- No runtime verification was performed, and no Maestro source files were changed.

## 33. Clone Saturation Wave 7 - Reconciled Findings

Five default Task agents applied a higher-value threshold. Peripheral, renderer, exact, and adversarial scopes returned no qualifying new duplication after reconciliation. The main-process inventory found one substantial local family.

### 33.1 Debug-package category collection

- `src/main/debug-package/index.ts:generateDebugPackage` contains fourteen sequential category collectors with the same success bookkeeping and failure normalization/logging.
- Each block differs only by collector closure, output filename/category, and human-readable error label; optional categories add an outer condition.
- Verdict: **Confirmed bounded orchestration duplication**. Add a local `collectCategory` helper receiving the output key, error label, and sync/async collector closure. It should own `contents`, `filesIncluded`, `errors`, and logger updates while preserving best-effort package generation.

### 33.2 Reconciliation

- An exact-clone agent rejected this family because collector bodies differ. That misses the actual duplicated contract: execute an arbitrary collector, record its result under one key, and isolate failures so remaining categories continue.
- The abstraction stays local to debug-package generation; no repository-wide collection framework is warranted.

### 33.3 Cleanup priority addition

90. Extract debug-package `collectCategory` orchestration.

### 33.4 Wave limitations

- One renderer agent's structured yield failed; its complete transcript ended with `NO_NEW_DUPLICATION` and confirmed no file changes.
- No runtime verification was performed, and no Maestro source files were changed.

## 34. Clone Saturation Wave 8 - Reconciled Findings

Five default Task agents audited main, renderer, peripheral, exact-clone, and adversarial surfaces. Peripheral and exact-clone scopes returned `NO_NEW_DUPLICATION`; the other scopes produced three qualifying families after overlap rejection.

### 34.1 Bundled-command renderer services

- `src/renderer/services/bmad.ts`, `openspec.ts`, and `speckit.ts` each implement command-list, metadata, and single-command wrappers with the same result checks, fallback values, and logging envelope.
- LSP reference checks found no consumers outside their declaration files for all six metadata and single-command exports. Only the three command-list functions are live.
- Verdict: **Confirmed duplication plus dead exports**. Delete the six unreferenced exports and their now-unused metadata types. Consolidate only the remaining command-list wrappers behind a small typed bundle-command loader; preserve BMAD's optional namespace guard.
- The raw agent estimate overstated removal. The three files contain 184 total lines, so claimed savings above that were impossible. Direction and dead-code proof remain valid.

### 34.2 Settings session-migration skeleton

- `src/main/stores/migrations/adaptive-mode-default.ts:migrateAdaptiveModeDefault` and `api-mode-default.ts:migrateApiModeDefault` repeat marker checks, session-store loading, map/update counting, conditional persistence, marker persistence, and completion logging.
- `src/main/stores/migrations/index.ts` separately repeats best-effort `try/catch` logging for each migration.
- Verdict: **Confirmed bounded duplication, but check expiry before abstraction**. If both migrations must remain, extract a local session-migration runner with explicit predicate/update/message parameters plus a small failure-isolation runner. If their supported upgrade window has expired, deletion is better than preserving obsolete migrations through a new abstraction.

### 34.3 Agent-run IPC envelopes

- Nine handlers in `src/main/ipc/handlers/agent-run.ts` repeat success/error response construction and logging while `src/main/utils/ipcHandler.ts:createIpcHandler` already owns that contract for compatible handlers.
- Verdict: **Verify then migrate**. Preserve semantic failure responses such as `gated` and `not found`, disable added success logging where necessary, and reconcile `toErrorMessage(error)` with the utility's current `String(error)` serialization before replacing envelopes.
- This extends section 31.4 beyond the memory/prompts handlers named there; no second IPC wrapper should be created.

### 34.4 Rejected wave findings

- `WebServer` callback setters and `CallbackRegistry` assignment methods overlap sections 11.5 and 11.9; the report already requires invariant and contract proof before changing this facade.
- The plugin `run-ui-command` response channel is one end-to-end protocol, not two duplicated implementations. No second caller or reusable local family was shown.
- `WINDOWS_RESERVED`, adaptive-mode policy, plugin persistence, provider stores, preload wrappers, and build-script helpers were already recorded.

### 34.5 Cleanup priority additions

91. Delete dead bundled-command service exports and unify live loaders.
92. Expire or consolidate settings session migrations.
93. Migrate compatible agent-run handlers to `createIpcHandler`.

### 34.6 Wave limitations

- Static analysis and LSP references establish source reachability, not dynamic property access from external consumers. These service functions are named TypeScript exports and no dynamic lookup path was found.
- No runtime verification was performed, and no Maestro source files were changed.

## 35. Clone Saturation Wave 9 - Reconciled Findings

Five default Task agents covered remaining main, renderer, peripheral, exact-clone, and adversarial surfaces. Main, renderer, and peripheral scopes returned `NO_NEW_DUPLICATION`. Reconciliation retained two cleanup findings, one formatter family, and one low-priority ID-policy question.

### 35.1 Unresolved merge conflicts in tracked source

- Conflict markers remain in seven production files: `src/main/app-lifecycle/window-manager.ts`, `src/main/process-manager/ProcessManager.ts`, `src/renderer/components/MainPanel/BrowserTabView.tsx`, `src/renderer/hooks/tabs/internal/browserTabHelpers.ts`, `useBrowserTabHandlers.ts`, `src/renderer/stores/settingsStore.ts`, and `src/renderer/utils/browserTabPersistence.ts`.
- One test file, `src/__tests__/main/ipc/handlers/process.test.ts`, also retains a conflict.
- The conflicts choose between incompatible process-spawner, OpenCode fallback, browser-profile, ephemeral-partition, web-desktop, modal-sizing, and BrowserTab type contracts. This is correctness-blocking integration state, not a duplication abstraction opportunity.
- Verdict: **Highest-priority manual reconciliation**. Preserve both owning changes intentionally, then compile and exercise process spawning, OpenCode fallback, browser profiles/ephemeral tabs, web-desktop tabs, modal sizing, and the process handler test. Never delete one side mechanically.
- This corrects earlier wave limitations that referred to one unresolved conflict: one conflict family was discussed, but the current tree contains eight affected source/test files.

### 35.2 Unreferenced `AgentSessionsModal`

- `src/renderer/components/AgentSessionsModal.tsx` is a 718-line exported component.
- LSP found only its declaration and no consumer. No barrel or dynamic component registry reference was found.
- Verdict: **Confirmed dead production file, verify then delete**. Before deletion, exercise the current session-history/resume flow to confirm its replacement is live and no plugin/runtime string lookup exists.

### 35.3 Byte-size formatter divergence

- `src/shared/formatters.ts:formatSize` is the existing B/KB/MB/GB/TB formatter.
- `src/renderer/components/UpdateCheckModal.tsx` and `src/renderer/components/FileExplorerPanel/utils/pathHelpers.ts` each define local `formatBytes` variants.
- The file-explorer variant clamps units and trims trailing `.0`; the updater variant omits TB and can produce an undefined unit above GB. The shared formatter preserves one decimal place.
- Verdict: **Confirm presentation contract, then consolidate**. Prefer the shared formatter or add one explicit presentation option rather than retaining three algorithms. Add boundary checks at 0, 1024, unit transitions, and values above 1 TB.

### 35.4 Timestamp/random ID factories

- Several stats, layer, command-history, offline-queue, and batched-session modules construct timestamp-plus-random IDs locally while `src/shared/uuid.ts:generateUUID` already exists.
- Verdict: **Retain pending contract proof**. Timestamp prefixes may encode ordering/debuggability and layer IDs intentionally add a prefix. Inventory persistence and sorting consumers before standardizing; raw body similarity alone is insufficient.

### 35.5 Rejected wave findings

- `BrowserTabView` `__MAESTRO_SCROLL__` and `__MAESTRO_KEY__` console messages are an intentional console-message bridge protocol consumed by surrounding code, not debug-log garbage.
- Promise delay helpers save below the wave's 10-net-line threshold.
- Cue relative-time formatting intentionally returns `—` for missing/invalid input and uses different old-date presentation; migration needs an explicit UX decision.
- Image extension lists guard different trust boundaries and must not be unified into one permissive allowlist.
- Coworking timeout offsets are documented ordering policy, not duplicated constants.

### 35.6 Cleanup priority additions

94. Reconcile all tracked source merge conflicts.
95. Verify replacement, then remove `AgentSessionsModal.tsx`.
96. Consolidate byte-size formatting after presentation checks.

### 35.7 Wave limitations

- Dead-file proof covers TypeScript references and repository text; a runtime smoke test remains required before deletion.
- No runtime verification was performed, and no Maestro source files were changed.

## 36. Clone Saturation Wave 10 - Reconciled Findings

Five default Task agents audited main, renderer, peripheral, exact-clone, and adversarial surfaces after section 35. Reconciliation retained two net-new local families. Most raw renderer findings were already present in earlier sections.

### 36.1 Renderer lookback-option constants

- `src/renderer/components/SessionActivityGraph.tsx` and `src/renderer/components/History/historyConstants.tsx` define the same `LookbackPeriod` type and nine-entry `LOOKBACK_OPTIONS` array.
- `src/renderer/components/GroupChatHistoryPanel.tsx` defines a six-entry subset of the same labels and values.
- Verdict: **Confirmed stable-domain duplication**. Choose one renderer history constant/type source and import it at all three sites; explicitly filter the full list where the group-chat UI intentionally offers fewer periods.
- Plausible net saving: approximately 20 lines.

### 36.2 Claude projects-directory construction

- Nine handlers in `src/main/ipc/handlers/claude.ts` repeat `os.homedir()` followed by `path.join(homeDir, '.claude', 'projects')`.
- Verdict: **Confirmed local path-policy duplication**. Add a module-local `getClaudeProjectsDir()` function or stable module constant, depending on whether tests override home-directory resolution.
- Plausible net saving: approximately 12 lines while preventing path drift.

### 36.3 Reconciliation rejects

- Usage Dashboard sparkline builders were already recorded in section 30.6 with the correct feature-local consolidation direction.
- SSH remote-ID precedence was already recorded in section 32.1.
- Session-deletion active-session fallback was already recorded in section 27.3 and intentionally judged too small unless lifecycle code is already changing.
- Notification/center-flash color maps were already recorded under legacy notification color resolution.
- Flash auto-dismiss and timer-safe copy-feedback families were already recorded in sections 32.4 and 30.6.
- The Director Notes CLI duration formatter is below the wave's 10-net-line threshold and belongs to the existing duration-formatter finding.
- A generic wrapper around `withIpcErrorLogging(handlerOpts(...))` would hide typed per-handler contracts for roughly one line per registration; retain the current explicit composition.

### 36.4 Cleanup priority additions

97. Consolidate renderer `LOOKBACK_OPTIONS` and type.
98. Centralize Claude projects-directory construction locally.

### 36.5 Wave limitations

- One renderer agent appended an unreconciled draft despite the read-only contract. This section replaces that draft after all five reports completed; no Maestro source files were changed.
- No runtime or visual verification was performed.

## 37. Clone Saturation Wave 11 - Reconciled Findings

Five default Task agents audited all production surfaces after section 36. Main and peripheral scopes returned `NO_NEW_DUPLICATION`; renderer, exact-clone, and adversarial scopes produced the following net-new candidates after overlap rejection.

### 37.1 Activity-graph axis-label builders

- `src/renderer/components/SessionActivityGraph.tsx` and `src/renderer/components/History/ActivityGraph.tsx` contain byte-identical approximately 37-line `getAxisLabels` closures.
- Both branch on the same lookback-hour thresholds and construct identical start, midpoint, hour, day, and fallback labels from the same three primitive inputs.
- `GroupChatHistoryPanel.tsx` has a deliberately simplified variant without midpoint labels; do not force it through a boolean-heavy universal helper.
- Verdict: **Confirmed feature-family duplication**. Extract the identical pair to a renderer history/activity utility; retain the minimal group-chat variant unless a shared policy can express it without condition sprawl.
- Plausible net saving: approximately 35 lines.

### 37.2 BMAD manager bypasses `createSpecCommandManager`

- `src/main/spec-command-manager.ts:createSpecCommandManager` already parameterizes prompt prefixes, bundled/user directories, customization storage, commands, metadata defaults, and user-first/bundled fallback loading for OpenSpec and SpecKit.
- `src/main/bmad-manager.ts` independently repeats user-data paths, customization reads/writes, bundled/user prompt paths, prompt fallback loops, and metadata fallback.
- BMAD adds Sentry capture, remote refresh/assets, runtime prompt fixes, and slightly different custom-command/failure behavior.
- Verdict: **Verify then migrate the common core**. Extend the factory with narrowly typed hooks only where BMAD requires them; keep BMAD refresh, asset collection, reference resolution, and runtime prompt rewriting outside. Do not erase BMAD-specific observability or fallback behavior to maximize line count.
- Plausible net saving: approximately 80–120 lines if compatibility tests establish parity.

### 37.3 Versioned cache readers

- `src/main/utils/statsCache.ts` has two loaders, `src/main/ipc/handlers/claude.ts` has `loadLegacyGlobalStatsCache`, and `src/main/storage/codex-session-storage.ts` has `loadCodexSessionCache`.
- Each reads UTF-8 JSON, parses to a cache type, rejects a version mismatch, and returns `null` on read/parse failure.
- Verdict: **Confirmed read-policy duplication**. Add a typed versioned-cache reader only if all four intentionally share silent corruption/permission handling; otherwise parameterize or preserve the error policy explicitly.
- Plausible net saving: approximately 15 lines.

### 37.4 Keyed-array JSON readers

- `feedback.ts:readDrafts`, `feedback.ts:readSubmittedIssues`, and `playbooks.ts:readPlaybooks` repeat read, parse, `Array.isArray(data[key])`, and empty-array fallback behavior.
- Verdict: **Confirmed small duplication**. Prefer a typed JSON-reader utility with an explicit array selector/guard; avoid a stringly typed key API that weakens result types.
- Plausible net saving: approximately 10–12 lines.

### 37.5 Declaration-only production utilities

LSP returned only each declaration for these exports:

- `src/main/utils/shellDetector.ts:getShellCommand`
- `src/main/utils/dirent-utils.ts:readDirWithResolvedTypes`
- `src/main/utils/networkUtils.ts:getLocalIpAddressSync`
- `src/main/utils/pricing.ts:calculateCost`
- `src/main/utils/pricing.ts:calculateClaudeCost`
- `src/main/utils/ssh-config-parser.ts:getSshConfigHostSummary`

Tests may import some of these directly, but no production consumer was found.

- Verdict: **Verify then delete or migrate tests**. Tests that exist only to defend unreachable APIs do not make those APIs live. Preserve a utility only when its behavior is still part of a supported public contract.
- `getSshConfigHostSummary` is a special case: `SshRemoteModal.tsx` contains a near-identical renderer-local implementation. Move the cross-runtime pure formatter to `src/shared` and migrate the renderer rather than deleting the only reusable behavior.

### 37.6 Deprecated compatibility candidates

- `CLAUDE_PRICING`, `LEGACY_CUE_YAML_FILENAME`, and renderer `useGitStatus` were reported with no production callers but test or documentation references.
- Verdict: **Reference-check immediately before removal**. Confirm no runtime or dynamic string lookup, then remove the aliases/hook and update tests and docs in the same clean cutover.

### 37.7 Reconciliation rejects

- Sparkline builders, HTML/regex escaping, byte-size formatting, SSH remote-ID precedence, duration formatters, UUID policy, flash/copy timers, and session-deletion fallback already appear in sections 27–36.
- Test-only cache-reset seams are intentional testability APIs, not dead production garbage; remove them only as part of a deliberate test redesign.
- Browser preload type exports and tiny path/display wrappers do not meet the net-line threshold without stronger compatibility evidence.

### 37.8 Cleanup priority additions

99. Extract shared activity-graph axis-label builder.
100. Migrate BMAD common storage/loading into spec-manager factory.
101. Consolidate versioned cache read policy.
102. Consolidate typed keyed-array JSON reads.
103. Remove or relocate declaration-only production utilities.
104. Remove verified dead deprecated aliases and hook.

### 37.9 Wave limitations

- The adversarial agent spawned nested scouts despite an explicit no-spawn contract. Parent reconciliation independently LSP-checked the highest-value dead exports and rejected unsupported estimates.
- Static reachability does not establish runtime or dynamic string lookup; recheck those paths immediately before exported removal.
- No runtime verification was performed, and no Maestro source files were changed.

## 38. Clone Saturation Wave 12 - Convergence

Five default Task agents independently audited main, renderer, peripheral/boundary, exact-clone, and adversarial surfaces after sections 1–37.

### 38.1 Reconciled verdict

**`NO_NEW_DUPLICATION`**

- Main, renderer, and peripheral agents returned the sentinel directly.
- The exact-clone agent repeated the Claude projects-directory family from section 36 and proposed an attachment-path helper below the 10-net-line threshold; both were rejected.
- The adversarial agent extended the existing Cue process-kill family with Pianola, but its own estimate was net-negative and the shared direction already exists in section 10.9. Its remaining candidates were retained local utilities or previously recorded web-server response plumbing.
- No agent established a new dead production artifact, a new 10-plus-net-line clone family, or a new correctness/security drift absent from the canonical report.

### 38.2 Saturation boundary

The report is saturated under this audit's explicit threshold:

- exact or semantic duplication with at least 10 realistic net removable lines;
- proven dead production files/exports;
- correctness or security policy drift worth fixing even without line savings.

Small local helpers, framework idioms, tests, generated artifacts, unresolved conflict sides, and intentionally different domain contracts remain excluded.

### 38.3 Verification state

- All five wave-12 reports state `Files changed: none`.
- No runtime, visual, build, or test verification was performed because this workflow was a read-only investigation.
- Implementation work must reproduce each selected contract and run the targeted proof listed with that finding before deletion or consolidation.

## 39. Broadened Audit Wave 13 - Previously Excluded Surfaces

Five default Task agents audited dependency/package boundaries, test infrastructure, runtime bridge wiring, renderer micro-clones below the previous threshold, and documentation policy. Parent reconciliation checked the highest-value claims against current source and rejected several agent overclaims.

### 39.1 Dead `concurrently` devDependency

- `package.json` declares `concurrently` in `devDependencies`.
- No package script, CI workflow, source file, E2E file, package, or repository script invokes the module or CLI.
- Verdict: **Confirmed dead dependency**. Remove it from the manifest and lockfile, then run the normal build and validation path.
- This is net-new. Earlier dependency audits sampled active dependencies but did not exhaustively prove every devDependency.

### 39.2 Repeated Vitest `Group` factories

At least eleven unit/integration test files define local `createMockGroup` factories with the same four-field `Group` shape and override pattern:

- `src/__tests__/integration/AutoRunSessionList.test.tsx`
- `src/__tests__/integration/GoalDrivenAutoRun.test.tsx`
- `src/__tests__/renderer/components/AppModals-selfSourced.test.tsx`
- `src/__tests__/renderer/components/GroupChatInput.test.tsx`
- `src/__tests__/renderer/components/PromptComposerModal.test.tsx`
- `src/__tests__/renderer/components/QuickActionsModal.test.tsx`
- `src/__tests__/renderer/components/SessionList.test.tsx`
- `src/__tests__/renderer/hooks/useBatchProcessor.test.ts`
- `src/__tests__/renderer/hooks/batch/useGoalRunner.test.ts`
- `src/__tests__/renderer/hooks/useGroupManagement.test.ts`
- `src/__tests__/renderer/stores/sessionStore.test.ts`

The existing `src/__tests__/helpers/{mockSession,mockTab,mockTheme}.ts` files establish the canonical pattern.

- Verdict: **Confirmed test-maintenance duplication**. Add a deterministic shared `mockGroup` factory and preserve suite-specific defaults through overrides. Do not add a random-ID variant; deterministic IDs are easier to debug and each suite can override when identity uniqueness is part of the contract.
- Conservative saving: approximately 50-60 net lines.
- Required proof: run every migrated suite together because shared defaults can create accidental cross-test coupling.

Three local `createMockAgent` factories and several `createMockGroupChat` factories are similar, but their field sets and defaults diverge enough that they should be consolidated only while touching those suites, not as a standalone cleanup.

### 39.3 Dormant skipped E2E blocks

The E2E tree contains approximately 34 skipped tests across:

- `e2e/autorun-batch.spec.ts`
- `e2e/autorun-editing.spec.ts`
- `e2e/autorun-sessions.spec.ts`
- `e2e/autorun-setup.spec.ts`
- `e2e/plugins.spec.ts`

The skipped blocks cover roughly 600 lines of batch-state, editing, session, wizard, and scheduler scenarios.

- Verdict: **Triage, not blind deletion**. For each block, either restore executable infrastructure and unskip it, prove equivalent active coverage, or delete the obsolete scenario. A permanently skipped test is documentation-shaped garbage, not regression protection.
- Required proof: map selectors and behaviors to current UI, then run the relevant E2E journey for any retained scenario.

### 39.4 Keyboard shortcut matcher duplication

`src/renderer/hooks/keyboard/useKeyboardShortcutHelpers.ts` repeats modifier comparison, shifted punctuation matching, and an identical 11-entry physical-key fallback map in `isShortcut` and `isTabShortcut`.

- Verdict: **Confirmed local semantic clone with drift risk**. Extract one module-local matcher used by both callbacks. Preserve the global-only shift-number and special-key behavior explicitly unless product semantics establish that tab shortcuts should support the same keys.
- Conservative saving: approximately 20-30 net lines.
- `isPaneShortcut` has materially different Ctrl+Meta preconditions and should remain a separate caller; only reuse the pure main-key comparison if that makes the result smaller.
- Required proof: focused keyboard tests plus manual checks for global, tab, pane, shifted punctuation, and non-US/Alt-rewritten key paths.

### 39.5 User-documentation sources of truth

Three net-new documentation families repeat mutable reference material:

1. `docs/slash-commands.md` and `docs/prompt-customization.md` carry near-duplicate template-variable tables. Keep the fuller prompt-customization table and link to it from slash commands. Approximate saving: 55 lines.
2. `docs/getting-started.md` and `docs/general-usage.md` repeat agent-creation steps and advanced options. Keep the start flow concise and make one page the detailed source.
3. `docs/installation.md`, `docs/troubleshooting.md`, `docs/getting-started.md`, and `docs/features.md` repeat the supported-provider list. Keep one canonical provider list and link to it so new providers do not require four edits.

- Verdict: **Confirmed documentation drift risk**. Consolidate reference lists, not audience-specific explanation.
- Required proof: check inbound anchors and the Mintlify navigation/build after changing links.

### 39.6 Deprecated Claude stats listener

- `window.maestro.claude.onGlobalStatsUpdate` remains in the deprecated preload API and global types, but no renderer production caller was found.
- The active stats hook uses `window.maestro.agentSessions.onGlobalStatsUpdate`.
- `window.maestro.claude.onProjectStatsUpdate` is **not dead**; `useAgentSessionsAggregateStats.ts` still consumes it.

- Verdict: **Verify then remove only the deprecated global-stats listener path**. Check external preload compatibility policy and main-process event producers before deleting the old channel, wrapper, types, and tests.
- Do not remove the project-stats listener until its active consumer migrates.

### 39.7 Claude origins compatibility path

Eight renderer paths still call `window.maestro.claude.updateSessionName`, while the newer API exposes `agentSessions.setSessionName`.

This is not an immediate alias deletion:

- the old path writes `claudeSessionOriginsStore`;
- the generic path writes the agent-keyed `originsStore`;
- several other Claude-specific origins/starred readers remain active.

- Verdict: **Explicit data migration**, not dedup cleanup. Define how legacy Claude origins move into the agent-keyed store, migrate reads and writes together, then remove the deprecated wrappers and handlers in one cutover. Migrating callsites alone would split persisted names across two stores.

### 39.8 Reconciliation rejects

- `canvas` is not proven dead. JSDOM conditionally uses the installed native package, and `StandingOvationOverlay.test.tsx` expects `canvas.getContext('2d')` to be available. Remove only after proving the full test environment without it.
- `claude:projectStatsUpdate` is live through `useAgentSessionsAggregateStats.ts`.
- The web-server `bridge.invoke` route does not prove explicit message cases redundant; direct WebSocket clients may still use them.
- `docs/agent-guides/**` is intentionally excluded from public Mintlify output but is linked extensively from root `CLAUDE.md` and other internal engineering docs. It is not orphaned.
- The two Vite `manualChunks` functions target different builds and share too little stable policy to justify a cross-config abstraction.
- A repository-wide IPC string registry would add substantial migration surface without immediate deletion; the typed preload subscription helper in section 30.1 remains the narrower canonical improvement.
- Small `vi.mock('electron')` blocks have materially different shapes and Vitest hoisting constraints. Do not centralize them without demonstrating an exact reusable contract.

### 39.9 Cleanup priority additions

105. Remove the unused `concurrently` devDependency.
106. Consolidate deterministic `createMockGroup` test factories.
107. Extract the shared keyboard shortcut matcher core.
108. Consolidate duplicate documentation reference tables and provider lists.
109. Triage skipped E2E blocks into active coverage or deletion.
110. Retire the deprecated Claude global-stats listener after compatibility verification.
111. Plan the Claude origins-store migration separately from mechanical dedup work.

### 39.10 Wave limitations

- All five agents performed static, read-only analysis and changed no files.
- Parent reconciliation used current source and repository text references but did not run runtime, build, visual, or test verification.
- Line savings are conservative estimates, not implementation results.
- This wave deliberately broadened into tests and documentation; those findings do not invalidate the production-code saturation boundary in section 38.

## 40. Focused Audit Wave 14 - Lifecycle, State, Security, and Persistence

Five default Task agents audited persistence/data evolution, process lifecycle, error/telemetry policy, state invalidation, and security validation after sections 1-39.

### 40.1 Symphony document-reference validation

`src/main/ipc/handlers/symphony.ts` repeats the same `DocumentReference[]` validation in two paths:

- `validateContributionParams` validates GitHub-hosted external URLs and rejects unsafe repo-relative paths.
- `symphony:cloneRepo` repeats the same HTTPS check, five-host allowlist, URL parsing, and relative-path rejection before processing the same document-reference shape.

The clone path later performs a resolved-source containment check before reading a repo-internal file, so the agent's claimed encoded-traversal vulnerability was not established. URL-encoded `..` text is not decoded by `path.resolve`, and the downstream containment check remains the load-bearing guard.

- Verdict: **Confirmed local validation duplication, not a confirmed security vulnerability**. Extract a module-local `validateDocumentReferences(documentPaths)` helper returning the existing `{ valid, error }` envelope. Both handlers should call it; the clone path must retain its later resolved-source containment check.
- Conservative saving: approximately 25-30 net lines plus one canonical GitHub-host allowlist.
- Required proof: focused Symphony handler tests for HTTPS GitHub attachments, rejected hosts, malformed URLs, relative paths, absolute paths, `..`, Windows drive paths, and downstream resolved containment.

### 40.2 Reconciliation rejects

- Persistence migrations, JSON readers, usage stores, versioned caches, Claude origins, transcript parsers, and atomic writes overlap sections 1-39.
- Process spawn, kill, abort, timeout, exit classification, runner, listener, and shell-resolution candidates overlap prior Cue/process findings or have different transport contracts.
- Error normalization, retry classification, Sentry filters, failed-result factories, and `extractCleanStdout` overlap prior findings or remain intentionally local.
- Renderer state updater resolution and preload listener wrappers overlap sections 25.2 and 30.1. Other caches and hydration paths have distinct owners and lifetimes.
- The Symphony `includes('..')` early check was not shown bypassable in the actual load path because repo-internal reads also pass through `path.resolve(localPath, doc.path)` and a containment check. Record the duplicated validator, not the unsupported vulnerability claim.
- Notification color/timeout validation is already section 30.4.

### 40.3 Cleanup priority addition

112. Extract Symphony document-reference validation while preserving downstream path containment.

### 40.4 Wave limitations

- All five agents performed static, read-only analysis and changed no source files.
- Parent reconciliation inspected both validation call paths and the downstream document load, but did not run runtime or test verification.

## 41. Domain Audit Wave 15 - Parsers, Registries, Clients, and Design Tokens

Five default Task agents audited provider protocols, agent registries, external-service clients, file/content transforms, and styling/design-token systems after sections 1-40. Parent reconciliation checked the highest-value claims against current source.

### 41.1 Pi and OMP parser implementations

`src/main/parsers/pi-output-parser.ts` and `src/main/parsers/omp-output-parser.ts` independently implement the same Pi JSONL event protocol:

- parallel usage, message, delta, content-block, and raw-event interfaces;
- the same `session`, `message_update`, `message_end`, `agent_end`, and tool-execution state machine;
- the same assistant-message lookup, text extraction, usage projection, error extraction, and exit-error handling;
- the same `AgentOutputParser` surface.

OMP's meaningful specialization is its TTSR abort handling: `TTSR matched rule(s)` is an in-loop retry signal, not a terminal error. It also uses the shared ANSI stripper while Pi uses the main-local terminal filter.

- Verdict: **Confirmed large semantic clone**. Extract a shared Pi-protocol parser base or parameterized core. Keep OMP's TTSR classification as an explicit hook/override; do not hide it behind agent-ID conditionals. Prefer a shared protocol event type over duplicated Pi/Omp interfaces.
- Conservative saving: approximately 180-230 net lines after retaining explicit OMP behavior.
- Required proof: run both parser suites together, add identical cross-parser protocol fixtures, and exercise OMP TTSR aborts through parsed-event and exit-error paths.

### 41.2 Xterm scrollbar theme bypass

`src/renderer/index.css` defines canonical scrollbar variables (`--scrollbar-thumb`, `--scrollbar-thumb-hover`, and `--scrollbar-track`) and uses them for global and thin scrollbars. The `.xterm-viewport` rules instead hardcode white-alpha thumb and hover colors.

- Verdict: **Confirmed theme-policy bypass**. Make xterm consume the existing variables with its current values as fallbacks. This preserves dark-theme output and fixes invisible white-on-white scrollbars on light themes.
- Required proof: render a terminal under at least one dark and one light theme and inspect normal and hover states.

### 41.3 Symphony GitHub API request headers

`src/main/ipc/handlers/symphony.ts` repeats the exact GitHub API `Accept` and `User-Agent` header object at eight fetch sites.

- Verdict: **Confirmed module-local request duplication**. Add a small module-local GitHub API fetch helper that merges caller options without overwriting explicit headers.
- Conservative saving: approximately 15-20 net lines.
- Required proof: focused Symphony tests covering read and mutation requests, including any caller-specific method, body, or headers.

### 41.4 AgentRun Qwen provider drift

The core canonical agent ID is `qwen3-coder`, but `KNOWN_AGENT_RUN_PROVIDERS` contains `qwen-coder`, and `resolveAgentRunProvider` maps `qwen` and `qwen-code` to that noncanonical value. A real `qwen3-coder` tool type therefore falls through to `unknown`, while the dashboard exposes a `qwen-coder` filter that canonical sessions cannot produce.

- Verdict: **Confirmed registry drift**. Add `qwen3-coder` as the canonical AgentRun provider and map legacy Qwen spellings to it. Preserve `qwen-coder` only as an input alias if persisted or external AgentRun records prove it exists.
- `cursor` is not proven stale: AgentRun can ingest external provider names beyond Maestro's spawnable `AGENT_IDS`. Retain it until the external record contract is audited.
- Required proof: provider-resolution tests for canonical and legacy Qwen spellings plus dashboard filtering over persisted runs.

### 41.5 Reconciliation rejects

- Backdrop opacity values encode different modality strengths; tokenizing them requires a design-system decision and does not itself remove meaningful code.
- Z-index tiers require stacking-context and interaction verification. A constant map would replace literals with indirection without proving the layers equivalent.
- Repeated 200ms drawer transitions are small local presentation values; a CSS variable is not net-positive without a shared drawer primitive.
- Copilot/Codex error-text extraction and trivial parser methods overlap earlier findings or save no lines.
- Historical stats display aliases and the icon superset are compatibility presentation, not proven dead registry entries.
- The alternate Symphony GitHub-host list serves a different fetch path and allows subdomains/`objects.githubusercontent.com`; do not merge trust policies blindly. The exact five-host validator duplication remains covered by section 40.1.
- Repeated calls to `checkGhAuthentication` reuse one function; caching is a performance/expiry-policy choice, not deduplication. The existing cache also loses Symphony's detailed error envelope.
- Marketplace fetch helpers differ on parsing, 404 handling, local-path handling, and error policy. A configurable generic wrapper would obscure the clearer domain functions for marginal savings.
- Feedback GitHub-content upload duplication is already documented in section 30.6 even though it lacks a separate priority number.
- Content/path transforms reported by the agent overlap prior sections or have different persistence/security contracts.

### 41.6 Cleanup priority additions

113. Consolidate the Pi/OMP protocol parser core with explicit TTSR specialization.
114. Make xterm scrollbars consume canonical theme variables.
115. Consolidate Symphony GitHub API request headers locally.
116. Align AgentRun Qwen provider resolution with `qwen3-coder`.

### 41.7 Wave limitations

- All five agents performed static, read-only analysis and changed no source files.
- Parent reconciliation inspected the parser surfaces, CSS rules, header callsites, and provider registries, but did not run runtime, visual, build, or test verification.

## 42. Convergence Audit Wave 16 - Exact Blocks, Timing, Coercion, Contracts, and Artifacts

Five default Task agents audited exact production clones, timer/scheduler policies, settings and CLI coercion, command/event schemas, and tracked artifact reachability after sections 1-41. Parent reconciliation accepted three net-new items. The exact-block and timer agents returned `NO_NEW_DEDUP_WORK`.

### 42.1 Stale Electron deep-link preload contract

- `src/shared/types.ts:764-777` defines canonical `ParsedDeepLink` actions as `focus | session | group | file`, including `filePath` and `line`.
- `src/renderer/global.d.ts:1752-1759` explicitly says to stay synchronized with that type but omits `file`, `filePath`, and `line`.
- `src/main/deep-links.ts` sends the full shared payload, and `src/renderer/hooks/session/useSessionSwitchCallbacks.ts:225-243` handles file deep links at runtime. The stale preload declaration only hides a live payload from TypeScript.
- Verdict: **Confirmed drift.** Import or mirror the canonical shared contract in the preload declaration rather than maintaining a narrower inline copy.
- Risk: Low runtime risk, medium contract-maintenance risk.

### 42.2 `HistoryGraphData.hostCounts` missing from preload contract

- `GraphBucket` remains duplicated in `src/main/preload/directorNotes.ts:24-28`, `src/main/preload/files.ts:15-19`, and `src/main/utils/history-bucket-cache.ts:35-39`, extending the verify-first item already recorded in section 10.2.
- `src/main/ipc/handlers/history.ts:58-76` returns `HistoryGraphData` with `hostCounts` and `cached`.
- `src/main/preload/files.ts:27-37` includes `cached` but omits `hostCounts`, even though the IPC payload always carries it.
- Verdict: **Confirmed drift extending section 10.2.** Define the bucket and graph response once in `src/shared/history.ts`, then import the canonical types in handlers and preloads.
- Conservative saving: roughly 25-30 declaration lines plus removal of the current type blind spot.
- Risk: Medium because future consumers cannot rely on the actual IPC response shape through the preload types.

### 42.3 Dead renderer avatar asset

- `src/renderer/assets/pedram-avatar.png` is a tracked 4 KB asset with no repository references by basename or filename.
- Other renderer image assets have explicit component consumers; no dynamic asset loader or naming convention was found for this file.
- Verdict: **Confirmed dead artifact.** Delete after a final filename/reference check in the implementation change.
- Risk: Low.

### 42.4 Reconciliation rejects

- Settings metadata currently provides broad types and defaults, not the range, enum, or registry constraints required by the proposed universal coercion layer. Adding those policies is a product-validation feature, not deduplication, and the claimed 300-500 line saving is unsupported.
- Hex-color validation, finite-number recovery, and provider/model validation are robustness or product-policy proposals, not duplicate-code findings.
- The CLI `parseValue` duplication is already recorded in section 12.2. Metadata-aware parsing may be considered when implementing that item, but it is not a separate dedup finding.
- `useNativeTitleBar` and SSH remote defaults are already recorded in section 1.6.
- The two Auto Run timeout setters share a three-line clamp expression, below this audit's materiality threshold. If touched, rename/generalize the existing max-duration-specific helper before reuse.
- The deprecated web notification `kind`/`variant` mapper is live backward-compatibility code. Remove it only with external caller/version evidence, not as garbage.
- Unreferenced documentation screenshots remain tied to live feature docs or unresolved conflict-side documentation. Build icon archives remain covered by section 26.5.
- The artifact agent's headline said "3 confirmed dead assets" but supplied evidence for exactly one; parent reconciliation accepted only `pedram-avatar.png`.

### 42.5 Cleanup priority additions

117. Align the Electron deep-link preload declaration with canonical `ParsedDeepLink`.
118. Centralize `GraphBucket`/`HistoryGraphData` and include `hostCounts`.
119. Delete the unreferenced `pedram-avatar.png` renderer asset.

### 42.6 Wave limitations

- All five agents performed static, read-only analysis and changed no source files.
- Parent reconciliation inspected the accepted type contracts and independently confirmed zero textual references to `pedram-avatar`; no runtime, build, or test verification was performed.

## 43. Adversarial Convergence Wave 17

Five default Task agents independently audited main-process code, renderer code, shared contracts, peripheral packages/artifacts, and the coverage of sections 1-42. Four scopes returned `NO_NEW_DEDUP_WORK`. Parent reconciliation accepted one small main-process clone family, rejected two proposed report corrections, and found no new blind-spot category.

### 43.1 Duplicate empty-directory cleanup in Cue repository

- `src/main/cue/config/cue-config-repository.ts:92-107` (`removeEmptyPromptsDir`) and `:119-134` (`removeEmptyMaestroDir`) have the same existence check, empty-directory check, synchronous removal, Sentry capture, and boolean result contract.
- They differ only in resolved directory, operation label, and public domain-specific name.
- Verdict: **Confirmed small structural duplicate.** Keep the two descriptive public wrappers and extract one private best-effort `removeEmptyDir` implementation.
- Conservative saving: roughly 10-12 implementation lines, not the agent's unsupported 65-line estimate.
- Risk: Low if operation labels and wrapper contracts remain unchanged.

### 43.2 Reconciliation rejects and corrections

- A coverage reviewer proposed merging the two `activeGroomingSessions` maps behind `src/main/utils/context-groomer.ts` and `src/main/ipc/handlers/context.ts`. Source inspection shows they track different workflows and cleanup capabilities: the current one-shot utility stores `cancel`, while deprecated multi-step IPC sessions store `cleanup` and are the only sessions consumed by shutdown cleanup. Merging the maps without redesigning their lifecycle contract would be unsafe. Section 10.2's unused duplicate count function remains removable independently; the separate one-shot shutdown gap is a correctness concern, not deduplication.
- `isRecord` in `src/main/ipc/handlers/pianola.ts` extends the already-recorded `isPlainObject` family by one three-line local guard. This does not change the canonical direction in sections 10.4/26.1 and is below the materiality threshold.
- Two web `generateId` helpers and the dead export modifier on `formatWaitDuration` each save roughly three lines and remain below threshold.
- All renderer, shared-contract, CLI/web/package, and report-blind-spot categories produced no accepted net-new cleanup work.

### 43.3 Cleanup priority addition

120. Extract Cue's duplicate best-effort empty-directory removal core.

### 43.4 Wave limitations

- All five agents performed static, read-only analysis and changed no source files.
- Parent reconciliation inspected the Cue clone and both grooming state maps; no runtime, build, or test verification was performed.
- Because one material candidate remained, convergence was not yet declared after this wave.

## 44. Terminal Convergence Wave 18

Five default Task agents audited engine internals, IPC/preload/service bridges, renderer/shared code, peripheral packages/artifacts, and the report itself after sections 1-43. Engine, bridge, client, and peripheral scopes independently returned `NO_NEW_DEDUP_WORK`. Parent reconciliation accepted no new cleanup finding or material report correction.

### 44.1 Falsifier correction rejected by source evidence

- The report falsifier claimed `calculateClaudeCost` had six production callsites and therefore was not dead under section 37.5.
- LSP references on `src/main/utils/pricing.ts:56` returned only the declaration itself.
- Repository search found `calculateClaudeCost` only in its declaration, tests, mocks, and `src/main/cue/stats/AGENT-TOKEN-AUDIT.md`; no production callsite exists.
- The alleged locations contain different code: `claude-session-storage.ts` calls `computeClaudeUsageCost`, `agentSessions.ts` calls `calculateModelCost`, and the cited `claude.ts` lines are timestamp scans, cache iteration, or totals calculation.
- Verdict: **Reject the correction.** Section 37.5 remains accurate that `calculateClaudeCost` has no production caller.

### 44.2 Other reconciliation results

- The CLI adds another near-identical `extractTextFromContent` implementation to the family described in section 2.2. Provider-specific storage/parser variants have narrower content contracts. This broadens known scope but does not change the existing verify-first/retain-or-extract direction, so it is not a new cleanup priority.
- Trigger-source lifecycle shells, process-listener signatures, renderer service wrappers, web ID helpers, and the CLI duration formatter either have distinct domain contracts or remain below the 10-line materiality threshold.
- All other candidates mapped directly to sections 1-43.

### 44.3 Convergence verdict

- **Converged:** zero parent-accepted net-new findings in Wave 18.
- No major unexamined high-value category remains under the audit's threshold: material exact/semantic clones, dead production files/exports, divergent sources of truth, bypassed canonical utilities, stale compatibility code, package/artifact reachability, and correctness/security drift have all received repeated independent coverage.
- Further progress should move from discovery to implementation of the original 120 prioritized cleanup tracks, with verify-first gates preserved.

### 44.4 Wave limitations

- All five agents performed static, read-only analysis and changed no source files.
- Parent reconciliation used LSP and repository search to falsify the only proposed material correction.
- No runtime, visual, build, or test verification was performed because this workflow produced an audit report, not source changes.

## 45. Implementation Status

Implementation is tracked in `Plans/dedup-playbook/IMPLEMENTATION-LEDGER.md`. Status updates require refreshed source evidence, focused verification, and an explicit rollback unit.

### 45.1 Conflict baseline

| Priority | Disposition                                    | Evidence                                                                                                                                                                                                  |
| -------: | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|       75 | Already resolved on fresh `origin/rc` baseline | `window-manager.ts` delegates to `attachGuestWebviewSecurity`; `guest-webview-security.ts` imports the canonical shared partition matcher.                                                                |
|       94 | Already resolved on fresh `origin/rc` baseline | Zero source conflict markers; process, BrowserTab persistence/helpers, and settings suites passed 290 tests; forced main TypeScript build passed; Electron launched and rendered the Maestro application. |

At the Wave 14 closure, the implementation ledger recorded a reviewed, non-pending disposition for every then-current priority. The following is the historical Wave 14 status snapshot; the current 147-priority status is recorded in section 45.3. Historical investigation evidence above remains unchanged, and the ledger owns per-priority verification and rollback detail.

| Disposition                  | Count | Priorities                                                               |
| ---------------------------- | ----: | ------------------------------------------------------------------------ |
| Implemented                  |   122 | 1-15, 17-18, 20-21, 23-37, 40-47, 49-63, 65-69, 72-74, 76-93, 95, 97-134 |
| Retained                     |    10 | 16, 19, 22, 38, 39, 48, 64, 70, 71, 96                                   |
| Already resolved on baseline |     2 | 75, 94                                                                   |

P108 is implemented by the documentation source-of-truth matrix in `Plans/dedup-playbook/16-documentation.md`: runtime registries own template-variable and provider facts; named public pages own their audience-specific references; compatible copies link to those owners. Generated documentation remains source-derived.

### 45.2 Implementation Wave 14 — accepted after saturation review

Implementation Wave 14 added P121-P134 after the original 120-priority audit had converged. These accepted findings are post-saturation implementation and regression work, not retrospective changes to the original investigation. The ledger records their integrated commit evidence, focused verification, and rollback units:

- P121 uses a token-free renderer DTO for permission relay; P123-P124 remove dead synchronous Cue config exports and establish canonical Cue bridge/layout types (`bb6e585b9`).
- P122 prevents stale renderer results: Agent Sessions search, AutoRun folder validation, and worktree validation cancel superseded effects, while Cue YAML validation gates completion by request epoch (`c45d10205`).
- P125 gives `FileTreeRow` row-local long-press listener/timer ownership and covers cross-row interaction (`a165f39c0`, `d826a3a2e`).
- P126 removes test-only plugin convenience exports and corrects the canonical plugin plan (`d3d59e818`, `932d608f6`).
- P127-P130 remove dead prompt artifacts/orphan modules and unused package dependencies (`4476ca236`); P131 removes unsupported Rolldown debugger configuration (`f0d0f7b98`).
- P132-P134 canonicalize tab-handler resets and renderer test fixtures for `IntersectionObserver` and coarse-pointer `matchMedia` (`f8ef24338`).

### 45.3 Implementation Wave 15 — verified cleanup and retained compatibility policy

Wave 15 added P135-P147 after the historical Wave 14 closure. It implemented twelve verified cleanup tracks and retained P142 as an explicit compatibility policy decision. These current dispositions do not revise the historical Wave 14 counts above:

Wave 15 disposition count: **12 implemented, 1 retained**.

- **P135 implemented:** Removed the unused Husky package and generated `.husky/_` shims while retaining native root hooks.
- **P136 implemented:** Deleted the orphaned completed Wave 1 integration status note.
- **P137 implemented:** Migrated `shared/agentIds` callers to canonical `shared/agentRegistry` and deleted the shim/test duplication.
- **P138 implemented:** Deleted the zero-consumer `src/shared/index.ts` barrel.
- **P139 implemented:** Deleted the zero-consumer `src/prompts/index.ts` barrel.
- **P140 implemented:** Removed the duplicate renderer `*.md?raw` ambient declaration while retaining `src/types/vite-raw.d.ts`.
- **P141 implemented:** Removed the unused shared `LogLevel` compatibility alias.
- **P142 retained:** `ui:render-unsafe` is inert, but removing it requires a host major change and exact-major compatibility would invalidate all existing v1-targeted plugins. It was restored unchanged after review. This is an explicit retained policy decision, not an implementation.
- **P143 implemented:** Removed the zero-production-consumer plugin runtime-agent registry facade/module/tests while retaining manifest `contributes.agents` parsing and display.
- **P144 implemented:** Reused `serializedJsonByteLength` for plugin grouping payload enforcement while preserving local limits and errors.
- **P145 implemented:** Eliminated SessionList's duplicate contribution fetch/listener while retaining the live grouping subscription.
- **P146 implemented:** Centralized Wizard stream result/display parsing with provider precedence, opt-in Copilot behavior, and malformed nested-record safety.
- **P147 implemented:** Shared Wizard phase fallback splitting and permissive task counting while retaining different UPDATE/UI-stat contracts.

#### Wave 15 verification

- Integrated root focused run: 15 files, 538 tests passed.
- Root TypeScript checks for main, CLI, and renderer passed.
- Final pre-push verification passed the repository Prettier check, main/CLI/renderer TypeScript checks, and ESLint.
- Full Vitest passed: 1,443 files passed, 1 skipped out of 1,444; 34,581 tests passed, 109 skipped out of 34,690.
- Plugin SDK build passed; 2 files and 28 tests passed with no type errors.
- `bun install --frozen-lockfile --ignore-scripts` passed with no changes.
- Main and renderer production builds passed. The renderer emitted existing non-failing legacy-script, CSS syntax, and chunk-size warnings.
- Adversarial review found the capability-major issue; `ui:render-unsafe` was restored unchanged, stale removed-path documentation was corrected, and final recheck was non-blocking.
- The plugin E2E run is not a passing gate: it timed out on unrelated existing broker/scheduler failures.

#### Current disposition summary

| Disposition                  | Count | Priorities                                                                                               |
| ---------------------------- | ----: | -------------------------------------------------------------------------------------------------------- |
| Implemented                  |   134 | P1-P15, P17-P18, P20-P21, P23-P37, P40-P47, P49-P63, P65-P69, P72-P74, P76-P93, P95, P97-P141, P143-P147 |
| Retained                     |    11 | P16, P19, P22, P38, P39, P48, P64, P70, P71, P96, P142                                                   |
| Already resolved on baseline |     2 | P75, P94                                                                                                 |

Current invariant: **147 = 134 implemented + 11 retained + 2 already resolved**.
