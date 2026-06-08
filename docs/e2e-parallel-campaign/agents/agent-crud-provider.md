# agent-crud-provider

Status: pending launch

## Scope

Agent CRUD, provider setup, Agent Sessions.

## Checklist

- [x] Inspect existing related E2E coverage and component surfaces.
- [ ] Author deterministic active scenarios up to the lane target where feasible.
- [x] Add skipped/env-gated cases for real-provider-only flows.
- [x] Record files touched and scenario counts.
- [x] Commit lane work on `codex/e2e-agent-crud-provider`.

## Progress

### 2026-06-08 recovery tranche 5

- Scope: manual fallback tranche for duplicate-agent and destructive delete flows.
- Authored: 5 active deterministic Playwright scenarios.
  - Opens Create New Agent from Quick Actions with provider setup controls.
  - Cancels provider agent duplication without adding a copy.
  - Duplicates a provider agent from the context menu with folder picker creation.
  - Removes a disposable provider agent only while preserving its working directory.
  - Deletes a provider working directory after exact-name confirmation.
- Skipped/env-gated: no new rows.
- Lane target remains: about 75 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/e2e-parallel-campaign/agents/agent-crud-provider.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 905 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 2 pre-existing duplicate titles in `e2e/app-shell.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `8bbf419f8` - `test(e2e-agent-crud-provider): add duplicate delete coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 4

- Scope: manual fallback tranche for grouped-agent organization in the Agent CRUD surface.
- Authored: 5 active deterministic Playwright scenarios.
  - Creates an agent group from Quick Actions.
  - Moves a provider agent into a group and returns it to Ungrouped Agents.
  - Creates a group from a provider context menu and moves the agent into it.
  - Collapses and expands a provider agent group section.
  - Renames a populated provider agent group inline.
- Skipped/env-gated: no new rows.
- Lane target remains: about 80 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/e2e-parallel-campaign/agents/agent-crud-provider.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 900 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 2 pre-existing duplicate titles in `e2e/app-shell.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `9362cf4fc` - `test(e2e-agent-crud-provider): add group organization coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 3

- Scope: manual fallback tranche for generic provider Agent Sessions controls.
- Authored: 5 active deterministic Playwright scenarios.
  - Opens a generic provider session detail view with stored messages and cost.
  - Favorites a generic provider session through shared `agentSessions` storage.
  - Renames a generic provider session detail through shared `agentSessions` storage.
  - Routes user and assistant search modes through generic provider search storage.
  - Adds a name to an unnamed generic provider session and resumes it with the keyboard.
- Skipped/env-gated: no new rows.
- Lane target remains: about 85 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/e2e-parallel-campaign/agents/agent-crud-provider.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 895 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 2 pre-existing duplicate titles in `e2e/app-shell.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `ef05abd54` - `test(e2e-agent-crud-provider): add provider session controls`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 2

- Scope: manual fallback tranche for validation-heavy Agent CRUD/provider setup coverage.
- Authored: 5 active deterministic Playwright scenarios.
  - Create New Agent duplicate-name validation blocks create and clears after rename.
  - Create New Agent same-directory warning requires explicit acknowledgment.
  - Create New Agent unavailable OpenCode provider requires custom path while preserving args/env drafts.
  - Edit Agent duplicate-name validation blocks save and clears after restoring the original name.
  - Edit Agent unavailable OpenCode provider switch warning requires custom path while preserving args/env drafts.
- Skipped/env-gated: no new rows.
- Lane target remains: about 90 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/e2e-parallel-campaign/agents/agent-crud-provider.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 890 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 2 pre-existing duplicate titles in `e2e/app-shell.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `03961a3e7` - `test(e2e-agent-crud-provider): add provider validation coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 1

- Scope: first coherent tranche only per capacity guard.
- Authored: 9 active deterministic Playwright scenarios.
  - 4 provider setup matrix create scenarios: Codex, Claude Code, OpenCode, Factory Droid.
  - 3 Agent CRUD lifecycle scenarios: rename, delete cancel, agent-only delete.
  - 2 Agent Sessions provider-storage scenarios: named-only filtering and generic content search.
- Skipped/env-gated: 2 real-provider-state placeholders under `MAESTRO_E2E_REAL_PROVIDER_STATE`.
- Lane target remains: about 104 additional active scenarios; remaining work is about 95 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/e2e-parallel-campaign/agents/agent-crud-provider.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts docs/e2e-parallel-campaign/agents/agent-crud-provider.md`
  - `npx tsc --noEmit --skipLibCheck --target ES2022 --module commonjs --moduleResolution node --esModuleInterop --types node,playwright e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `git diff --check -- e2e/agent-crud-provider.spec.ts docs/e2e-parallel-campaign/agents/agent-crud-provider.md`
  - Note: npm emitted `min-release-age` config warnings only; no TypeScript, ESLint, Prettier, or whitespace diagnostics.
- Commit hashes:
  - `9e13c6ed3e` - `test(e2e-agent-crud-provider): add provider CRUD tranche`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.
  - Real provider storage/auth state is unavailable in deterministic lane coverage, so real provider scenarios remain skipped/env-gated.
