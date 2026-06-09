# autorun-ai-terminal

Status: forty-first tranche authored

## Scope

Auto Run plus Codex-only AI terminal workflows.

## Checklist

- [x] Inspect existing related E2E coverage and component surfaces.
- [x] Author deterministic active scenarios for the first tranche.
- [x] Keep live provider coverage Codex-only.
- [x] Record files touched and scenario counts.
- [x] Commit lane work on `codex/e2e-autorun-ai-terminal`.

## Progress

First tranche:

- Added `e2e/autorun-ai-terminal.spec.ts`.
- Active tests: 5.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; Codex prompt dispatch uses a stubbed `process:spawn` handler.

Covered:

- Seeded Codex Auto Run document rendering and task progress.
- Auto Run edit/save persistence for the selected Codex document.
- Auto Run batch configuration opening without starting a live provider.
- Seeded Codex AI terminal transcript controls.
- Stubbed Codex AI terminal prompt dispatch.

Validation:

- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- `git diff --check` passed.

Remaining work:

- Expand the rest of the Auto Run matrix.
- Expand Codex AI terminal queue, attachment, slash-command, transcript action, interrupt, and error-state cases.
- Run actual Playwright/E2E validation only after orchestrator approval.

Second tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 10.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `25df7b9d8`.
- Tranche implementation commit: `825e24335`.

Covered:

- Duplicate Auto Run document creation guard for a Codex lane agent.
- File-backed Auto Run document creation and edit-mode handoff.
- External Auto Run document refresh discovery.
- Long queued Codex prompt expansion with attachment count.
- Queued Codex prompt removal confirmation.

Validation:

- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.

Remaining work:

- Matrix-backed remaining after this tranche: 263.
- Continue with small tranches for Codex AI terminal slash-command, transcript action, interrupt, and error-state cases without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Third tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 15.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `01aa94ad2`.
- Tranche implementation commit: `17ebbf815`.

Covered:

- Codex execution queue browser opening from the AI terminal queue indicator.
- Current-agent and all-agent queue browser view switching.
- Queue-browser removal of a queued Codex `/history` slash command.
- Read-only metadata propagation through the stubbed Codex `process:spawn` path.
- Codex AI terminal image attachment staging and removal without dispatching.

Validation:

- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `npx tsc --noEmit --pretty false --project tsconfig.lint.json` is blocked by existing missing `src/generated/prompts`.
- `git diff --check` passed.

Remaining work:

- Matrix-backed remaining after this tranche: 258.
- Continue with small tranches for Codex AI terminal transcript action, interrupt, active-error, and deeper Auto Run variants without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Fourth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 20.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `2008b91dc`.
- Tranche implementation commit: `05ed4710a`.

Covered:

- In-flight Codex prompt interruption through the lane Stop control.
- Codex thinking display state cycling without dispatching a draft.
- History/read-only local toggle preservation for an unsent Codex draft.
- Recoverable active Codex error banner controls.
- Active Codex error detail modal JSON expansion without clearing the banner.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.

Remaining work:

- Matrix-backed remaining after this tranche: 253.
- Continue with small tranches for Codex AI terminal transcript action, @mention/slash variants, non-recoverable active-error states, and deeper Auto Run variants without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Fifth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 25.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `4f6d936c9`.
- Tranche implementation commit: `d0fac18ef`.

Covered:

- Codex lane transcript filtering from the AI input shortcut.
- Formatted/plain markdown toggling for a seeded Codex response.
- Saving a seeded Codex response to markdown inside the temporary workbench.
- Delivered Codex user-message transcript action visibility.
- Canceling paired user-message/response deletion without removing transcript content.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.

Remaining work:

- Matrix-backed remaining after this tranche: 248.
- Continue with small tranches for Codex AI terminal replay/delete confirmation, @mention/slash variants, non-recoverable active-error states, and deeper Auto Run variants without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Sixth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 30.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `a77f06059`.
- Tranche implementation commit: `0b97e89fd`.

Covered:

- Replaying a delivered Codex lane user message through the stubbed spawn path.
- Confirmed deletion of a delivered user message and paired response.
- Slash-command filtering/completion without dispatching.
- Inserting a README file mention from @mention suggestions.
- Dismissing NOTES file mention suggestions while preserving the draft.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.

Remaining work:

- Matrix-backed remaining after this tranche: 243.
- Continue with small tranches for non-recoverable active-error states, queue ordering/current-tab variants, and deeper Auto Run variants without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Seventh tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 35.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `925802ef7`.
- Tranche implementation commit: `24fdd6e50`.

Covered:

- Switching between seeded Auto Run documents for the Codex lane agent.
- Closing the Auto Run document selector with Escape while preserving selection.
- Canceling new document creation without creating a file.
- Closing new document creation with Escape and resetting the draft.
- Saving Phase 2 edits without changing Phase 1 content.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.

Remaining work:

- Matrix-backed remaining after this tranche: 238.
- Continue with small tranches for non-recoverable active-error states, queue ordering/current-tab variants, Auto Run preview/search/link/image variants, and deeper Auto Run run-state variants without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Eighth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 40.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `412e28bc6`.
- Tranche implementation commit: `cd4ff21c1`.

Covered:

- Auto Run preview search open, match, no-match, and close states.
- Bionify preview-mode toggle for the selected document.
- Auto Run guide modal open and primary close action.
- Canceling completed-task reset without changing the document.
- Confirming completed-task reset and updating the task counter.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.

Remaining work:

- Matrix-backed remaining after this tranche: 233.
- Continue with small tranches for non-recoverable active-error states, queue ordering/current-tab variants, Auto Run image/lightbox/link variants, and deeper Auto Run run-state variants without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Ninth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 45.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `40e81b93b`.
- Tranche implementation commit: `31fae224b`.

Covered:

- Non-recoverable Codex active-error banner without inline dismiss.
- Permission-denied error details without modal dismiss controls.
- Non-recoverable error JSON detail expansion.
- Closing the error modal while preserving the active banner.
- Retrying the permission-denied error and restoring terminal focus.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no critical/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 228.
- Continue with small tranches for queue ordering/current-tab variants, Auto Run image/lightbox/link variants, deeper Auto Run run-state variants, and Codex AI terminal live retry/recovery modal edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Tenth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 50.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `08efd064a`.
- Tranche implementation commit: `b2ab347f1`.

Covered:

- Multi-tab Codex queue indicator summaries.
- Active Main-tab queue filtering in the terminal list.
- Review-tab queue filtering after tab selection.
- Queue-browser visibility for all queued work across lane AI tabs.
- Inactive-tab queue removal without changing active Main-tab queued work.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no critical/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 223.
- Continue with small tranches for queue ordering/reorder variants, Auto Run image/lightbox/link variants, deeper Auto Run run-state variants, and Codex AI terminal live retry/recovery modal edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Eleventh tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 55.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `0fdd7f547`.
- Tranche implementation commit: `183562469`.

Covered:

- Auto Run wiki-style file links into the Codex Phase 2 document.
- Auto Run markdown file links into the Codex Phase 2 document.
- Auto Run external preview link routing through stubbed shell IPC.
- URL-encoded Auto Run preview image opening in the lightbox.
- Missing Auto Run preview image load-error rendering.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no critical/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 218.
- Continue with small tranches for queue ordering/reorder variants, deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, and Codex AI terminal live retry/recovery modal edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Twelfth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 60.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `d7ea5df8b`.
- Tranche implementation commit: `209c70f85`.

Covered:

- Codex thinking transcript entry rendering with its source label.
- Running, completed, and failed Codex tool transcript rows with deterministic details.
- Historical Codex transcript error details and JSON expansion.
- Transcript inline copy feedback for a thinking block.
- Transcript filtering across tool and thinking sentinel rows.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no critical/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 213.
- Continue with small tranches for queue ordering/reorder variants, deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, and Codex AI terminal live retry/recovery modal edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Thirteenth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 65.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `5006ce6a2`.
- Tranche implementation commit: `4b6a5fa70`.

Covered:

- Empty Auto Run batch document selection disables Go before dispatch.
- No-task Auto Run document selection disables Go before dispatch.
- Multi-document loop max controls persist the selected iteration count.
- Reset-enabled duplicate document selections keep the batch runnable.
- Prompt validation disables Go for blank or invalid batch prompts and re-enables it for valid content.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found one selector-load flake risk and it was fixed before the implementation commit.

Remaining work:

- Matrix-backed remaining after this tranche: 208.
- Continue with small tranches for queue ordering/reorder variants, deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, and Codex AI terminal live retry/recovery modal edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Fourteenth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 70.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `5d2990cc0`.
- Tranche implementation commit: `cf10742da`.

Covered:

- No-folder Auto Run setup guidance and Select Auto Run Folder affordance.
- Empty Auto Run folder state for a configured Codex lane folder.
- Empty-folder refresh discovery after a Markdown document appears.
- Persisted Auto Run edit mode restoration for the selected document.
- Persisted Phase 2 document selection restoration.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 70 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found two selector-behavior risks; both were fixed, and re-review found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 203.
- Continue with small tranches for queue ordering/reorder variants, deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, and Codex AI terminal live retry/recovery modal edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Fifteenth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 75.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `6543a1bef`.
- Tranche implementation commit: `304197fbf`.

Covered:

- Terminal-list queued slash-command removal after confirmation.
- Execution queue browser Escape close without clearing queued work.
- Empty current-agent queue browser state after all queued work is removed.
- Cross-agent queued work in the All Agents browser view.
- Companion-session queue removal without clearing the active Codex queue.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 75 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 198.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, and Codex AI terminal live retry/recovery modal edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Sixteenth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 80.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `7207f3553`.
- Tranche implementation commit: `ed724aa62`.

Covered:

- Auto Run document selector task-completion percentages.
- Configured-folder change setup opened from the selector dropdown.
- New document creation when the name already includes `.md`.
- New document creation inside a nested Auto Run folder.
- Nested Auto Run selector-tree expansion and document selection.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 80 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 193.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, and Codex AI terminal live retry/recovery modal edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Seventeenth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 85.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `700a7cca8`.
- Tranche implementation commit: `a80fa7624`.

Covered:

- Inline dismiss for a recoverable Codex active-error banner.
- Authentication-required recovery modal actions.
- Context-limit recovery modal without dismiss controls.
- Rate-limit recovery modal retry/dismiss actions.
- Crashed-agent recovery modal actions without dispatching a restart.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 85 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 188.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, Codex AI terminal retry execution safeguards, and terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Eighteenth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 90.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `faab6fd8b`.
- Tranche implementation commit: `8ecba8b2c`.

Covered:

- Network-error recovery action clearing from the Codex lane active-error modal.
- Rate-limit retry action clearing from the Codex lane active-error modal.
- Saved body persistence for a newly created Codex lane Auto Run document.
- External deletion refresh removal for a stale Codex lane Auto Run document.
- Preview search close/reopen query reset for the selected Codex lane document.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 90 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 183.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, terminal transcript edge states, and live-provider retry execution safeguards without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Nineteenth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 95.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `fd76bbfd5`.
- Tranche implementation commit: `6f4699c62`.

Covered:

- Thinking transcript block save-to-markdown action.
- Thinking transcript formatted/plain toggle.
- Failed tool transcript copy feedback.
- No-match transcript output filter feedback and Escape restoration.
- Historical transcript error details without live recovery actions.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 95 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 178.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Twentieth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 100.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `ed25a7b64`.
- Tranche implementation commit: `0af54b331`.

Covered:

- Unsaved Codex lane Auto Run edit discard from the bottom panel.
- Keyboard-save persistence for Codex lane Auto Run edits.
- Tab character insertion inside the Codex lane Auto Run editor.
- Checkbox insertion through the Auto Run editor shortcut.
- Task-list continuation from the Auto Run editor keyboard.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 100 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 173.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Twenty-first tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 105.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `98be2904f`.
- Tranche implementation commit: `5366746d4`.

Covered:

- Auto Run template autocomplete filtering from Codex lane editor input.
- Enter insertion of the first filtered Auto Run template variable.
- Escape dismissal that preserves the typed template trigger text.
- Pointer selection of a filtered Auto Run template variable.
- Tab acceptance of a filtered Auto Run template variable before editor tab insertion.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 105 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 168.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Twenty-second tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 110.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `647415ca6`.
- Tranche implementation commit: `6c52d6c4b`.

Covered:

- Keyboard undo for typed Codex lane Auto Run editor drafts.
- Keyboard redo after an Auto Run editor undo.
- Redo stack clearing after a new Codex lane editor draft.
- Undo for Auto Run checkbox shortcut insertion.
- Undo for Auto Run ordered-list continuation.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 110 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 163.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Twenty-third tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 115.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `dcc6c4167`.
- Tranche implementation commit: `8a489770a`.

Covered:

- Auto Run edit-mode search next/previous toolbar navigation.
- Enter wraparound through edit-mode search results.
- Shift+Enter reverse wraparound through edit-mode search results.
- Escape close behavior that refocuses the Auto Run editor.
- Live search result-count updates when editor content changes.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 115 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 158.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Twenty-fourth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 120.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `b6ab89fdd`.
- Tranche implementation commit: `e17ec6da9`.

Covered:

- Tab acceptance for Codex lane file mention suggestions.
- ArrowDown/Enter navigation for Auto Run document mention suggestions.
- Folder insertion from Codex lane project mention suggestions.
- Inline-at guard behavior that avoids opening mention suggestions.
- Space-terminated mention filter closure while preserving the draft.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 120 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 153.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Twenty-fifth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 125.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `62525caeb`.
- Tranche implementation commit: `57d482fb0`.

Covered:

- Save as Playbook visibility after adding Codex lane batch documents.
- Dirty-close confirmation for unsaved Codex lane batch configuration changes.
- Nested Auto Run folder selection from the Codex batch document selector.
- Duplicate nested Auto Run document creation blocking within the selected folder.
- Root Auto Run document creation when the same filename exists only in a nested folder.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 125 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 148.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Twenty-sixth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 130.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `4fd36d927`.
- Tranche implementation commit: `2b5cf5ff8`.

Covered:

- Disabled Codex batch worktree controls before worktree configuration exists.
- Create-new Codex batch worktree targeting with branch defaults.
- Open ready Codex worktree target selection from batch configuration.
- Busy Codex worktree target disabling in the batch target selector.
- Scanned closed Codex worktree target selection plus PR toggle coverage.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 130 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 143.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Twenty-seventh tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 135.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `5bb23b430`.
- Tranche implementation commit: `9b00f49a8`.

Covered:

- Base-branch changes updating Codex batch worktree branch defaults and path preview.
- Empty create-new worktree branch names showing the required-name warning.
- Toggle-off behavior clearing Codex batch worktree targeting controls.
- Already-open Codex worktrees filtered from scanned closed target options.
- Branch-load failures surfaced in create-new worktree targeting.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 135 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 138.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Twenty-eighth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 140.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `8a7885efe`.
- Tranche implementation commit: `c2df8228b`.

Covered:

- Pending create-new worktree setup showing the Preparing Worktree state.
- Create-new worktree setup payload capture before Auto Run spawn.
- Existing-open worktree dispatch routing to the child agent cwd.
- Existing-closed scanned worktree dispatch routing from the scanned cwd.
- Create-new worktree setup failure blocking provider spawn.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 140 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 133.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Twenty-ninth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 145.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `78c79f615`.
- Tranche implementation commit: `78b13d0eb`.

Covered:

- Blank Codex AI terminal sends remaining local drafts without provider spawn.
- Enter dispatching a Codex AI terminal prompt when Enter-to-send is enabled.
- Shift Enter preserving a multiline Codex AI terminal draft without provider spawn.
- Control Enter dispatch after the Codex Enter-to-send toggle is switched off.
- Read-only toggle restoration sending write-mode metadata after toggling back.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 145 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 128.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Thirtieth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 150.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: `openCodexPromptComposer` helper added in the lane spec.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `f03721117`.
- Tranche implementation commit: `089abdefc`.

Covered:

- Prompt Composer draft persistence back to the Codex lane terminal input.
- Prompt Composer Control Enter send through the Codex stubbed process path.
- Prompt Composer read-only metadata propagation through the Codex stubbed process path.
- Prompt Composer self-mention insertion without dispatch.
- Prompt Composer image attachment staging/removal without dispatch.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 150 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 123.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Thirty-first tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 155.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: `openCodexPreviewLightbox` helper added in the lane spec.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `638a1dabd`.
- Tranche implementation commit: `77903a032`.

Covered:

- Auto Run preview lightbox markdown-reference copy through the stubbed clipboard path.
- Auto Run preview lightbox Escape close behavior.
- Auto Run preview lightbox toolbar close behavior.
- Auto Run preview lightbox image-click stay-open behavior.
- Auto Run preview lightbox backdrop close behavior.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 155 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 118.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Thirty-second tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 160.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: `createPreviewLinkLaneWorkbench` now seeds a second local preview image; `openCodexPreviewLightbox` now targets the fixed overlay containing the lightbox image.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `5b05d26b6`.
- Tranche implementation commit: `28fa6e254`.

Covered:

- Auto Run preview lightbox next-toolbar carousel navigation.
- Auto Run preview lightbox previous-toolbar carousel navigation.
- Auto Run preview lightbox ArrowRight carousel navigation.
- Auto Run preview lightbox Delete-key confirmation cancel preserving the image.
- Auto Run preview lightbox toolbar delete confirmation removing the selected image and navigating to the remaining image.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 160 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 113.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Thirty-third tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 165.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: `stubImageClipboardWrite` and `getStubbedImageClipboardDataUrl` helpers added for native image clipboard IPC assertions.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `aada48fab`.
- Tranche implementation commit: `31dba1051`.

Covered:

- Auto Run preview lightbox copy-image toolbar action through stubbed shell clipboard IPC.
- Auto Run preview lightbox Control-C copy-image keyboard action through stubbed shell clipboard IPC.
- Auto Run edit-mode attached image panel collapse and re-expand behavior.
- Auto Run edit-mode attached image thumbnail opening the lightbox.
- Auto Run edit-mode attached image thumbnail removal with local image deletion.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 165 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 108.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Thirty-fourth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 170.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: `openAutoRunExpandedModal` helper added for scoped expanded-modal assertions.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `b970fdb7a`.
- Tranche implementation commit: `630ab1189`.

Covered:

- Auto Run expanded modal opening from the right-panel preview.
- Auto Run expanded modal Collapse button returning to the right panel.
- Auto Run expanded modal Escape close behavior.
- Auto Run expanded modal header Save action writing document edits.
- Auto Run expanded modal dirty-close confirmation with cancel and discard behavior.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 170 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 103.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Thirty-fifth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 175.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: `launchBusyLaneWorkbench` helper added for Codex busy-state header-control assertions.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `2161e69c6`.
- Tranche implementation commit: `6dff3936b`.

Covered:

- Auto Run expanded modal edit-mode toggle staying local to the modal after collapse.
- Auto Run expanded modal header Revert behavior for dirty edits.
- Auto Run expanded modal Run button opening batch configuration.
- Auto Run expanded modal dirty Run auto-save before configuration open.
- Auto Run expanded modal Run disablement while the Codex lane agent is busy.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 175 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 98.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Thirty-sixth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 180.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: `openAutoRunSetupDialog` and `stubSelectFolder` helpers added for setup-modal path coverage without native folder picker usage.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `33be8b0c4`.
- Tranche implementation commit: `1cb8cb0c0`.

Covered:

- Auto Run setup modal empty-path Continue disablement.
- Auto Run setup modal typed valid-folder Continue path.
- Auto Run setup modal Enter-to-continue path.
- Auto Run setup modal invalid folder validation staying open.
- Auto Run setup modal Browse folder picker stub and Continue path.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 180 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 93.
- Continue with small tranches for deeper Auto Run run-state variants, Auto Run worktree/stalled-document variants, live-provider retry execution safeguards, and remaining Codex terminal transcript edge states without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Thirty-seventh tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 185.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: `launchContextWarningLaneWorkbench` helper and tab `usageStats` seed data added for context-warning path coverage without starting compaction.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `d52eec70b`.
- Tranche implementation commit: `159edfa38`.

Covered:

- Codex AI terminal yellow context-warning rendering.
- Codex AI terminal context-warning dismissal with draft preservation.
- Codex AI terminal below-threshold hidden context-warning state.
- Codex AI terminal red context-warning compact-action visibility.
- Codex AI terminal custom warning-threshold propagation.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 185 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Non-ASCII scan found 0 non-ASCII characters in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 88.
- Continue with small tranches for remaining Codex terminal transcript edge states, live-provider retry execution safeguards, deeper Auto Run run-state variants, and Auto Run worktree/stalled-document variants without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Thirty-eighth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 190.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: `launchContextActionsLaneWorkbench` and `openCodexMainTabOverlay` helpers added for Codex AI tab context-action coverage without live provider execution.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `9e8351943`.
- Tranche implementation commit: `9841eebb8`.

Covered:

- Codex AI terminal context copy action visibility.
- Codex AI terminal compact action visibility once enough context logs exist.
- Codex AI terminal merge-modal opening from the tab context action.
- Codex AI terminal send-to-agent modal opening from the tab context action.
- Codex AI terminal copied-context transcript formatting and toast feedback.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 190 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Non-ASCII scan found 0 non-ASCII characters in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 83.
- Continue with small tranches for remaining Codex terminal transcript edge states, live-provider retry execution safeguards, deeper Auto Run run-state variants, and Auto Run worktree/stalled-document variants without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Thirty-ninth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 195.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: `openQuickActions` helper added for Codex AI context command-palette coverage without live provider execution.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `387e06155`.
- Tranche implementation commit: `f404f9dc2`.

Covered:

- Codex AI terminal Quick Actions context merge/send visibility below the compact threshold.
- Codex AI terminal Quick Actions compact command visibility once enough context logs exist.
- Codex AI terminal Quick Actions send-to-agent filtering.
- Codex AI terminal merge-modal opening from Quick Actions.
- Codex AI terminal send-to-agent modal opening from Quick Actions.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 195 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Non-ASCII scan found 0 non-ASCII characters in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 78.
- Continue with small tranches for remaining Codex terminal transcript edge states, live-provider retry execution safeguards, deeper Auto Run run-state variants, and Auto Run worktree/stalled-document variants without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Fortieth tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 200.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: `openCodexMergeModal` and `openCodexSendToAgentModal` helpers added for modal-control coverage without merge/send execution.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `653532cae`.
- Tranche implementation commit: `33022e1d1`.
- Accepted orchestrator commit: `be6f56584`.

Covered:

- Codex AI terminal merge modal invalid pasted target validation.
- Codex AI terminal merge modal empty target search state.
- Codex AI terminal merge modal cancel behavior.
- Codex AI terminal send-to-agent modal empty target search state.
- Codex AI terminal send-to-agent preview target selection and clean-context toggle.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 200 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Non-ASCII scan found 0 non-ASCII characters in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 73.
- Continue with small tranches for remaining Codex terminal transcript edge states, live-provider retry execution safeguards, deeper Auto Run run-state variants, and Auto Run worktree/stalled-document variants without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.

Forty-first tranche:

- Added 5 active matrix-backed tests to `e2e/autorun-ai-terminal.spec.ts`.
- New active tests: 5.
- Cumulative active tests: 205.
- Skipped tests: 0.
- Env-gated tests: 0.
- Shared helper edits: none; reused context merge/send modal helpers.
- Live provider execution: none; no E2E validation/listing was run.
- Campaign head before this tranche: `3caf1908e`.
- Tranche implementation commit: `4e745a031`.
- Orchestrator import commit: `cd178a73f`.

Covered:

- Codex AI terminal valid pasted merge target preview.
- Codex AI terminal Open Tabs merge target selection.
- Codex AI terminal merge clean-context preview toggle.
- Codex AI terminal send-to-agent number-key target selection.
- Codex AI terminal send-to-agent cancel behavior.

Validation:

- `npx prettier --check e2e/autorun-ai-terminal.spec.ts` passed.
- `npx eslint e2e/autorun-ai-terminal.spec.ts` passed.
- Targeted TypeScript parse/check for `e2e/autorun-ai-terminal.spec.ts` passed with `--esModuleInterop`.
- `git diff --check` passed.
- Marker scan found 205 active declarations and no `.only`/skip declarations in `e2e/autorun-ai-terminal.spec.ts`.
- Non-ASCII scan found 0 non-ASCII characters in `e2e/autorun-ai-terminal.spec.ts`.
- Code-reviewer pass found no blocking/high issues.

Remaining work:

- Matrix-backed remaining after this tranche: 68.
- Continue with small tranches for remaining Codex terminal transcript edge states, live-provider retry execution safeguards, deeper Auto Run run-state variants, and Auto Run worktree/stalled-document variants without duplicating existing app-shell coverage.
- Run actual Playwright/E2E validation only after orchestrator approval.
