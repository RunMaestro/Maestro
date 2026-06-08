# autorun-ai-terminal

Status: first tranche authored

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
