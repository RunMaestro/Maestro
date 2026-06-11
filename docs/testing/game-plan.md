# Testing Campaign Game Plan

This plan covers organization, branch hygiene, fresh audit work, and eventual E2E execution. It intentionally excludes test implementation details except where needed to route work.

## Phase 1: Freeze The Current Documentation State

1. Commit the `docs/testing/` consolidation and redirect stubs.
2. Keep `.npmrc.bak` untracked and out of the commit.
3. Verify the canonical E2E matrix still recomputes to 3,025 / 3,025 after the move.

## Phase 2: Consolidate Branches And Worktrees

1. Confirm the bucket branch is the working branch: `codex/full-e2e-coverage-campaign`.
2. Fetch upstream and rebase the bucket branch after the documentation commit.
3. Inspect the 7 branch-only commits on `codex/e2e-autorun-ai-terminal`.
4. Cherry-pick only still-missing autorun behavior, or document why each commit is superseded. Do not merge that branch wholesale without conflict review.
5. After verification, prune obsolete E2E lane and fallback worktrees.

## Phase 3: Re-Audit Unit And Integration Coverage

1. Run the standard non-E2E gates after rebase:
   - `npm run lint`
   - `npm run lint:eslint`
   - `npm run test`
   - `npm run test:coverage`
2. Refresh [audits/test-coverage-audit.md](audits/test-coverage-audit.md) with current coverage output and real remaining gaps.
3. Compare `codex/unit-coverage-campaign`, `codex/integration-coverage-campaign`, `main`, and the bucket branch before declaring unit or integration work complete.

## Phase 4: Execute E2E With PM2 Shards

Use the E2E sharding rules in [e2e/parallel-campaign/README.md](e2e/parallel-campaign/README.md). Do not run one giant parallel Playwright invocation.

Status checkpoint, 2026-06-11: targeted focused E2E repair runs are green for app shell, git/group-chat/playbooks, debug/accessibility, Auto Run expanded modal/worktree/stop-state coverage, and files/docs/history cases listed in [current-status.md](current-status.md). The first PM2 shard attempt was stopped as stale discovery after local source fixes; launch fresh shards from rebuilt artifacts before treating Phase 4 as complete. The full PM2-sharded Playwright/Electron suite remains pending.

Execution rules:

- Build once before launching shards, or run separate worktrees per shard.
- One PM2 one-shot Codex process per shard.
- One Playwright worker per process.
- Disjoint spec ownership per shard.
- Unique `HOME`, `MAESTRO_DATA_DIR`, `PLAYWRIGHT_HTML_REPORT`, Playwright `--output`, and `VITE_PORT`.
- Start with two shards and scale only after both exit cleanly.

First execution split:

- Shard A: app shell, command terminal, Auto Run, Codex AI terminal.
- Shard B: files/history, wizard/settings/prompts, git/group chat/playbooks, stats/graph/Symphony, debug/accessibility, mobile/web.

## Phase 5: Triage E2E Results

1. Collect PM2 logs, Playwright reports, traces, and failure screenshots.
2. Classify each failure as product bug, selector/test bug, environment gap, or expected residual.
3. Fix product or selector issues in small batches.
4. Rerun only affected shards until clean, then run the full sharded suite.

## Phase 6: Cleanup And Handoff

1. Delete or archive obsolete worktrees after their commits are proven absorbed or superseded.
2. Update [current-status.md](current-status.md) with final command results.
3. Keep old top-level testing docs as redirect stubs only.
4. Use [session-handoff.md](session-handoff.md) only for historical context unless it has been refreshed with current command output.
