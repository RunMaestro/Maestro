# Parallel E2E Broadcasts

## 2026-06-08 Orchestrator Start

- Do not run E2E tests in any lane.
- Avoid `npm run test:e2e`, `playwright test`, headed/UI E2E, and full E2E
  validation.
- Do not use the E2E Runner skill for this campaign phase.
- Prefer static review plus targeted non-E2E type/lint checks only when needed.
- Every lane must update its own
  `docs/testing/e2e/parallel-campaign/agents/<lane>.md` with files touched, scenario
  counts, blockers, and commit hashes.
- Shared helper edits require a note in this file before commit.
- The `shell-tabs-command` source quota is inconsistent: the prompt says about
  366, while the canonical matrix currently sums to 266. Treat 266 as the
  committed target and document any proposed +100 expansion separately.
