# autorun-ai-terminal

Status: second tranche authored

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
- Campaign head before this tranche: `ca4241a13`.
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
