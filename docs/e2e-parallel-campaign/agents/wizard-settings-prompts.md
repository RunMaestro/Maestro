# wizard-settings-prompts

Status: tranche 12 fallback committed

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
