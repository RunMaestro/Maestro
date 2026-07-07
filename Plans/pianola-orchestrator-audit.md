# Pianola Orchestrator + Maestro Plugin-System Audit

> Source: multi-agent audit workflow (run `wf_a944e2e4-942`), 2026-06-25. 6 mappers,
> 3 assessors, 2 designers, 1 synthesizer. One mapper (pianola-brain) failed to
> return structured output; assessments still ran on the remaining maps.

## Verdict

- **Pianola is a strong autonomous SUPERVISOR / human-in-the-loop gate, NOT an orchestrator.** Completeness 4/10. `isUltimateOrchestrator: false`.
- The decision core is genuinely well-built (pure, DI, audit-before-dispatch, high-risk-always-escalates, bounded retry). Scores: orchestrator-completeness 3/10, robustness 6/10.
- The orchestration spine does not exist in code: no task model, no dependency DAG, no ordering, no completion/failure detection, no concurrency control, no coordinator. Decomposition/sequencing is offloaded to LLM prose in `pianola-system.md` with zero structured backing. Against 30 interdependent tasks it fires them all at once and never notices completion or failure.
- It is also fragile as a long-running actor (see Sprint 0).
- **Maestro is NOT plugin-ready** (plugin-readiness 3/10). Zero runtime plugin infra: every extension point is registered at startup from hardcoded import lists. Renderer is deliberately hardened (contextIsolation, sandbox, preload-only); main runs with unrestricted Node. No in-between sandbox. But mature extension _patterns_ exist (DI handler registration, contextBridge factories, Encore flags, data-driven marketplace/prompts/Cue, Pianola as a full vertical slice) plus a real distribution channel (GitHub playbook marketplace).

## Sprint 0 - Pianola consent + correctness hardening (P0, unambiguous, build regardless)

These close consent-safety and correctness holes that undermine the whole HITL premise.

Status (2026-06-26): ALL 4 Sprint 0 items are SHIPPED. (1) `rehydrateWatchState` seeds the
cursor from the audit log and is wired in `pianola.ts`; (2) the watch loop re-reads
`encoreFeatures.pianola` each poll and self-stops; (3) `deps.notify` + `safeNotify` fire toasts;
(4) `pendingHandoff` + `HANDOFF_TIMEOUT_POLLS` give handoff-failure fallback and timeout.

Track status (2026-06-30): Track A Phase 1 and Track A Phase 2 are BUILT + tested.
Phase 1 shipped `pianola-tasks.ts`, `pianola-completion-detector.ts`,
`pianola-orchestrator.ts`, `pianola orchestrate`, `pianola-supervisor.ts`, and
`supervise`. Phase 2 shipped capability/load-aware selection, scheduled re-learn

- relaunch, and in-app learning suggestions; see `Plans/pianola-implementation-plan.md`
  lines 183-193 for the exact modules and invariants. Track B is substantially BUILT
  (`main/plugins/`: PluginManager, PermissionBroker, PluginSandboxHost,
  PluginSchedulerHost; `shared/plugins/`: registry/manifest/contributions/host-api/signing;
  `PluginsPanel.tsx`; gated on `encoreFeatures.plugins`) - the original verdict's
  "NOT plugin-ready" predates this work. Remaining work is the open forks below plus the
  current plugin/Pianola integration roadmap in `Plans/plugin-platform-and-encore-uplift.md`.

1. **Durable watch-state rehydration across restart** (S). `WatchState` is fresh on every watch start (`src/cli/commands/pianola.ts`), so a restarted watcher re-answers the still-waiting prompt a SECOND time. Add pure `rehydrateWatchState(records, target)` that folds the audit log to seed `lastHandledMessageId` before the poll loop. Files: `src/shared/pianola/pianola-watcher.ts`, `src/cli/commands/pianola.ts`, `src/cli/services/pianola-store.ts`.
2. **Watcher self-stop when the Encore flag is revoked** (S). `ensurePianolaEnabled()` is checked once at startup and never re-read in the loop, so toggling Pianola off does not halt in-flight autonomous answering. Re-read `encoreFeatures.pianola` at the top of each poll iteration and break cleanly. File: `src/cli/commands/pianola.ts`.
3. **Proactive escalation notifications** (M). Escalations only land in a passive dashboard badge. Add optional `deps.notify` to the pure watcher; the CLI fires `notifyToast` (clickAction jump-session, `sourceAgent: 'Pianola'`, dismissible for high-risk). Files: `src/shared/pianola/pianola-watcher.ts`, `src/cli/commands/pianola.ts`, `src/renderer/stores/notificationStore.ts`.
4. **Handoff-failure fallback to user + completion/timeout tracking** (M). On `requestJudgment` failure the cursor still advances and the ask is dropped with the user never told. Do NOT advance the cursor; synthesize an escalate-to-user decision, audit it, notify; add `pendingHandoff` + poll timeout so a stalled Pianola re-escalates. Files: `src/shared/pianola/pianola-watcher.ts`, `src/cli/commands/pianola.ts`.

## Track A - Pianola orchestration spine (only if we want a true orchestrator)

**Phase 1**

- **Task DAG model** (XL, P1) - new pure `src/shared/pianola/pianola-tasks.ts` (`PianolaTask`/`PianolaPlan`, `validatePlan` + Kahn cycle detection, `computeReady`, `markTaskStatus`, `propagateBlocked`) + storage contract. Foundation everything else consumes.
- **Completion + failure detection** (L, P1) - new pure `pianola-completion-detector.ts` returning `done|failed|working` from a busy->idle session transition + failure heuristics, reusing `src/main/cue/cue-completion-service.ts` semantics.
- **Multi-agent orchestration engine + concurrency control** (XL, P1) - pure `runOrchestratorIteration(plan, state, deps)`; `pianola orchestrate` CLI; a serializing dispatch path (today `runDispatch` rejects follow-ups to busy agents unless `allowConcurrentSend`).
- **Desktop watcher/orchestrator registry with supervision** (L, P1) - main-process registry persists active targets, spawns via `ProcessManager` with bounded-backoff restart + health, relaunches on app start; replaces ~10 unmanaged `nohup` processes.

**Phase 2** - outcome->profile/rule learning loop with in-app suggestions (L, P2); audit-log rotation + task/agent-scoped dashboard views (M, P2); scheduled re-learn + watcher relaunch (M, P2); capability/load-aware agent selection.

## Track B - Community plugin system (tiered; design-first, then Tier 0)

**Recommendation: design-first now, build Tier 0 (data-only) next, do NOT build an executable-code SDK yet.** Two non-negotiable commitments before Tier 0 ships: (1) `window.maestro.plugins` + `hostApi` become a permanent semver-managed public contract; (2) add settings schema versioning/migration (electron-store has none).

**Extension points (each maps to a real existing seam):** IPC host actions (registerAllHandlers DI), `window.maestro.plugins` (contextBridge factories), commands (QuickActions + shortcuts), panels/tabs/modals (useModalLayer + modalPriorities), themes (THEMES array), settings (settingsMetadata), agents (AGENT_IDS as-const tuple), Cue triggers (TriggerSource pollNow), background tasks (scheduler wiring), prompts (CORE_PROMPTS override loader), distribution (marketplace-service GitHub fetch/cache).

**Phased rollout:**

- **Phase 0 - Foundations** (no user-facing plugins): freeze `plugin.json` schema (Zod) + versioned hostApi contract; stand up `PluginRegistry`/`PluginManager` behind `encoreFeatures.plugins`; FIRST consolidate two debts that double the blast radius - the CLI-vs-desktop pianola-store split and the 4-way-duplicated `AgentCapabilities`; add `registerPluginHandlers(deps)` + `createPluginsApi()` (list-only).
- **Phase 1 - Tier 0 data plugins** (ship first, lowest risk, nothing executes): wire `contributes.prompts/themes/settings/command-macros` into existing registries; generalize `marketplace-service.ts` into a plugin index (6h TTL cache, local-manifest override, `assertSafeTargetFolderName` guard, hot-reload broadcast, content-hash pinning); Plugins settings panel (install/enable/disable/uninstall).
- **Phase 2 - Declarative Cue + background contributions**: runtime Cue trigger registration; supervised plugin scheduler (the same primitive that fixes Pianola's unsupervised-watcher bug class); activationEvents.
- **Phase 3 - Tier 1 sandboxed compute + permission broker**: per-plugin Electron `utilityProcess` + MessagePort RPC (`@maestro/plugin-sdk`); `PermissionBroker` with capability-scoped grants replacing boolean Encore flags; install-time consent UI; ed25519 signing; SSH-aware brokered spawn via `wrapSpawnWithSsh`; instant teardown on disable. Red-team the broker before shipping.
- **Phase 4 - Tier 2 UI contributions**: auto-allocated modal-priority plugin band, reserved theme/settings namespaces, sandboxed-iframe panels/modals, command dispatch into plugin RPC.
- **Phase 5 - Runtime agents** (heaviest, last): convert `AGENT_IDS` from compile-time tuple to a runtime `AgentRegistry`; runtime parser/storage registration; relax `agent-completeness.test.ts`.

## Open forks (gate the expensive work)

1. Pianola identity: true orchestrator (build Track A Phase 1 XL spine) vs. hardened supervisor only.
2. Orchestrator runtime: CLI loop vs. desktop-managed supervised daemon (also fixes the nohup-orphan bug class).
3. Plan decomposition: LLM proposes -> code enforces ordering (write into structured PianolaPlan), vs. require structured plan authoring before multi-task dispatch.
4. Plugin ambition: data-only Tier 0 (light commitment) vs. full SDK incl. untrusted compute (utilityProcess/broker/signing - the dominant risk surface).
5. Sequencing: overlap Sprint 0 + Plugin Phase 0 (they share the store/dedup consolidation) vs. finish Pianola first.
