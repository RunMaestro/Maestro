# agent-crud-provider

Status: pending launch

## Scope

Agent CRUD, provider setup, Agent Sessions.

## Checklist

- [x] Inspect existing related E2E coverage and component surfaces.
- [ ] Author deterministic active scenarios up to the lane target where feasible.
- [x] Add skipped/env-gated cases for real-provider-only flows.
- [x] Record files touched and scenario counts.
- [ ] Commit lane work on `codex/e2e-agent-crud-provider`.

## Progress

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
  - Pending final tranche commit.
- Blockers:
  - E2E execution, Playwright listing, headed/UI E2E, and full E2E validation are intentionally not run under the recovery-run hard rules.
  - Real provider storage/auth state is unavailable in deterministic lane coverage, so real provider scenarios remain skipped/env-gated.
