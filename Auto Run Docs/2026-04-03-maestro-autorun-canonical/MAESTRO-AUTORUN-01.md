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
- [ ] Finish playbook serialization and import or export alignment in `src/main/ipc/handlers/playbooks.ts`, `src/main/ipc/handlers/marketplace.ts`, `src/cli/commands/show-playbook.ts`, `src/cli/output/formatter.ts`, and `src/cli/output/jsonl.ts` so saved, imported, and printed playbooks all expose the same baseline metadata.
- [ ] Finish baseline runtime and renderer adoption in `src/renderer/hooks/batch/usePlaybookManagement.ts`, `src/renderer/components/BatchRunnerModal.tsx`, `src/renderer/components/MarketplaceModal.tsx`, `src/renderer/services/inlineWizardDocumentGeneration.ts`, `src/cli/services/agent-spawner.ts`, `src/cli/services/batch-processor.ts`, `src/cli/services/skill-resolver.ts`, `src/renderer/hooks/batch/useDocumentProcessor.ts`, `src/renderer/hooks/batch/useBatchProcessor.ts`, `src/renderer/hooks/batch/useBatchHandlers.ts`, `src/renderer/App.tsx`, and `src/shared/markdownTaskUtils.ts` so the current Batch Runner, wizard-generated playbooks, CLI Auto Run flow, prompt assembly, timeout handling, and verifier summaries all consume the same baseline fields without drift.
- [ ] Close the OpenClaw baseline runtime issues in `src/shared/openclawSessionId.ts`, `src/main/parsers/openclaw-output-parser.ts`, `src/main/process-manager/handlers/ExitHandler.ts`, and `src/main/storage/openclaw-session-storage.ts` so canonical session IDs and batch JSON failures behave consistently across baseline paths.
- [ ] Add or update the focused regression suites for the baseline file clusters above, including the CLI Auto Run, document processor, renderer history-detail, and wizard-generated playbook paths already touched in the current diff, then run the narrow lint and Vitest commands plus one deterministic Auto Run smoke path that proves baseline metadata and OpenClaw results render correctly in Maestro.
