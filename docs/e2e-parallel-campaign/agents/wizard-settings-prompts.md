# wizard-settings-prompts

Status: tranche 34 fallback committed

## Scope

New Agent Wizard, inline wizard, Settings, Director Notes, prompt composer.

## Checklist

- [x] Inspect existing related E2E coverage and component surfaces.
- [x] Author deterministic active scenarios up to the lane target where feasible.
- [x] Add static or skipped/env-gated cases for unavailable provider/account flows.
- [x] Record files touched and scenario counts.
- [x] Commit lane work on `codex/e2e-wizard-settings-prompts`.

## Progress

### 2026-06-08 tranche 1

- Scope: first coherent tranche only.
- Authored: 5 active deterministic Playwright scenarios.
  - New Agent Wizard launch and Escape close.
  - Seeded inline wizard render controls.
  - Settings custom AI command persistence.
  - Director's Notes Quick Actions entry with Encore flag enabled.
  - Prompt Composer seeded `@Reviewer` mention insertion without sending.
- Skipped/env-gated: 1 real-provider account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
- Shared helpers edited: no.
- Validation run:
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md` - passed.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining lane work should continue in small tranches rather than expanding this spec into the existing large app-shell matrix.

### 2026-06-08 tranche 2

- Scope: next coherent tranche only.
- Authored: 7 additional active deterministic Playwright scenarios.
  - Inline wizard draft text persists through Prompt Composer open/close.
  - Inline wizard exit confirmation can be canceled without leaving wizard mode.
  - Inline wizard exits only after explicit confirmation.
  - New Agent Wizard header close button hides the modal.
  - Seeded custom AI command settings render without recreating the command.
  - Prompt Composer Escape dismisses `@Reviewer` mention suggestions before closing.
  - Prompt Composer keeps Send disabled for empty and whitespace-only drafts.
- Cumulative lane-authored coverage: 12 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
- Shared helpers edited: no.
- Validation run:
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md` - passed.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `de3ac637a`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 360 active/skipped rows after this tranche.

### 2026-06-08 tranche 3

- Scope: third compact recovery tranche only.
- Authored: 6 additional active deterministic Playwright scenarios.
  - Seeded inline wizard confidence gauge renders the expected 37% state.
  - Prompt Composer character count updates as a deterministic draft is typed.
  - Prompt Composer header close persists the draft for reopen.
  - Settings Shortcuts filter narrows to the Prompt Composer shortcut.
  - Director's Notes quick action stays hidden when the Encore feature is disabled.
  - Settings Encore tab enables Director's Notes controls and persists the feature flag.
- Cumulative lane-authored coverage: 18 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
- Shared helpers edited: no.
- Validation run:
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md` - passed.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `e0b608ca8`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 354 active/skipped rows after this tranche.

### 2026-06-08 tranche 4

- Scope: fourth compact recovery tranche only.
- Authored: 6 additional active deterministic Playwright scenarios.
  - New Agent Wizard marks coming-soon providers disabled.
  - Settings Themes tab persists the Solarized theme picker selection.
  - Settings Display tab persists the Large font size selection.
  - Prompt Composer toolbar toggles History state onto the active tab.
  - Prompt Composer toolbar toggles Read-Only state onto the active tab.
  - Director's Notes exposes Help and Unified History while AI Overview remains disabled until synopsis state is ready.
- Cumulative lane-authored coverage: 24 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
- Shared helpers edited: no.
- Validation run:
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md` - passed.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `989097c21`.
- Review fix commit hash: `31d9335e3` tightened the Themes tab readiness assertion text.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 348 active/skipped rows after this tranche.

### 2026-06-08 tranche 5 fallback

- Scope: compact fallback tranche after the tranche-7 PM2 retry failed before authoring.
- PM2 context:
  - `maestro-e2e-wizard-settings-prompts-t7`, `maestro-e2e-git-groupchat-playbooks-t7`, and `maestro-e2e-stats-graph-symphony-t7` were launched as one-shot workers with `--no-autorestart`.
  - All three exited before edits with Codex managed-account 503 errors from model refresh and `/responses`.
- Authored: 5 additional active deterministic Playwright scenarios.
  - Settings General persists the default History toggle.
  - Settings General persists the automatic tab naming toggle.
  - Settings Display persists the Files Pane Icon Theme selection.
  - Settings Display persists the auto-hide menu bar toggle.
  - Prompt Composer toggles Enter-to-send mode from inside the composer modal.
- Cumulative lane-authored coverage: 29 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc --noEmit --target ES2020 --lib ES2020,DOM,DOM.Iterable --module ESNext --skipLibCheck --moduleResolution bundler --allowImportingTsExtensions --resolveJsonModule --isolatedModules --strict --noUnusedLocals --noUnusedParameters --noFallthroughCasesInSwitch --types node,@playwright/test e2e/wizard-settings-prompts.spec.ts e2e/fixtures/electron-app.ts` - passed.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
  - Static wizard spec ID/`.only` scan - passed with 29 active rows, 1 env-gated row, no duplicate IDs, and no `.only`.
- Review:
  - Focused code review passed after scoping the Prompt Composer Enter-to-send locator to the modal container.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `4e246ffc0`.
- Blockers/remaining work:
  - PM2-managed Codex worker runtime is still blocked by 503 managed-account availability errors.
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 343 active/skipped rows after this tranche.

### 2026-06-08 tranche 6 fallback

- Scope: compact manual fallback tranche in isolated worktree `Maestro-worktrees/e2e-wizard-settings-prompts-fallback-2`.
- Authored: 5 additional active deterministic Playwright scenarios.
  - Settings General persists the Conductor Profile draft and character counter.
  - Settings General persists the System Log Level selection.
  - Settings General persists the GitHub CLI custom path.
  - Settings Display persists the Terminal Width selection.
  - Settings Display persists the Document Graph external-link default toggle.
- Cumulative lane-authored coverage: 34 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
- Shared helpers edited: no.
- Validation run:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --check e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit` - passed after regenerating the local ignored `src/generated/prompts.ts` artifact in the isolated worktree.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
  - Static scenario-ID/`.only` scan - passed with no duplicate IDs and no `.only`.
- Review:
  - Manual code review found no blocking issues after fixing the Conductor Profile placeholder regex and counter expectation before validation.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `f8c3f107d`.
- Blockers/remaining work:
  - PM2-managed Codex worker runtime is still blocked by 503 managed-account availability errors.
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 338 active/skipped rows after this tranche.

### 2026-06-08 tranche 7 fallback

- Scope: compact manual fallback tranche in isolated worktree `Maestro-worktrees/e2e-wizard-settings-prompts-fallback-3`.
- Authored: 5 additional active deterministic Playwright scenarios.
  - Settings General persists the custom shell path from Shell Configuration.
  - Settings General toggles stats collection from Usage & Stats.
  - Settings General persists the default Usage Dashboard time range.
  - Settings Display persists Bionify reading mode and intensity.
  - Settings Display validates and persists the Bionify algorithm.
- Cumulative lane-authored coverage: 39 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
- Shared helpers edited: no.
- Validation run:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --check e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit` - passed.
  - Static scenario-ID/`.only` scan - passed with 39 active rows, 1 env-gated row, no duplicate IDs, and no `.only`.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md` - passed.
- Review:
  - Manual focused diff review found no blocking issues in selector scope, matrix indexes, persistence assertions, or doc arithmetic.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `16e9f11cd`.
- Blockers/remaining work:
  - PM2-managed Codex worker runtime is still blocked by 503 managed-account availability errors.
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 333 active/skipped rows after this tranche.

### 2026-06-08 tranche 8 fallback

- Scope: compact manual fallback tranche in isolated worktree `Maestro-worktrees/e2e-wizard-settings-prompts-fallback-4`.
- Authored: 5 additional active deterministic Playwright scenarios.
  - Settings General persists the default Thinking Mode selection.
  - Settings General toggles AI output auto-scroll.
  - Settings General toggles spell check.
  - Settings General toggles sleep prevention.
  - Settings General toggles GPU acceleration.
- Cumulative lane-authored coverage: 44 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
- Shared helpers edited: no.
- Validation run:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --check e2e/wizard-settings-prompts.spec.ts docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit` - passed.
  - Static scenario-ID/`.only` scan - passed with 44 active rows, 1 env-gated row, no duplicate IDs, and no `.only`.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md` - passed.
- Review:
  - Focused code review found no blocking issues in selector scope, matrix indexes, persistence assertions, or doc arithmetic.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `1741d2b74`.
- Blockers/remaining work:
  - PM2-managed Codex worker runtime is still blocked by 503 managed-account availability errors.
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 328 active/skipped rows after this tranche.

### 2026-06-08 tranche 9 fallback

- Scope: compact manual fallback tranche in isolated worktree `Maestro-worktrees/e2e-wizard-settings-prompts-fallback-5`.
- Authored: 5 additional active deterministic Playwright scenarios.
  - Settings General persists Shell Arguments.
  - Settings General toggles Terminal Mode Enter-to-send behavior.
  - Settings Notifications toggles OS notifications.
  - Settings Notifications persists custom notification enabled/command state.
  - Settings Notifications persists toast notification duration.
- Cumulative lane-authored coverage: 49 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
- Shared helpers edited: no.
- Validation run:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --check e2e/wizard-settings-prompts.spec.ts docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit` - passed.
  - Static scenario-ID/`.only` scan - passed with 49 active rows, 1 env-gated row, no duplicate IDs, and no `.only`.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md` - passed.
- Review:
  - Focused static review found one high-risk collapsed Shell Configuration selector; fixed before commit.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `26159c767`.
- Blockers/remaining work:
  - PM2-managed Codex worker runtime is still blocked by 503 managed-account availability errors.
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 323 active/skipped rows after this tranche.

### 2026-06-08 tranche 10 fallback

- Scope: compact manual fallback tranche in isolated worktree `Maestro-worktrees/e2e-wizard-settings-prompts-fallback-6`.
- Authored: 5 additional active deterministic Playwright scenarios.
  - Settings Display adds a local file indexing ignore pattern.
  - Settings Display removes a local file indexing ignore pattern.
  - Settings Display toggles local file indexing `.gitignore` honor.
  - Settings Display toggles context window warnings.
  - Settings Display adjusts context warning thresholds and preserves threshold validation.
- Cumulative lane-authored coverage: 54 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
- Shared helpers edited: no.
- Validation run:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --check e2e/wizard-settings-prompts.spec.ts docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit` - passed.
  - Static scenario-ID/`.only` scan - passed with 54 active rows, 1 env-gated row, no duplicate IDs, and no `.only`.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md` - passed.
- Review:
  - Focused static review found two high-risk unscoped selectors; fixed the Local Ignore Patterns Add button scope and yellow threshold slider scope before commit.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `ae036d16a`.
- Blockers/remaining work:
  - PM2-managed Codex worker runtime is still blocked by 503 managed-account availability errors.
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 318 active/skipped rows after this tranche.

### 2026-06-08 tranche 11 fallback

- Scope: compact manual fallback tranche in isolated worktree `Maestro-worktrees/e2e-wizard-settings-prompts-fallback-7`.
- Authored: 5 additional active deterministic Playwright scenarios.
  - Settings Display persists max output lines.
  - Settings Display persists user message alignment.
  - Settings Display toggles native title bar preference.
  - Settings General toggles confetti animation preference.
  - Settings General toggles update checks on startup.
- Cumulative lane-authored coverage: 59 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
- Shared helpers edited: no.
- Validation run:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --check e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npm run build:prompts` - passed and generated missing local prompt artifacts for this worktree.
  - `npx tsc -p tsconfig.lint.json --noEmit` - passed after prompt generation.
  - Static scenario-ID/`.only`/prohibited-command scan - passed with 59 active rows, 59 active tests, 1 env-gated row, no duplicate IDs, and no `.only`.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused static code-reviewer checklist found no critical or high-severity issues; E2E execution remains deferred.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `bb407abd4`.
- Blockers/remaining work:
  - PM2-managed Codex worker runtime is still blocked by 503 managed-account availability errors.
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 313 active/skipped rows after this tranche.

### 2026-06-08 tranche 12 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 6 additional active deterministic Playwright scenarios.
  - Settings AI Commands cancels a new custom command draft without persisting it.
  - Settings AI Commands edits a seeded custom command description and prompt.
  - Settings General persists a global environment variable.
  - Settings Group Chat persists moderator standing instructions.
  - Prompt Composer trims pasted plain text.
  - Prompt Composer keeps unmatched `@` text literal without selecting a mention.
- Cumulative lane-authored coverage: 65 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `NODE_OPTIONS=--max-old-space-size=8192 npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npm run build:prompts` - passed and generated missing local prompt artifacts for this worktree.
  - `NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.lint.json --noEmit` - passed after prompt generation.
  - Static scenario-ID/`.only`/prohibited-command scan - passed with 65 active rows, 65 active tests, 1 env-gated row, no duplicate IDs, and no `.only`.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused static code-reviewer checklist found no critical or high-severity issues; E2E execution remains deferred.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `b6d172c41`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 307 active/skipped rows after this tranche.

### 2026-06-08 tranche 13 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 6 additional active deterministic Playwright scenarios.
  - Settings AI Commands blocks duplicate custom command creation.
  - Settings AI Commands deletes a seeded custom command.
  - Settings General rejects invalid global environment variable names.
  - Settings General removes a global environment variable.
  - Director's Notes adjusts the default lookback period.
  - Prompt Composer opens from the keyboard shortcut.
- Cumulative lane-authored coverage: 71 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `NODE_OPTIONS=--max-old-space-size=8192 npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.lint.json --noEmit` - passed.
  - Static scenario-ID/`.only`/prohibited-command scan - passed with 71 active rows, 71 active tests, 1 env-gated row, no duplicate IDs, and no `.only`.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused static code-reviewer checklist found one weak invalid-env assertion and tightened it before commit; no critical or high-severity issues remain.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `02b18b88c`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 301 active/skipped rows after this tranche.

### 2026-06-08 tranche 14 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 6 additional active deterministic Playwright scenarios.
  - Settings AI Commands prefixes a custom command created without a slash.
  - Settings SSH Hosts adds a remote ignore pattern.
  - Settings SSH Hosts removes a remote ignore pattern.
  - Settings SSH Hosts toggles remote `.gitignore` honoring.
  - Prompt Composer uploads a staged image and opens the image lightbox.
  - Prompt Composer removes a staged image before sending.
- Cumulative lane-authored coverage: 77 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `NODE_OPTIONS=--max-old-space-size=8192 npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.lint.json --noEmit` - passed.
  - Static scenario-ID/`.only`/prohibited-command scan - passed with 77 active rows, 77 active tests, 1 env-gated row, no duplicate IDs, and no `.only`.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused static code-reviewer checklist found no critical or high-severity issues; E2E execution remains deferred.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `165edccbe`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 295 active/skipped rows after this tranche.

### 2026-06-08 tranche 15 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 6 additional active deterministic Playwright scenarios.
  - Settings AI Commands cancels a seeded command edit without persisting changes.
  - Settings SSH Hosts shows duplicate remote ignore pattern feedback.
  - Settings SSH Hosts resets remote ignore patterns and `.gitignore` honoring to defaults.
  - Prompt Composer inserts a literal tab character with Tab.
  - Prompt Composer toggles History with the keyboard shortcut.
  - Prompt Composer toggles Read-Only with the keyboard shortcut.
- Cumulative lane-authored coverage: 83 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `NODE_OPTIONS=--max-old-space-size=8192 npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `NODE_OPTIONS=--max-old-space-size=8192 npx tsc -p tsconfig.lint.json --noEmit` - passed.
  - Static scenario-ID/`.only`/prohibited-command scan - passed with 83 active rows, 83 active tests, 1 env-gated row, no duplicate IDs, and no `.only`.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused static code-reviewer checklist found no critical or high-severity issues; E2E execution remains deferred.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `2d069a57a`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 289 active/skipped rows after this tranche.

### 2026-06-08 tranche 16 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 7 additional active deterministic Playwright scenarios.
  - Prompt Composer inserts a newline with Shift+Enter.
  - Prompt Composer opens a staged image lightbox with the keyboard shortcut.
  - Prompt Composer closes the image lightbox without closing the composer.
  - Prompt Composer cycles Thinking mode from the toolbar.
  - Settings Display persists the maximum log buffer selection.
  - Settings General toggles the beta update channel.
  - Settings General toggles crash reporting.
- Cumulative lane-authored coverage: 90 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --check e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID scan - passed with 90 active rows, 90 active tests, 1 env-gated row, no duplicate IDs, and no `.only`.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,156 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified Codex Thinking display support, selector scope, matrix indexes, and persistence assertions; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `60e1bd03f`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 282 active/skipped rows after this tranche.

### 2026-06-08 tranche 17 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 7 additional active deterministic Playwright scenarios.
  - Settings Shortcuts records a general shortcut override.
  - Settings Shortcuts cancels shortcut recording with Escape.
  - Settings Shortcuts records an AI tab shortcut override.
  - Settings Display adds a custom interface font.
  - Settings Display removes a custom interface font.
  - Settings Display selects a custom interface font.
  - Settings Display prevents duplicate custom interface fonts.
- Cumulative lane-authored coverage: 97 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --check e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID scan - passed with 97 active rows, 97 active tests, 1 env-gated row, no duplicate IDs, and no `.only`.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,163 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified shortcut IDs, shortcut-recording assertions, Display font selector scope, and persistence assertions; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `e0b5387c3`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 275 active/skipped rows after this tranche.

### 2026-06-08 tranche 18 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 7 additional active deterministic Playwright scenarios.
  - Settings Themes selects the custom theme card.
  - Settings Themes initializes the custom theme from Solarized.
  - Settings Themes resets the custom theme to Dracula defaults.
  - Settings Themes edits the custom theme main background color.
  - Settings Themes advances the theme picker with Tab.
  - Settings Themes wraps the theme picker backward to Custom with Shift+Tab.
  - Settings Themes selects the GitHub light theme.
- Cumulative lane-authored coverage: 104 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx prettier --check e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID scan - passed with 104 active rows, 104 active tests, 1 env-gated row, no duplicate IDs, and no `.only`.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,170 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified exact Solarized selector scope, theme order assumptions, custom color row scope, and persistence assertions; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `0856649b3`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 268 active/skipped rows after this tranche.

### 2026-06-08 tranche 19 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 7 additional active deterministic Playwright scenarios.
  - Director's Notes lists Codex as the synopsis provider.
  - Director's Notes persists custom provider path, arguments, and environment variables.
  - Director's Notes clears custom provider overrides.
  - Director's Notes persists a Codex model override.
  - Director's Notes persists a Codex context window override.
  - Director's Notes shows the available model count.
  - Director's Notes shows built-in environment variables.
- Cumulative lane-authored coverage: 111 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx prettier --check e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID scan - passed with 111 active rows, 111 active tests, 1 env-gated row, no duplicate IDs, and no `.only`.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,177 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified IPC-stubbed provider detection/config storage, Director's Notes settings persistence, selector scope, duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `a19a2bec9`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 261 active/skipped rows after this tranche.

### 2026-06-08 tranche 20 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 7 additional active deterministic Playwright scenarios.
  - New Agent Wizard keeps Continue disabled by default.
  - New Agent Wizard preserves a typed agent name.
  - New Agent Wizard selects Codex from the provider grid.
  - New Agent Wizard enables Continue after a name and provider are selected.
  - New Agent Wizard selects Codex with Enter.
  - New Agent Wizard marks Gemini CLI as a disabled coming-soon provider.
  - New Agent Wizard opens Codex provider customization.
- Cumulative lane-authored coverage: 118 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx prettier --check e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID scan - passed with 118 active rows, 118 active tests, 1 env-gated row, no duplicate IDs, and no `.only`.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,184 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified provider-detection stubbing, wizard form state, Codex click/keyboard selection, no creation click, no duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `543791dd7`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 254 active/skipped rows after this tranche.

### 2026-06-08 tranche 21 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 7 additional active deterministic Playwright scenarios.
  - New Agent Wizard edits the Codex custom path.
  - New Agent Wizard resets the Codex custom path.
  - New Agent Wizard edits Codex custom arguments.
  - New Agent Wizard clears Codex custom arguments.
  - New Agent Wizard adds a Codex environment variable.
  - New Agent Wizard removes a Codex environment variable.
  - New Agent Wizard edits Codex model and context settings.
- Cumulative lane-authored coverage: 125 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx prettier --check e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID scan - passed with 125 active rows, 125 active tests, 1 env-gated row, no duplicate IDs, and no `.only`.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,191 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified customization-panel scoping, path/args/env/model/context field assertions, no Continue/Create clicks, no duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `137f4cad8`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 247 active/skipped rows after this tranche.

### 2026-06-08 tranche 22 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 7 additional active deterministic Playwright scenarios.
  - New Agent Wizard advances to directory selection.
  - New Agent Wizard returns from directory selection with agent state preserved.
  - New Agent Wizard shows project directory controls.
  - New Agent Wizard reports a missing project directory.
  - New Agent Wizard accepts a regular project directory.
  - New Agent Wizard enables directory-step Continue for a valid directory.
  - New Agent Wizard clears project directory validation state.
- Cumulative lane-authored coverage: 132 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx prettier --check e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID scan - passed with 132 active rows, 132 active tests, 1 env-gated row, no duplicate IDs, and no `.only`.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,198 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified directory-step navigation, deterministic temp-directory validation, no Browse/native picker clicks, no Create Agent clicks, no duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `b86eac70d`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 240 active/skipped rows after this tranche.

### 2026-06-08 tranche 23 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 7 additional active deterministic Playwright scenarios.
  - New Agent Wizard surfaces existing Auto Run document choices.
  - Existing Auto Run document continuation is marked recommended without entering generation.
  - Existing Auto Run document reuse cancellation clears the directory step.
  - Delete-and-start-fresh is offered as a secondary existing-docs path without entering generation.
  - Enter opens existing document choices from the directory step.
  - Escape dismisses existing document choices and clears the directory step.
  - Directory validation works again after cancelling existing document reuse.
- Cumulative lane-authored coverage: 139 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID scan - passed with 139 active rows, 139 active tests, 1 env-gated row, no duplicate IDs, and no `.only`.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,205 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified existing-docs modal selectors, deterministic seeded Auto Run documents, no generation-phase assertions, no duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `a811d770c`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 233 active/skipped rows after this tranche.

### 2026-06-08 tranche 24 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 7 additional active deterministic Playwright scenarios.
  - Settings shows stats database controls and clear-period UI.
  - Settings clears stats older than a selected period through local isolated stats storage.
  - WakaTime detail controls remain hidden while tracking is disabled.
  - WakaTime API key entry remains hidden while tracking is disabled.
  - WakaTime local-storage privacy copy is visible without enabling the integration.
  - Settings storage location default controls are visible.
  - Settings storage file-manager action is visible without clicking the native shell action.
- Cumulative lane-authored coverage: 146 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID scan - passed with 146 active rows, 146 active tests, 1 env-gated row, no duplicate IDs, and no `.only`.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,212 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist found and removed an unsafe WakaTime-enable path that could trigger CLI auto-install behavior. The final tranche verifies disabled-state UI, local stats controls, storage controls, no duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues remain.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `63d4253d1`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 226 active/skipped rows after this tranche.

### 2026-06-08 tranche 25 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 7 additional active deterministic Playwright scenarios.
  - Settings custom theme import/export/reset controls are visible.
  - Valid custom theme JSON imports color values.
  - Invalid custom theme color values are rejected without changing saved colors.
  - Custom theme files without a `colors` object are rejected without changing saved colors.
  - Custom theme files missing required color keys are rejected without changing saved colors.
  - Invalid custom theme JSON is rejected without changing saved colors.
  - Valid custom theme JSON imports the base theme id.
- Cumulative lane-authored coverage: 153 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID scan - passed with 153 active rows, 153 active tests, 1 env-gated row, no duplicate IDs, and no `.only`.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,219 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified local JSON fixtures, hidden file-input use, invalid import unchanged-state assertions, no native file dialog clicks, no duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `19cfa2bc4`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 219 active/skipped rows after this tranche.

### 2026-06-09 tranche 26 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 6 additional active deterministic Playwright scenarios.
  - Settings storage location custom folder selection uses stubbed sync IPC and reports migrated settings.
  - Custom storage location reset returns to the default path and reports migrated settings.
  - Cancelled storage folder selection leaves storage settings unchanged.
  - Storage migration failures surface sync errors without restart messaging.
  - Storage reset failures preserve the current custom path and surface sync errors.
  - Storage file-manager action routes through stubbed shell IPC for the custom path.
- Cumulative lane-authored coverage: 159 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID/prohibited-command scan - passed with 159 active rows, 159 active tests, 1 env-gated row, no duplicate IDs, no `.only`, and no prohibited E2E commands.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,225 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified lane-local sync/shell IPC stubs, no native folder picker dependency, deterministic storage success/error assertions, no duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `d95061286`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 213 active/skipped rows after this tranche.

### 2026-06-09 tranche 27 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 6 additional active deterministic Playwright scenarios.
  - Display Document Graph maximum-node slider persists a new value.
  - Display Document Graph maximum-node slider clamps to the supported range.
  - Context warning threshold controls are visibly ghosted while warnings are disabled.
  - Seeded context warning threshold percentages render in Settings.
  - Red-threshold edits lower the yellow threshold when crossing the yellow value.
  - Context warning toggle works from keyboard Enter without pointer interaction.
- Cumulative lane-authored coverage: 165 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID/prohibited-command scan - passed with 165 active rows, 165 active tests, 1 env-gated row, no duplicate IDs, no `.only`, and no prohibited E2E commands.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,231 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified existing slider-event patterns, deterministic Settings state assertions, no native or provider dependencies, no duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `231f0ac57`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 207 active/skipped rows after this tranche.

### 2026-06-09 tranche 28 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 6 additional active deterministic Playwright scenarios.
  - Local file-indexing ignore patterns block duplicates with visible feedback.
  - Local ignore patterns reset to defaults and restore `.gitignore` honoring.
  - Blank local ignore pattern input keeps Add disabled.
  - Enter adds a local ignore pattern without using the Add button.
  - Bionify algorithm reference modal opens from the info control.
  - Bionify algorithm reference modal closes with Escape while Settings remains open.
- Cumulative lane-authored coverage: 171 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID/prohibited-command scan - passed with 171 active rows, 171 active tests, 1 env-gated row, no duplicate IDs, no `.only`, and no prohibited E2E commands.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,237 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified seeded local-ignore state, default reset assertions, Bionify modal selectors, no native or provider dependencies, no duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `e00bedb52`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 201 active/skipped rows after this tranche.

### 2026-06-09 tranche 29 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 6 additional active deterministic Playwright scenarios.
  - Settings default Usage Dashboard time range persists through the General Usage & Stats select.
  - GitHub CLI custom path Clear resets the saved path.
  - Shell arguments Clear resets saved global shell args.
  - Stats clearing failures surface the returned error and record the selected period.
  - Stats database metadata renders stubbed size and earliest-date copy.
  - Global environment variable explanatory copy renders in Shell Configuration.
- Cumulative lane-authored coverage: 177 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID/prohibited-command scan - passed with 177 active rows, 177 active tests, 1 env-gated row, no duplicate IDs, no `.only`, and no prohibited E2E commands.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,243 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist found and corrected one hidden-tooltip assertion. Final review verified lane-local stats IPC stubs, deterministic General settings assertions, no native or provider dependencies, no duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues remain.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `68d14d205`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 195 active/skipped rows after this tranche.

### 2026-06-09 tranche 30 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 7 additional active deterministic Playwright scenarios.
  - Settings custom shell path persists through Shell Configuration.
  - Settings custom shell path Clear resets the saved path.
  - Stats collection toggle persists off.
  - Successful stats clearing reports aggregate query/session/task totals and records the selected period.
  - Global environment variable editor adds a valid variable.
  - Global environment variable editor removes a seeded variable.
  - Global environment variable editor rejects invalid variable names without saving them.
- Cumulative lane-authored coverage: 184 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID/prohibited-command scan - passed with 184 active rows, 184 active tests, 1 env-gated row, no duplicate IDs, no `.only`, and no prohibited E2E commands.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,250 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified Settings custom shell path selectors, stats IPC stubs, global env editor assertions, deterministic persisted setting checks, no native or provider dependencies, no duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `bbb1dfe7c`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 188 active/skipped rows after this tranche.

### 2026-06-09 tranche 31 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 7 additional active deterministic Playwright scenarios.
  - Operating system notification toggle persists off.
  - Test Notification routes through stubbed notification IPC.
  - Custom notification command persists through the command-chain input.
  - Custom notification test command shows running and success states from stubbed completion events.
  - Running custom notification command Stop calls stubbed stop IPC.
  - Failed custom notification command surfaces returned error text.
  - Toast notification duration persists the Never option.
- Cumulative lane-authored coverage: 191 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID/prohibited-command scan - passed with 191 active rows, 191 active tests, 1 env-gated row, no duplicate IDs, no `.only`, and no prohibited E2E commands.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,257 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified notification IPC stubs, command-completion event simulation, persisted notification settings, deterministic selectors, no native/provider dependencies, no duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `b33360730`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 181 active/skipped rows after this tranche.

### 2026-06-09 tranche 32 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 10 additional active deterministic Playwright scenarios.
  - SSH remote empty state renders in Settings.
  - SSH remote add modal opens from Settings.
  - SSH remote required-field and port validation keeps Save disabled until valid.
  - SSH remote save persists host, port, username, private key path, and environment variables.
  - SSH config import fills display name, host, port, username, and private key path.
  - SSH config import origin can be cleared while keeping imported host data.
  - SSH remote default host can be set and unset.
  - Successful SSH remote connection tests surface the remote hostname.
  - Disabled SSH remotes show disabled state and block connection tests.
  - SSH remote deletion returns the list to the empty state.
- Cumulative lane-authored coverage: 201 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID/prohibited-command scan - passed with 201 active rows, 201 active tests, 1 env-gated row, no duplicate IDs, no `.only`, and no prohibited E2E commands.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,267 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist found and corrected the SSH config import dropdown selector before commit. Final review verified SSH IPC stubs, save/import/default/test/delete assertions, deterministic selectors, no native/provider dependencies, no duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues remain.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `7c17dc3dc`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Settings matrix-backed target is complete at 190 active Settings scenarios.
  - Remaining matrix-backed target: about 171 active/skipped rows after this tranche.

### 2026-06-09 tranche 33 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 7 additional active deterministic Playwright scenarios.
  - New Agent Wizard remote location selector shows Local Machine and configured SSH remotes.
  - Remote selection carries into the directory step with remote placeholder, hint copy, and Browse hidden.
  - Remote project directory validation calls filesystem and Git IPC with the selected SSH remote id.
  - Existing remote Auto Run documents surface the existing-docs modal through remote `autorun:listDocs`.
  - Missing remote directories surface the deterministic directory-not-found error.
  - Switching back to Local Machine restores local directory placeholder and Browse controls.
  - Returning from the directory step preserves remote selection, agent name, and selected Codex provider.
- Cumulative lane-authored coverage: 208 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID/prohibited-command scan - passed with 208 active rows, 208 active tests, 1 env-gated row, no duplicate IDs, no `.only`, and no prohibited E2E commands.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,274 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified the lane-local remote directory IPC stub, Agent location selectors, remote placeholder/hint assertions, captured SSH remote ids for filesystem/Git/Auto Run calls, no native/provider dependencies, no duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `818d1a1b2`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Settings matrix-backed target remains complete at 190 active Settings scenarios.
  - Remaining matrix-backed target: about 164 active/skipped rows after this tranche.

### 2026-06-09 tranche 34 fallback

- Scope: compact persistent-worker tranche in the current lane worktree.
- Authored: 8 additional active deterministic Playwright scenarios.
  - Local Browse selects a New Agent Wizard project directory through stubbed `dialog:selectFolder`.
  - Browse cancellation leaves the Project Directory empty and keeps Continue hidden.
  - Browse failures surface the deterministic folder-picker error.
  - Local typed directory validation calls filesystem and Git IPC without an SSH remote id.
  - Existing Auto Run document counts render plural copy for multiple documents.
  - Delete & Start Fresh reports returned delete errors and records the selected directory.
  - Continue Building on Existing Plan advances into Project Discovery without deleting documents.
  - Delete & Start Fresh advances into Project Discovery after successful deletion.
- Cumulative lane-authored coverage: 216 active deterministic scenarios, 1 env-gated scenario.
- Skipped/env-gated: no new rows; total remains 1 provider-account handoff placeholder.
- Files touched:
  - `e2e/wizard-settings-prompts.spec.ts`
  - `docs/e2e-parallel-campaign/agents/wizard-settings-prompts.md`
  - `docs/e2e-parallel-campaign/coverage-ledger.md`
  - `docs/e2e-coverage-campaign.md`
- Shared helpers edited: no.
- Validation run:
  - `npx prettier --write e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx eslint e2e/wizard-settings-prompts.spec.ts` - passed.
  - `npx tsc -p tsconfig.lint.json --noEmit --pretty false` - passed.
  - Static scenario-ID/`.only`/duplicate-ID/prohibited-command scan - passed with 216 active rows, 216 active tests, 1 env-gated row, no duplicate IDs, no `.only`, and no prohibited E2E commands.
  - Static E2E declaration inventory scan - passed with 15 spec files, 1,282 declared `test`/`test.skip` rows, and 6 skipped declarations.
  - `git diff --check -- e2e/wizard-settings-prompts.spec.ts` - passed.
- Review:
  - Focused code-reviewer checklist verified WSP-209 through WSP-216, helper-stub IPC contracts, selector determinism, no native/provider dependencies, no duplicate IDs, and absence of prohibited E2E commands; no critical or high-severity issues found.
- Not run by instruction: `npm run test:e2e`, `playwright test`, headed/UI E2E, and Playwright listing.
- Implementation commit hash: `48f906bef`.
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Settings matrix-backed target remains complete at 190 active Settings scenarios.
  - Remaining matrix-backed target: about 156 active/skipped rows after this tranche.
