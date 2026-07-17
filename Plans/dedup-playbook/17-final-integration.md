# Stage 17 - Final Integration, Regression, and Audit Closure

## Objective

Prove the combined deduplication program works end to end, remove temporary migration scaffolding whose window has closed, and close every priority with evidence.

## Dependencies

Stages 00-16 complete. No priority may remain silently pending.

## 1. Ledger reconciliation

- Verify priorities P1-P134 appear exactly once with `implemented`, `retained`, `rejected`, `deferred with owner`, or `already resolved`. P1-P120 are the original audit scope; P121-P134 are Wave 14 additions accepted after saturation review.
- For retained/rejected findings, include current source evidence and why abstraction/deletion is unsafe or not net-positive.
- For deferred work, name the external prerequisite and tracking issue; do not call the program complete if the prerequisite is internal work merely postponed.
- Compare implementation against `dedup-report.md` and update status without erasing original audit evidence.

## 2. Static verification

Run the repository's canonical commands for:

- Prettier check.
- ESLint.
- Main, renderer, shared, CLI, web, and package TypeScript projects.
- Import/dependency-cycle checks if configured.
- Dead export/dependency checks used by the project.
- Conflict-marker and generated-source synchronization checks.

Classify failures against Stage 00 baseline. No new failure is acceptable.

## 3. Test verification

Run focused suites accumulated by each stage, then the complete supported test suite. Required coverage includes:

- shared utilities and validators;
- settings defaults/load/migrations/CLI;
- plugin persistence, ledger, and sandbox negative cases;
- storage/cache/transcript/origins fixtures;
- process lifecycle, IPC, preload subscriptions, and cancellation;
- Cue/Pianola/BMAD/archive paths;
- web/WebSocket/Symphony security;
- provider resolution and Pi/OMP parsers;
- renderer components/hooks/accessibility/timers;
- CLI subprocess contracts;
- recovered E2E journeys.

Investigate order dependence by running important suites independently and in the full suite.

## 4. Runtime smoke matrix

### Electron desktop

- Fresh profile launch.
- Existing profile copied from pre-migration baseline.
- Settings open/change/restart/reset.
- Session create/resume/search/history.
- Agent run success/error/cancel for representative providers, including Pi and OMP.
- CLI dispatch into a desktop tab.
- Worktree create/open/remove.
- Browser tab allowed/denied navigation.
- Modals, command panels, keyboard navigation, pointer resize, scrolling, and copy/flash timers.
- First-party plugin install/load/permission/revoke/reinstall.
- Cue/Pianola/BMAD workflows.

### Web/web-desktop

- Build and serve production output.
- WebSocket connect/reconnect/message flow.
- Session/dashboard routes.
- Responsive/mobile gestures.
- Manual chunk/resource loading with no missing modules.

### Persistence and remote

- Current, old, malformed, and interrupted settings/cache/ledger/session fixtures.
- Origins migration and rollback scenario.
- Local and configured SSH remote selection/metadata/search.
- Restart while persisted sessions and caches exist.

## 5. Packaging and release

- Force main build and verify the loaded `dist/main/index.js` contains current unique code.
- Build unpacked and packaged Electron targets.
- Verify native module architecture.
- Launch packaged application.
- Inspect icons/resources, first-party plugins, prompts, CLI, preload, and native modules.
- Run CI matrix on the integration branch.
- Inspect web bundle output and package sizes against baseline.

## 6. Security regression

Re-run negative cases for:

- browser-tab navigation/permission policy;
- Symphony host/path traversal;
- plugin authorization/tombstones/corrupt state;
- sandbox payload byte limits and Unicode/base64 cases;
- image data URL/MIME validation;
- IPC malformed payloads and response-channel cross-talk;
- archive filenames/stream abort;
- settings/comment-JSON corruption.

No refactor may convert an error into permissive fallback.

## 7. Performance and resource checks

Compare baseline for startup, renderer responsiveness, transcript read/search, bundle size, memory during large transcripts, listener/timer counts, and test runtime. Investigate material regressions. Deduplication that increases hot-path allocations or repeated parsing must be revised.

## 8. Cleanup

Only after all verification passes:

- Remove temporary migration telemetry/dual-write code whose documented window is complete.
- Remove obsolete fixtures and compatibility tests tied exclusively to deleted paths.
- Regenerate docs/prompts and update audit status.
- Confirm no temporary scripts, debug logs, backups, or generated diffs remain tracked.
- Preserve migrations/compatibility required for released versions.

## Release and rollback plan

- Group release notes by user-visible risk, not internal line savings.
- Identify persistence/security changes requiring staged rollout.
- Keep profile/file backups for migration smoke and document restore procedure.
- Define commits/PRs to revert together for contracts, persistence, security, and parser core.
- If a regression appears, revert the owning stage rather than adding a duplicate emergency path.

## Exact terminal gate

Run from the integration worktree, in this order, after every stage ledger row is non-pending:

1. `bun install --frozen-lockfile`
2. `bun run format:check:all`
3. `bun run lint`
4. `bun run lint:eslint`
5. `bun run test`
6. `bun run test:integration`
7. `bun run test:performance`
8. `bun run build`
9. `bunx tsc -b tsconfig.main.json --force`
10. Verify the loaded `dist/main/index.js` contains a unique string introduced by the final main-process change, then launch with `bun run start`.
11. Run `bun run build:web-desktop`, then launch `bunx vite preview --config vite.config.web-desktop.mts --host 127.0.0.1 --port 4173` with the process supervisor. Open `http://127.0.0.1:4173` in Chromium and verify: app shell load without console/network errors; desktop WebSocket connect, forced disconnect, and reconnect; session list/search/open; Auto Run state updates; Cue state/actions; Git status refresh; feedback attachment/upload error handling; deep-link routing; and reload with persisted settings.
12. `bun run test:e2e` after skipped-case triage; run each restored formerly skipped spec three times.
13. `bun run package:win` on Windows plus the supported CI/platform packaging matrix.

The repository CI currently runs format/lint/type checks and the unit suite on Ubuntu and Windows. Local Bun gates do not replace that matrix. A command may be skipped only when the stage is provably unaffected and the ledger records why; none may be skipped at final integration. Any new failure blocks release. An unchanged Stage 00 failure requires exact before/after output and explicit owner approval.

## Ledger closure fields

For every P1-P134 row record: final title, stage/commit/PR, disposition, refreshed source anchors, LSP reference result where relevant, characterization or replacement tests, smoke scenario, security/persistence evidence class, net line delta, reviewer, rollback unit, and `dedup-report.md` update anchor. `already resolved`, `retained`, `rejected`, and `deferred` rows require the same evidence rigor as implementation rows. The program is not complete while any row is absent, pending, or justified only by the 2026-07-14 static audit.

## Final exit criteria

- Every priority P1-P134 has a reviewed disposition and evidence.
- All canonical static checks and supported tests pass or only unchanged Stage 00 baseline failures remain with explicit approval.
- Electron, web, CLI, plugin, remote, and packaging smoke matrices pass.
- Security negative tests pass.
- Current and historical persisted data load without loss.
- No unresolved conflict, stale alias, temporary scaffold, or untracked migration remains.
- `dedup-report.md` and the execution ledger reflect the implemented repository state.
