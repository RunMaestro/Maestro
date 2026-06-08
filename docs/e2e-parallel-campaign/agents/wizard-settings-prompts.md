# wizard-settings-prompts

Status: tranche 4 committed locally

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
- Blockers/remaining work:
  - Real provider account and live agent handoff coverage remains env-gated.
  - Remaining matrix-backed target: about 348 active/skipped rows after this tranche.
