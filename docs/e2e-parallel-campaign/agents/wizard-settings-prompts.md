# wizard-settings-prompts

Status: tranche 1 committed locally

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
