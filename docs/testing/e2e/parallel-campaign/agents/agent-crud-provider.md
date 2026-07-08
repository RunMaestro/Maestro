# agent-crud-provider

Status: pending launch

## Scope

Agent CRUD, provider setup, Agent Sessions.

## Checklist

- [x] Inspect existing related E2E coverage and component surfaces.
- [x] Author deterministic active scenarios up to the lane target where feasible.
- [x] Add skipped/env-gated cases for real-provider-only flows.
- [x] Record files touched and scenario counts.
- [x] Commit lane work on `codex/e2e-agent-crud-provider`.

## Progress

### 2026-06-08 recovery tranche 20

- Scope: final manual fallback tranche for provider SSH modal reset, cancel, and duplicate persistence coverage.
- Authored: 7 active deterministic Playwright scenarios.
  - Resets Create New Agent remote command override to the SSH binary default.
  - Resets Edit Agent remote command override to the SSH binary default.
  - Clears Create New Agent SSH selection after a successful provider create.
  - Keeps Create New Agent SSH selection while switching provider drafts.
  - Cancels Edit Agent SSH remote draft without persisting remote execution.
  - Creates a duplicated provider agent with inherited SSH remote execution.
  - Creates a duplicated provider agent after clearing inherited SSH remote execution.
- Skipped/env-gated: no new rows.
- Lane target reached: 160 / 160 active matrix-backed scenarios; no active lane scenarios remain.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 979 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 0 duplicate titles in `e2e/agent-crud-provider.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `563b9db6c` - `test(e2e-agent-crud-provider): finish provider ssh modal coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 19

- Scope: manual fallback tranche for provider modal state transitions and duplicate-agent configuration persistence.
- Authored: 5 active deterministic Playwright scenarios.
  - Resets Create New Agent directory warning acknowledgment after path edits.
  - Ignores the Create New Agent folder-picker shortcut while SSH remote execution is selected.
  - Restores the Create New Agent folder-picker shortcut after returning to local execution.
  - Creates a duplicated provider agent with edited provider configuration.
  - Clears duplicated provider overrides before creating a copy.
- Skipped/env-gated: no new rows.
- Lane target remains: about 7 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 972 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 0 duplicate titles in `e2e/agent-crud-provider.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `023c2e08c` - `test(e2e-agent-crud-provider): add provider modal state coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 18

- Scope: manual fallback tranche for Create/Edit Agent keyboard close and reset behavior.
- Authored: 5 active deterministic Playwright scenarios.
  - Closes a filled Create New Agent provider draft with Escape.
  - Resets Create New Agent form state after a successful provider create.
  - Opens the Create New Agent folder picker with the keyboard shortcut.
  - Closes Edit Agent with Escape without saving draft changes.
  - Closes duplicate provider agent modal with Escape without adding a copy.
- Skipped/env-gated: no new rows.
- Lane target remains: about 12 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 968 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 0 duplicate titles in `e2e/agent-crud-provider.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `6fc534e46` - `test(e2e-agent-crud-provider): add modal keyboard reset coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 17

- Scope: manual fallback tranche for Create/Edit Agent SSH remote execution configuration.
- Authored: 5 active deterministic Playwright scenarios.
  - Creates a provider agent with SSH remote execution selected.
  - Scopes Create New Agent directory warnings to the selected SSH host.
  - Prefills duplicate provider agent modal with source SSH remote execution.
  - Persists Edit Agent SSH remote execution selection.
  - Returns an Edit Agent SSH remote selection to local execution.
- Skipped/env-gated: no new rows.
- Lane target remains: about 17 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 963 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 0 duplicate titles in `e2e/agent-crud-provider.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `e17df308a` - `test(e2e-agent-crud-provider): add ssh remote config coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 16

- Scope: manual fallback tranche for provider validation and reset behavior.
- Authored: 5 active deterministic Playwright scenarios.
  - Keeps Create New Agent disabled until required fields are complete.
  - Clears Create New Agent directory warnings after choosing an unused folder.
  - Creates after clearing Create New Agent optional provider overrides.
  - Keeps Edit Agent save disabled while the agent name is blank.
  - Cleans up Edit Agent provider-switch draft when switching back to the original provider.
- Skipped/env-gated: no new rows.
- Lane target remains: about 22 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 958 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 0 duplicate titles in `e2e/agent-crud-provider.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `e9541b64a` - `test(e2e-agent-crud-provider): add provider validation reset coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 15

- Scope: manual fallback tranche for provider draft lifecycle cancel and switch isolation.
- Authored: 3 active deterministic Playwright scenarios.
  - Cancels a filled Create New Agent provider draft without adding an agent.
  - Keeps Create New Agent provider drafts isolated while switching providers.
  - Cancels ordinary Edit Agent config drafts without saving changes.
- Skipped/env-gated: no new rows.
- Lane target remains: about 27 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 953 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 0 duplicate titles in `e2e/agent-crud-provider.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `0cb3fda43` - `test(e2e-agent-crud-provider): add provider draft lifecycle coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 14

- Scope: manual fallback tranche for provider group state and bookmark visibility.
- Authored: 5 active deterministic Playwright scenarios.
  - Renames a provider group when inline edit loses focus.
  - Keeps provider group name when inline rename is blank.
  - Marks the provider current group submenu item disabled.
  - Shows empty provider group delete control after moving the last agent to Ungrouped.
  - Keeps a bookmarked provider agent visible after moving it into a group.
- Skipped/env-gated: no new rows.
- Lane target remains: about 30 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 950 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 0 duplicate titles in `e2e/agent-crud-provider.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `230e6e1c3` - `test(e2e-agent-crud-provider): add group state coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 13

- Scope: manual fallback tranche for provider group validation and bookmark context-menu controls.
- Authored: 5 active deterministic Playwright scenarios.
  - Keeps Create New Group disabled for blank provider group names.
  - Cancels a Create New Group provider draft without adding a group.
  - Moves a provider agent into an existing group from the context menu.
  - Removes a provider bookmark from the left bar context menu.
  - Hides the empty-group delete control for populated provider groups.
- Skipped/env-gated: no new rows.
- Lane target remains: about 35 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 945 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 0 duplicate titles in `e2e/agent-crud-provider.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `07a01b7fb` - `test(e2e-agent-crud-provider): add group validation coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 12

- Scope: manual fallback tranche for Agent Sessions metadata, list rename, and graph/search interactions.
- Authored: 5 active deterministic Playwright scenarios.
  - Adds a name to an unnamed generic provider session from the list row.
  - Clears a generic provider session name from the list row with a blank rename.
  - Shows origin metadata pills for generic provider sessions.
  - Searches hidden generic provider session titles after Show All.
  - Clears an unmatched generic provider search when switching to activity graph.
- Skipped/env-gated: no new rows.
- Lane target remains: about 40 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 940 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 0 duplicate titles in `e2e/agent-crud-provider.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `d6f26a028` - `test(e2e-agent-crud-provider): add session metadata coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 11

- Scope: manual fallback tranche for Agent Sessions filter, rename, and hidden-session interactions.
- Authored: 5 active deterministic Playwright scenarios.
  - Saves a generic provider session list rename with Enter.
  - Clears a generic provider session detail name with a blank rename.
  - Syncs generic provider detail favorite changes back to the session list.
  - Opens hidden generic provider session detail after Show All.
  - Combines Named and Show All filters for hidden generic provider sessions.
- Skipped/env-gated: no new rows.
- Lane target remains: about 45 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
- Shared helpers edited: `stubCodexAgentSessionStorage` now provides a hidden-session detail message for the existing optional hidden fixture.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 935 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 0 duplicate titles in `e2e/agent-crud-provider.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `1bd023b7e` - `test(e2e-agent-crud-provider): add session filter coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 10

- Scope: manual fallback tranche for Agent Sessions list/detail interactions.
- Authored: 5 active deterministic Playwright scenarios.
  - Toggles a generic provider session favorite from the list row.
  - Cancels generic provider session list rename with Escape.
  - Opens a generic provider session with keyboard list navigation.
  - Resumes a generic provider session from detail with loaded messages.
  - Switches Agent Sessions activity graph back to search with the keyboard shortcut.
- Skipped/env-gated: no new rows.
- Lane target remains: about 50 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 930 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 0 duplicate titles in `e2e/agent-crud-provider.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `b6015f342` - `test(e2e-agent-crud-provider): add session interaction coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 9

- Scope: manual fallback tranche for provider lifecycle controls.
- Authored: 5 active deterministic Playwright scenarios.
  - Shows provider refresh debug info for an unavailable Create New Agent provider.
  - Refreshes an unavailable provider and creates once detection succeeds.
  - Creates a provider agent using folder picker and keyboard submit.
  - Saves Edit Agent changes with the keyboard shortcut.
  - Cancels Edit Agent provider-switch drafts without changing the agent.
- Skipped/env-gated: no new rows.
- Lane target remains: about 55 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 925 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 0 duplicate titles in `e2e/agent-crud-provider.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `a37cd777a` - `test(e2e-agent-crud-provider): add lifecycle control coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 8

- Scope: manual fallback tranche for provider configuration persistence.
- Authored: 5 active deterministic Playwright scenarios.
  - Persists Create New Agent nudge, path, args, env, model, and context-window config after reopening Edit Agent.
  - Persists Edit Agent nudge, path, args, env, model, and context-window config after save/reopen.
  - Clears Edit Agent optional provider config with Reset, Clear, and remove-variable controls.
  - Prefills duplicate-agent modal provider config from the source agent.
  - Persists provider-switch config and reopens on the new provider.
- Skipped/env-gated: no new rows.
- Lane target remains: about 60 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 920 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands, 0 duplicate titles in `e2e/agent-crud-provider.spec.ts`.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `dc7d732ce` - `test(e2e-agent-crud-provider): add provider config coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 7

- Scope: manual fallback tranche for provider Left Bar organization controls.
- Authored: 5 active deterministic Playwright scenarios.
  - Bookmarks a provider agent from the left bar context menu.
  - Collapses and expands the provider bookmarks section.
  - Toggles the active provider bookmark from Quick Actions.
  - Filters provider agents from Quick Actions and clears the filter with Escape.
  - Cancels and confirms deleting an empty provider group.
- Skipped/env-gated: no new rows.
- Lane target remains: about 65 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 915 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands.
  - Code-reviewer checklist: no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `b4e5f2bca` - `test(e2e-agent-crud-provider): add sidebar organization coverage`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

### 2026-06-08 recovery tranche 6

- Scope: manual fallback tranche for generic provider Agent Sessions list controls.
- Authored: 5 active deterministic Playwright scenarios.
  - Creates a fresh provider AI tab from the Agent Sessions New Session action.
  - Quick-resumes a generic provider session list row without opening detail or reading messages.
  - Preserves generic provider session metadata when quick-resuming.
  - Reveals hidden agent-prefixed generic provider sessions with Show All.
  - Scopes and clears generic provider Agent Sessions search controls.
- Skipped/env-gated: no new rows.
- Lane target remains: about 70 active scenarios plus fuller skipped/env-gated real-provider coverage.
- Files touched:
  - `e2e/agent-crud-provider.spec.ts`
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - `git diff --check`
  - Static scan: 910 declared E2E tests, 0 `.only`, 0 prohibited Playwright/E2E commands; known Director's Notes title-prefix matches remain in `e2e/app-shell.spec.ts`.
  - Code-reviewer checklist: approved with no blocking issues in the `agent-crud-provider` diff.
- Commit hashes:
  - `750e25fd0` - `test(e2e-agent-crud-provider): add session list controls`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.

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
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
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
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
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
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
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
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `docs/testing/e2e/parallel-campaign/coverage-ledger.md`
  - `docs/testing/e2e/coverage-campaign.md`
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
  - `docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
- Shared helpers edited: no.
- Broadcast update required: no.
- Checks run:
  - `npx prettier --write e2e/agent-crud-provider.spec.ts docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - `npx tsc --noEmit --skipLibCheck --target ES2022 --module commonjs --moduleResolution node --esModuleInterop --types node,playwright e2e/agent-crud-provider.spec.ts`
  - `npx eslint e2e/agent-crud-provider.spec.ts`
  - `git diff --check -- e2e/agent-crud-provider.spec.ts docs/testing/e2e/parallel-campaign/agents/agent-crud-provider.md`
  - Note: npm emitted `min-release-age` config warnings only; no TypeScript, ESLint, Prettier, or whitespace diagnostics.
- Commit hashes:
  - `9e13c6ed3e` - `test(e2e-agent-crud-provider): add provider CRUD tranche`
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.
  - Real provider storage/auth state is unavailable in deterministic lane coverage, so real provider scenarios remain skipped/env-gated.
