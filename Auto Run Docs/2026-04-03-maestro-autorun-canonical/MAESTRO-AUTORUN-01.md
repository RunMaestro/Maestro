# Phase 01: Canonical Current Truth And Baseline Closeout

This is the canonical playbook series for the remaining Maestro Auto Run work. Use this folder as the only execution source for the unfinished OpenClaw and DAG rollout.

Supersedes:
- `Auto Run Docs/Initiation/2026-04-03-openclaw-autorun-closeout/`
- `Auto Run Docs/Initiation/2026-04-02-openclaw-impl-main/Phase-04-Advanced-Integrations.md`
- `Auto Run Docs/Initiation/2026-04-02-openclaw-impl-main/Phase-05-Full-Validation-And-E2E.md`
- `Auto Run Docs/Initiation/2026-04-02-openclaw-impl-main/Phase-06-Release-Hardening.md`
- `Auto Run Docs/Optimization/2026-04-02-token-efficiency-dag/Phase-06-DAG-Schema-And-Validation.md`
- `Auto Run Docs/Optimization/2026-04-02-token-efficiency-dag/Phase-07-DAG-Scheduler-And-Ready-Queue.md`
- `Auto Run Docs/Optimization/2026-04-02-token-efficiency-dag/Phase-08-Worktree-Parallel-Isolation-And-Join.md`
- `Auto Run Docs/Optimization/2026-04-02-token-efficiency-dag/Phase-09-Run-Metrics-And-Verifier-Analytics.md`

## Tasks

- [x] Freeze the current truth before editing implementation files by reconciling the completed OpenClaw docs, the current uncommitted diff, and this canonical folder, then update only this folder if any remaining scope changes are discovered.
  - Reconciled the superseded OpenClaw and DAG phase docs against the current `git status --short` and `git diff --stat` on 2026-04-03.
  - Confirmed the current tree already contains in-flight work for baseline metadata round-tripping, OpenClaw runtime normalization, prompt assembly, timeout handling, verifier summaries, and early analytics UI surfaces.
  - Updated only the canonical folder so later agents treat those touched files as known current truth instead of accidentally re-scoping or duplicating the same work.
- [x] Finish shared playbook contract alignment in `src/shared/types.ts`, `src/shared/marketplace-types.ts`, and `src/main/preload/autorun.ts` so all baseline metadata fields round-trip from shared types through preload without one-off defaults.
  - Extracted shared `PlaybookBaselineMetadata`, `PlaybookWorktreeSettings`, `PlaybookDraft`, and `PlaybookUpdate` types in `src/shared/types.ts` so the baseline Auto Run metadata no longer needs parallel definitions.
  - Updated `src/shared/marketplace-types.ts` so marketplace manifests reuse the shared baseline metadata contract and imported playbooks return the shared persisted `Playbook` shape.
  - Updated `src/main/preload/autorun.ts` to alias the shared playbook/document/worktree/update types instead of maintaining a local preload-only `Playbook` interface, then verified the contract with `npx tsc -p tsconfig.main.json --noEmit` and the targeted Vitest suites for preload, playbooks, and marketplace handlers.
- [x] Finish playbook serialization and import or export alignment in `src/main/ipc/handlers/playbooks.ts`, `src/main/ipc/handlers/marketplace.ts`, `src/cli/commands/show-playbook.ts`, `src/cli/output/formatter.ts`, and `src/cli/output/jsonl.ts` so saved, imported, and printed playbooks all expose the same baseline metadata.
  - Replaced the ZIP manifest hand-rolled field list in `src/main/ipc/handlers/playbooks.ts` with shared `PlaybookDraft`-based archive helpers so export/import keep the same baseline metadata shape and defaults.
  - Updated `src/main/ipc/handlers/marketplace.ts` to normalize any existing session playbooks before appending imported marketplace entries, and to create imported playbooks through a shared `PlaybookDraft` path instead of a second one-off mapper.
  - Updated `src/cli/commands/show-playbook.ts` to build one normalized detail payload for both human and JSON output, extended `src/cli/output/formatter.ts` and `src/cli/output/jsonl.ts` to carry the shared baseline metadata contract, and added focused regressions for marketplace persistence plus CLI formatter and JSONL output.
  - Verified with `npx tsc -p tsconfig.main.json --noEmit`, `npx tsc -p tsconfig.cli.json --noEmit`, `npx eslint --no-warn-ignored ...`, and `npx vitest run src/__tests__/main/ipc/handlers/playbooks.test.ts src/__tests__/main/ipc/handlers/marketplace.test.ts src/__tests__/cli/commands/show-playbook.test.ts src/__tests__/cli/output/formatter.test.ts src/__tests__/cli/output/jsonl.test.ts`.
- [x] Finish baseline runtime and renderer adoption in `src/renderer/hooks/batch/usePlaybookManagement.ts`, `src/renderer/components/BatchRunnerModal.tsx`, `src/renderer/components/MarketplaceModal.tsx`, `src/renderer/services/inlineWizardDocumentGeneration.ts`, `src/cli/services/agent-spawner.ts`, `src/cli/services/batch-processor.ts`, `src/cli/services/skill-resolver.ts`, `src/renderer/hooks/batch/useDocumentProcessor.ts`, `src/renderer/hooks/batch/useBatchProcessor.ts`, `src/renderer/hooks/batch/useBatchHandlers.ts`, `src/renderer/App.tsx`, and `src/shared/markdownTaskUtils.ts` so the current Batch Runner, wizard-generated playbooks, CLI Auto Run flow, prompt assembly, timeout handling, and verifier summaries all consume the same baseline fields without drift.
  - Extended runtime `BatchRunConfig` baseline coverage so renderer dispatch now preserves `skills`, `promptProfile`, `documentContextMode`, and `skillPromptMode` instead of dropping them between loaded playbooks and `onGo`.
  - Updated `usePlaybookManagement` to preserve prompt profile and context/skill modes on load/save-update, and kept marketplace or wizard-created playbooks from silently collapsing back to one-off renderer defaults.
  - Unified active-task document compaction in `src/shared/markdownTaskUtils.ts` and reused it from CLI plus renderer prompt assembly so `documentContextMode` now affects both runtime paths consistently.
  - Updated renderer `useDocumentProcessor` prompt assembly to inline either the full document or active-task-only context and to include requested skills guidance in the generated prompt block.
  - Kept the in-flight Codex plan/execute resume fix and skill-bus history recording changes in the same runtime cluster, then verified with `npx tsc -p tsconfig.json --noEmit`, `npx tsc -p tsconfig.main.json --noEmit`, `npx tsc -p tsconfig.cli.json --noEmit`, `npx eslint --no-warn-ignored ...`, and `npx vitest run src/__tests__/renderer/hooks/useDocumentProcessor.test.ts src/__tests__/renderer/components/BatchRunnerModal.test.tsx src/__tests__/cli/services/batch-processor.test.ts src/__tests__/renderer/services/inlineWizardDocumentGeneration_playbook.test.ts`.
- [ ] Close the OpenClaw baseline runtime issues in `src/shared/openclawSessionId.ts`, `src/main/parsers/openclaw-output-parser.ts`, `src/main/process-manager/handlers/ExitHandler.ts`, and `src/main/storage/openclaw-session-storage.ts` so canonical session IDs and batch JSON failures behave consistently across baseline paths.
- [ ] Add or update the focused regression suites for the baseline file clusters above, including the CLI Auto Run, document processor, renderer history-detail, and wizard-generated playbook paths already touched in the current diff, then run the narrow lint and Vitest commands plus one deterministic Auto Run smoke path that proves baseline metadata and OpenClaw results render correctly in Maestro.
