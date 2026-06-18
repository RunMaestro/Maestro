# Testing Current Status

Last updated: 2026-06-17 23:48 EDT.

## Verdict

The pre-upstream-sync checkpoint was green, but the campaign is not final on the current upstream-sync tree.

- Current sync work: `upstream/main` at `7eca62d07` is being merged into `codex/full-e2e-coverage-campaign`.
- Static/pre-push gate on the clean upstream-shaped tree: passed through format, TypeScript, ESLint, and unit test execution.
- Unit suite on the upstream-shaped tree: 1,073 files passed, 1 skipped; 31,219 tests passed, 108 skipped.
- Enforced unit coverage on the upstream-shaped tree: failing the 100% global thresholds.
- Integration and E2E have not been rerun after the upstream-sync tree change.

Current blocking gaps before finality:

- Unit coverage must return to 100% statements/branches/functions/lines on the upstream-synced tree.
- Unit skipped tests must be eliminated or converted into active passing coverage.
- Full integration, including the SSH provider path, must be rerun with 0 skips on the upstream-synced tree.
- Full E2E Phase 6 equivalent shards must be rerun with 0 failed and 0 skipped tests on the upstream-synced tree.

The known non-active residuals at the bottom of this document remain intentionally outside the active E2E scope because they require live external accounts, real OS handoff state, configured remote services, or product work not covered by deterministic local tests.

## Latest Verification

| Gate                                           |                                                                                  Result | Evidence                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------: | ---------------------------------------------------------------- |
| Upstream-shaped `npm run validate:push`        |                   format, TypeScript, ESLint, and unit execution passed; 108 unit skips | `/tmp/maestro-phase7-validate-push-20260617234110.log`           |
| Upstream-shaped `npm run test:coverage`        | failed 100% thresholds: 66% statements, 60.78% branches, 63.25% functions, 67.05% lines | `/tmp/maestro-upstream-overlay-test-coverage-20260617232642.log` |
| Pre-upstream-sync unit coverage checkpoint     |         731 files passed, 28,679 tests passed, 100% statements/branches/functions/lines | `/tmp/maestro-final-test-coverage-20260617222450.log`            |
| Pre-upstream-sync full integration with SSH    |                                                   539 files passed, 12,687 tests passed | `/tmp/maestro-integration-ssh-full-20260617220145.log`           |
| Pre-upstream-sync final Phase 6 E2E shard A    |                                                         985 passed, 0 failed, 0 skipped | `/tmp/maestro-phase6-final-a.log`                                |
| Pre-upstream-sync final Phase 6 E2E shard B    |                                                       1,985 passed, 0 failed, 0 skipped | `/tmp/maestro-phase6-final-b.log`                                |
| Pre-upstream-sync combined Phase 6 E2E runtime |                                                       2,970 passed, 0 failed, 0 skipped | `e2e-results/phase6-final-a`, `e2e-results/phase6-final-b`       |

The temporary local SSH daemon used for the pre-sync integration verification was removed after that successful run.

## E2E Count Reconciliation

The campaign has three different counts that are easy to confuse:

- `3,025` is the authored active scenario matrix target. It is a coverage-planning count, not a one-to-one Playwright runtime count.
- `2,970` is the final Phase 6 runtime-expanded Playwright/Electron count: Shard A `985 passed` plus Shard B `1,985 passed`.
- Static scan of the current E2E source finds 15 spec files, 2,373 direct `test(...)` calls, 0 `test.skip(...)`, 0 `test.fixme(...)`, and 0 `test.only(...)`. Runtime-generated tests expand that source count to the 2,970 final Playwright tests.

Older `2,991` totals with `21 skipped` were Phase 5 historical runs and are superseded by the Phase 6 final proof above.

## Process And Mailer State

- `npm run test:e2e:stop` previously reported no Maestro E2E Playwright/Electron runners after cleanup.
- Current PM2 cleanup removed the temporary `maestro-integration-sshd` process.
- The old Phase 5 E2E status mailer was removed.
- Current scheduled status mailer:

```cron
15 */3 * * * /Users/jeffscottward/.codex/scripts/maestro-phase6-status-email.mjs >> /Users/jeffscottward/.codex/log/maestro-phase6-status-email.log 2>&1
```

## Known Non-Active Residuals

These are not active failures or skipped Phase 6 runtime tests:

- Live provider/account-backed wizard handoff.
- Real operating-system default-app file handoff.
- Configured SSH file browsing.
- Live Symphony, GitHub, leaderboard, and backend polling paths.
- Downloadable achievement badge image verification.
- PDF page rendering.
- File-tree toolbar and multi-select product gaps.
