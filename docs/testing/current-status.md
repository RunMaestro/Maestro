# Testing Current Status

Last updated: 2026-06-19 23:45 EDT.

## Verdict

The pre-upstream-sync checkpoint was green, but the campaign is not final on the current upstream-sync tree.

- Current sync work: `codex/full-e2e-coverage-campaign` now includes current `upstream/main` at `873a89137` via merge commit `bcbe9a479`.
- Static/pre-push gate on the clean upstream-shaped tree: passed through format, TypeScript, ESLint, and unit test execution.
- Unit suite on the upstream-shaped tree: latest non-coverage run passed 1,247 files and 33,609 tests with 0 skipped reported.
- Enforced unit coverage on the upstream-shaped tree: latest coverage run passed 1,247 files and 33,609 tests with 0 skipped reported, then failed the 100% global thresholds at 81.88% statements, 74.67% branches, 80.69% functions, and 83.19% lines. This is still a blocking unit-coverage gap, not finality.
- Deterministic integration on the upstream-shaped tree: the restored/ported local integration suite now passes when the live provider probe is excluded, with 534 files and 12,509 tests passed.
- Live provider integration on the upstream-shaped tree: still blocked. `provider-integration.test.ts` fails on the first Claude Code live call because the provider result is not considered successful, so this remains an external/live-provider runtime gate.
- E2E on the upstream-shaped tree: authoring inventory is complete, but full Playwright/Electron shards have not been rerun after the upstream-sync tree change. Current static inventory under `e2e/*.spec.ts` is 16 spec files, 2,375 active direct `test(...)` declarations, and 0 static skip/fixme/only declarations.
- Latest focused `useRemoteIntegration` tranche: 1 file passed, 42 tests passed; focused `useRemoteIntegration.ts` coverage is 87.04% statements, 62.01% branches, 90.38% functions, and 89.74% lines. This is progress, not finality; broad 100% unit coverage still needs restoration.
- Prior focused FeedbackChatView tranche: 1 file passed, 12 tests passed; focused `FeedbackChatView.tsx` coverage is 83.51% statements, 71.88% branches, 76.12% functions, and 86.75% lines.
- Prior focused CLI connectivity command tranche: 1 file passed, 45 tests passed; focused `open-terminal.ts`, `refresh-files.ts`, `refresh-auto-run.ts`, `status.ts`, `open-browser.ts`, `notify-flash.ts`, `notify-toast.ts`, and `prompts-get.ts` coverage is 100% statements, branches, functions, and lines.
- Prior focused LeaderboardRegistrationModal tranche: 1 file passed, 52 tests passed; focused `LeaderboardRegistrationModal.tsx` coverage is 98.72% statements, 89.16% branches, 100% functions, and 100% lines.
- Prior focused Symphony tranche: 1 file passed, 228 tests passed; focused `symphony.ts` coverage is 88.60% statements, 78.70% branches, 93.33% functions, and 88.48% lines.
- Prior focused group-chat router tranche: 1 file passed, 75 tests passed; focused `group-chat-router.ts` coverage is 73.09% statements, 62.43% branches, 79.03% functions, and 74.29% lines.
- Focused restored web-server and mobile integration tranches are green again. The broad deterministic integration suite is now green after restoring/porting most of the pre-sync integration files, but live provider integration and E2E have not been proven green on the upstream-sync tree.

Current blocking gaps before finality:

- Unit coverage must return to 100% statements/branches/functions/lines on the upstream-synced tree.
- Unit skipped tests have been eliminated in the current broad unit run; keep this invariant while restoring coverage.
- The deterministic integration suite is green excluding live provider checks, but the remaining provider integration gate must either pass with real configured providers/SSH or be explicitly classified outside deterministic finality. Current local counts under the broad integration-file matcher: 32 tracked files, 536 working-tree files, and 540 files on `backup/full-e2e-coverage-campaign-119a0997b`.
- Full integration, including the live provider and SSH provider path, must be rerun with 0 failures and an accepted skip policy on the upstream-synced tree.
- Full E2E Phase 6 equivalent shards must be rerun with 0 failed and 0 skipped tests on the upstream-synced tree.

The known non-active residuals at the bottom of this document remain intentionally outside the active E2E scope because they require live external accounts, real OS handoff state, configured remote services, or product work not covered by deterministic local tests.

## Latest Verification

| Gate | Result | Evidence |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | --------------- | -------------------------- |
| Current `npm run test` | 1,247 files passed; 33,609 tests passed; 0 skipped | `/tmp/maestro-unit-full-202606192335.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 81.88% statements, 74.67% branches, 80.69% functions, 83.19% lines; 1,247 files passed; 33,609 tests passed; 0 skipped reported | `/tmp/maestro-unit-coverage-202606192341.log` |
| Current deterministic integration without live provider probe | 534 files passed; 12,509 tests passed; 0 skips seen | `/tmp/maestro-integration-no-provider-202606192327.log` |
| Current live provider integration probe | failed first Claude Code live call; provider result was not considered successful; 1 failed | `/tmp/maestro-provider-integration-20260619225928.log` |
| Current E2E static inventory | 16 spec files; 2,375 active direct declarations; 0 static skip/fixme/only declarations; 0 PM2 jobs | direct filesystem inventory; `pm2 jlist` |
| Current static skip audit | 7 conditional skip/fixme sites outside `e2e/`: 2 unit-style and 5 integration-style sites | `rg "\b(it                                                                                                                                                                                                                                                                                                                                                                                                                     | test | describe)\.skip | skip\(" src/**tests** e2e` |
| Current `npm run test:coverage` | failed 100% thresholds: 81.83% statements, 74.58% branches, 80.89% functions, 83.12% lines; 1,247 files passed; 33,576 tests passed; 0 skipped reported | `/tmp/maestro-phase7-coverage-after-remoteintegration-20260619032113.log` |
| Current focused useRemoteIntegration unit and coverage | 1 file passed; 42 passed; focused `useRemoteIntegration.ts` coverage is 87.04% statements, 62.01% branches, 90.38% functions, 89.74% lines | `npx vitest run src/__tests__/renderer/hooks/useRemoteIntegration.test.ts`; `/tmp/maestro-remoteintegration-focused-coverage-20260619032031.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 81.74% statements, 74.55% branches, 80.71% functions, 83.03% lines; 1,247 files passed; 33,569 tests passed; 0 skipped reported | `/tmp/maestro-phase7-coverage-after-feedbackchat-20260619025552.log` |
| Current focused FeedbackChatView unit and coverage | 1 file passed; 12 passed; focused `FeedbackChatView.tsx` coverage is 83.51% statements, 71.88% branches, 76.12% functions, 86.75% lines | `/tmp/maestro-feedbackchat-focused-clean-20260619025502.log`, `/tmp/maestro-feedbackchat-focused-coverage-20260619025510.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 81.68% statements, 74.44% branches, 80.61% functions, 82.97% lines; 1,247 files passed; 33,564 tests passed; 0 skipped reported | `/tmp/maestro-phase7-coverage-after-cli-connectivity-20260619023627.log` |
| Current focused CLI connectivity command unit and coverage | 1 file passed; 45 passed; focused CLI connectivity command coverage is 100% statements, branches, functions, and lines across eight command modules | `/tmp/maestro-cli-connectivity-focused-closed-20260619023611.log`, `/tmp/maestro-cli-connectivity-focused-coverage-closed-20260619023612.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 81.47% statements, 74.22% branches, 80.53% functions, 82.75% lines; 1,246 files passed; 33,519 tests passed; 0 skipped reported | `/tmp/maestro-phase7-coverage-after-leaderboard-modal-20260619021450.log` |
| Current focused LeaderboardRegistrationModal unit and coverage | 1 file passed; 52 passed; focused `LeaderboardRegistrationModal.tsx` coverage is 98.72% statements, 89.16% branches, 100% functions, 100% lines | `/tmp/maestro-leaderboard-modal-focused-20260619022237.log`, `/tmp/maestro-leaderboard-modal-focused-coverage-20260619022239.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 81.34% statements, 74.03% branches, 80.44% functions, 82.61% lines; 1,246 files passed; 33,487 tests passed; 0 skipped reported | `/tmp/maestro-phase7-coverage-after-tabhelpers-20260619014757.log` |
| Current focused tabHelpers unit and coverage | 1 file passed; 269 passed; focused `tabHelpers.ts` coverage is 80.71% statements, 74.91% branches, 83.50% functions, 81.30% lines | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.config.mts src/__tests__/renderer/utils/tabHelpers.test.ts`; `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.config.mts --coverage --coverage.include=src/renderer/utils/tabHelpers.ts src/__tests__/renderer/utils/tabHelpers.test.ts` |
| Current `npm run test:coverage` | failed 100% thresholds: 81.32% statements, 74.02% branches, 80.44% functions, 82.58% lines; 1,246 files passed; 33,482 tests passed; 0 skipped reported | `/tmp/maestro-phase7-coverage-after-upstream-queue-20260619012936.log` |
| Current focused queued thumbnail unit | 1 file passed; 9 passed | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.config.mts src/__tests__/renderer/components/QueuedItemsList.test.tsx` |
| Current upstream queue merge smoke | 3 renderer unit files passed; 160 passed, plus TerminalOutput integration 16 passed | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.config.mts src/__tests__/renderer/components/QueuedItemsList.test.tsx src/__tests__/renderer/components/GroupChatInput.test.tsx src/__tests__/renderer/components/TerminalOutput.test.tsx`; `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.integration.config.ts src/__tests__/integration/TerminalOutput.integration.test.tsx` |
| Current `npm run test:coverage` | failed 100% thresholds: 81.32% statements, 74.00% branches, 80.44% functions, 82.58% lines; 1,246 files passed; 33,481 tests passed; 0 skipped reported | `/tmp/maestro-phase7-coverage-after-symphony-20260619011017.log` |
| Current focused Symphony coverage | 1 file passed; 228 passed; focused `symphony.ts` coverage is 88.60% statements, 78.70% branches, 93.33% functions, 88.48% lines | `/tmp/maestro-symphony-focused-coverage-20260619010941.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 81.24% statements, 73.95% branches, 80.40% functions, 82.50% lines; 1,246 files passed; 33,472 tests passed; 0 skipped reported | `/tmp/maestro-phase7-coverage-after-group-chat-router-20260619002419.log` |
| Current focused group-chat router coverage | 1 file passed; 75 passed; focused `group-chat-router.ts` coverage is 73.09% statements, 62.43% branches, 79.03% functions, 74.29% lines | `/tmp/maestro-group-chat-router-focused-20260619002338.log`, `/tmp/maestro-group-chat-router-focused-coverage-20260619002347.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 81.19% statements, 73.93% branches, 80.34% functions, 82.45% lines; 1,246 files passed; 33,463 tests passed; 0 skipped reported | `/tmp/maestro-phase7-coverage-after-autorun-ipc-20260618235447.log` |
| Current focused Auto Run IPC coverage | 1 file passed; 139 passed; focused `autorun.ts` coverage is 97.93% statements, 90.71% branches, 100% functions, 97.89% lines | `/tmp/maestro-autorun-focused-tests-20260618234616.log`, `/tmp/maestro-autorun-focused-coverage-20260618234616.log` |
| Current focused useInputProcessing coverage | 1 file passed; 104 passed; focused `useInputProcessing.ts` coverage is 100% statements, 92.71% branches, 100% functions, 100% lines | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.config.mts --coverage --coverage.include=src/renderer/hooks/input/useInputProcessing.ts src/__tests__/renderer/hooks/useInputProcessing.test.ts` |
| Current `npm run test:coverage` | failed 100% thresholds: 81.04% statements, 73.75% branches, 80.30% functions, 82.29% lines; 1,246 files passed; 33,408 tests passed; 0 skipped | `NODE_OPTIONS=--max-old-space-size=8192 npm run test:coverage` |
| Current focused FilePreview coverage | 1 file passed; 137 passed; focused `FilePreview.tsx` coverage is 96.73% statements, 88.54% branches, 100% functions, 98.45% lines | `/tmp/maestro-filepreview-focused-scrollbranches2-20260618223444.log`, `/tmp/maestro-filepreview-coverage-scrollbranches-20260618223454.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 80.88% statements, 73.56% branches, 80.14% functions, 82.15% lines | `/tmp/maestro-phase7-coverage-after-filepreview-scrollbranches-20260618223648.log` |
| Current focused messageHandlers coverage | 1 file passed; 225 passed; 100% focused function coverage for handler file | `/tmp/maestro-messagehandlers-coverage-autorun-cue-20260618214027.log` |
| Current focused messageHandlers unit | 1 file passed; 225 passed | `/tmp/maestro-messagehandlers-focused-autorun-cue-20260618214011.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 80.61% statements, 73.35% branches, 79.81% functions, 81.88% lines | `/tmp/maestro-phase7-coverage-refresh-20260618212409.log` |
| Current focused TerminalOutput cleanup integration | 1 file passed; 16 passed | `/tmp/maestro-terminaloutput-integration-focused-cleanup-20260618213005.log` |
| Current focused TerminalOutput cleanup unit | 1 file passed; 126 passed | `/tmp/maestro-terminaloutput-unit-focused-cleanup-20260618213005.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 80.59% statements, 73.30% branches, 79.78% functions, 81.86% lines | `/tmp/maestro-phase7-coverage-after-app-shell-20260618210201.log` |
| Current focused App shell coverage | 1 file passed; 25 passed | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.config.mts src/__tests__/renderer/App.test.tsx` |
| Current `npm run test:coverage` | failed 100% thresholds: 80.47% statements, 73.14% branches, 79.49% functions, 81.76% lines | `/tmp/maestro-phase7-coverage-after-agents-full-20260618203607.log` |
| Current focused agents IPC handler coverage | 1 file passed; 155 passed; 100% file coverage | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.config.mts --coverage --coverage.include=src/main/ipc/handlers/agents.ts src/__tests__/main/ipc/handlers/agents.test.ts` |
| Current `npm run test:coverage` | failed 100% thresholds: 80.26% statements, 72.92% branches, 79.37% functions, 81.55% lines | `/tmp/maestro-phase7-coverage-after-cli-index-20260618192824.log` |
| Current focused CLI entrypoint coverage | 1 file passed; 4 passed; 100% file coverage | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.config.mts --coverage --coverage.include=src/cli/index.ts src/__tests__/cli/index.test.ts` |
| Current focused CLI entrypoint integration | 1 file passed; 4 passed | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.integration.config.ts src/__tests__/integration/cli-entrypoint.integration.test.ts` |
| Current `npm run test:coverage` | failed 100% thresholds: 80.15% statements, 72.92% branches, 79.27% functions, 81.44% lines | `/tmp/maestro-phase7-coverage-after-context-20260618190545.log` |
| Current focused context handler coverage | 1 file passed; 28 passed | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.config.mts --coverage --coverage.include=src/main/ipc/handlers/context.ts src/__tests__/main/ipc/handlers/context.test.ts` |
| Current `npm run test:coverage` | failed 100% thresholds: 80.01% statements, 72.85% branches, 79.18% functions, 81.29% lines | `/tmp/maestro-phase7-coverage-after-settingsstore-20260618184047.log` |
| Current focused settingsStore coverage | 1 file passed; 215 passed | `/tmp/maestro-settingsstore-focused-20260618184803.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 79.90% statements, 72.85% branches, 78.94% functions, 81.17% lines | `/tmp/maestro-phase7-coverage-after-documentgraph-behavior-20260618182145.log` |
| Current focused DocumentGraphView coverage | 1 file passed; 183 passed | `/tmp/maestro-document-graph-view-focused-after-behavior-20260618182128.log` |
| Current focused TerminalOutput integration | 1 file passed; 16 passed | `/tmp/maestro-terminaloutput-integration-focused-after-dedent-20260618181727.log` |
| Current focused TerminalOutput unit | 1 file passed; 126 passed | `/tmp/maestro-terminaloutput-unit-focused-after-dedent-20260618181727.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 79.80% statements, 72.72% branches, 78.76% functions, 81.07% lines | `/tmp/maestro-phase7-coverage-after-messagehandlers-callback-failures-20260618173420.log` |
| Current focused messageHandlers coverage | 1 file passed; 214 passed | `/tmp/maestro-messagehandlers-focused-20260618173400.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 79.75% statements, 72.70% branches, 78.69% functions, 81.02% lines | `/tmp/maestro-phase7-coverage-after-mobile-app-callbacks-20260618172314.log` |
| Current focused mobile App/panel callback batch | 11 files passed; 153 passed | `/tmp/maestro-mobile-app-panels-focused-20260618172304.log` |
| Current focused mobile App coverage | 1 file passed; 103 passed | `/tmp/maestro-mobile-app-focused-20260618172246.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 79.68% statements, 72.65% branches, 78.52% functions, 80.94% lines | `/tmp/maestro-phase7-coverage-after-autoruninline-20260618165947.log` |
| Current focused mobile panel/sheet coverage | 10 files passed; 50 passed | `/tmp/maestro-mobile-panels-focused-20260618165927.log` |
| Current focused AutoRunInline coverage | 1 file passed; 20 passed | `/tmp/maestro-autoruninline-focused-20260618165913.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 79.56% statements, 72.53% branches, 78.38% functions, 80.83% lines | `/tmp/maestro-phase7-coverage-after-left-panel-20260618164654.log` |
| Current focused mobile panel/sheet coverage | 9 files passed; 30 passed | `/tmp/maestro-mobile-panels-focused-20260618164643.log` |
| Current focused LeftPanel coverage | 1 file passed; 7 passed | `/tmp/maestro-left-panel-focused-20260618164633.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 79.48% statements, 72.47% branches, 78.19% functions, 80.74% lines | `/tmp/maestro-phase7-coverage-after-mobile-sheets-20260618163949.log` |
| Current focused mobile sheet coverage | 8 files passed; 23 passed | `/tmp/maestro-mobile-panels-focused-20260618163934.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 79.27% statements, 72.23% branches, 77.87% functions, 80.53% lines | `/tmp/maestro-phase7-coverage-after-usage-dashboard-20260618161752.log` |
| Current focused UsageDashboardPanel coverage | 1 file passed; 3 passed | `/tmp/maestro-usage-dashboard-focused-20260618161737.log` |
| Current focused isolated mobile panel coverage | 3 files passed; 9 passed | `/tmp/maestro-mobile-panels-focused-20260618161745.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 79.22% statements, 72.19% branches, 77.80% functions, 80.49% lines | `/tmp/maestro-phase7-coverage-after-mobile-panels-20260618161052.log` |
| Current focused mobile panel coverage | 2 files passed; 6 passed | `/tmp/maestro-mobile-panels-focused-20260618161043.log` |
| Current focused AchievementsPanel coverage | 1 file passed; 3 passed | `/tmp/maestro-achievements-focused-20260618161035.log` |
| Current focused CuePanel coverage | 1 file passed; 3 passed | `/tmp/maestro-cuepanel-focused-20260618160921.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 79.13% statements, 72.05% branches, 77.68% functions, 80.39% lines | `/tmp/maestro-phase7-coverage-after-filepreview-20260618160030.log` |
| Prior focused FilePreview coverage | 1 file passed; 103 passed | `/tmp/maestro-filepreview-focused-20260618160016.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 79.06% statements, 71.91% branches, 77.61% functions, 80.32% lines | `/tmp/maestro-phase7-coverage-after-claude-edges-20260618154728.log` |
| Current focused Claude handler coverage | 1 file passed; 89 passed | `/tmp/maestro-claude-handler-focused-20260618154720.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 78.78% statements, 71.80% branches, 77.47% functions, 80.03% lines | `/tmp/maestro-phase7-coverage-after-factory-timeouts-20260618153600.log` |
| Current focused web-server factory coverage | 1 file passed; 91 passed | `/tmp/maestro-webserver-factory-focused-20260618153550.log` |
| Prior `npm run test:coverage` | failed 100% thresholds: 78.62% statements, 71.74% branches, 77.33% functions, 79.85% lines | `/tmp/maestro-phase7-coverage-after-messagehandlers-unconfigured-20260618152613.log` |
| Current focused messageHandlers coverage | 1 file passed; 196 passed | `/tmp/maestro-messagehandlers-focused-20260618152559.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 78.53% statements, 71.68% branches, 77.33% functions, 79.75% lines | `/tmp/maestro-phase7-coverage-after-factory-git-messagehandlers-20260618150804.log` |
| Current focused web-server factory coverage | 1 file passed; 88 passed | `/tmp/maestro-webserver-factory-focused-20260618150755.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 78.49% statements, 71.63% branches, 77.32% functions, 79.71% lines | `/tmp/maestro-phase7-coverage-after-messagehandlers-webserver-factory-20260618150118.log` |
| Current focused messageHandlers coverage | 1 file passed; 195 passed | `/tmp/maestro-messagehandlers-focused-20260618150108.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 78.45% statements, 71.59% branches, 77.30% functions, 79.68% lines | `/tmp/maestro-phase7-coverage-after-webserver-factory-callbacks-20260618145127.log` |
| Current focused web-server factory coverage | 1 file passed; 85 passed | `/tmp/maestro-webserver-factory-focused-20260618145039.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 78.37% statements, 71.56% branches, 77.31% functions, 79.60% lines | `/tmp/maestro-phase7-coverage-after-webserver-class-restored-20260618144003.log` |
| Current focused WebServer coverage | 1 file passed; 8 passed | `/tmp/maestro-webserver-class-focused-20260618143955.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 78.24% statements, 71.55% branches, 76.69% functions, 79.45% lines | `/tmp/maestro-phase7-coverage-after-keyboard-ctrl-20260618142210.log` |
| Current focused keyboard handler coverage | 1 file passed; 119 passed | `/tmp/maestro-main-keyboard-focused-20260618142201.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 78.12% statements, 71.43% branches, 76.64% functions, 79.32% lines | `/tmp/maestro-phase7-coverage-after-cli-manager-20260618134929.log` |
| Current focused Maestro CLI manager coverage | 1 file passed; 6 passed | `/tmp/maestro-cli-manager-focused-20260618135643.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 77.99% statements, 71.36% branches, 76.54% functions, 79.18% lines | `/tmp/maestro-phase7-coverage-after-mobile-app-20260618134127.log` |
| Current focused mobile App coverage | 1 file passed; 100 passed | `/tmp/maestro-mobile-app-focused-20260618135548.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 77.92% statements, 71.29% branches, 76.38% functions, 79.11% lines | `/tmp/maestro-phase7-coverage-after-webserver-git-groups-20260618132414.log` |
| Current focused web-server/messageHandlers batch | 2 files passed; 270 passed | `/tmp/maestro-webserver-messagehandlers-focused-20260618133104.log` |
| Prior `npm run test:coverage` | failed 100% thresholds: 77.92% statements, 71.29% branches, 76.38% functions, 79.11% lines | `/tmp/maestro-phase7-coverage-after-messagehandler-validation-20260618131720.log` |
| Current focused messageHandlers coverage | 1 file passed; 188 passed | `/tmp/maestro-messagehandlers-focused-20260618131705.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 77.87% statements, 71.25% branches, 76.36% functions, 79.05% lines | `/tmp/maestro-phase7-coverage-after-webserver-bridges-20260618130804.log` |
| Current focused web-server factory coverage | 1 file passed; 82 passed | `/tmp/maestro-webserver-factory-focused-20260618133007.log` |
| Current `npm run test:coverage` | failed 100% thresholds: 77.82% statements, 71.21% branches, 76.36% functions, 79.00% lines | `/tmp/maestro-phase7-coverage-after-keyboard-20260618125510.log` |
| Current focused keyboard handler coverage | 1 file passed; 106 passed | `/tmp/maestro-main-keyboard-focused-20260618125458.log` |
| Prior FilePreview/web-server coverage checkpoint | failed 100% thresholds: 77.81% statements, 71.20% branches, 76.35% functions, 78.99% lines | `/tmp/maestro-phase7-coverage-after-filepreview-webserver-20260618124629.log` |
| Prior focused messageHandlers coverage | 1 file passed; 168 passed | `/tmp/maestro-messagehandlers-focused-20260618124619.log` |
| Prior focused web-server factory coverage | 1 file passed; 71 passed | `/tmp/maestro-webserver-factory-focused-20260618124440.log` |
| Current focused FilePreview coverage | 1 file passed; 93 passed | `/tmp/maestro-filepreview-focused-20260618123649.log` |
| Prior FilePreview coverage checkpoint | failed 100% thresholds: 77.74% statements, 71.10% branches, 76.34% functions, 78.91% lines | `/tmp/maestro-phase7-coverage-after-filepreview-20260618123659.log` |
| Prior maestro-p coverage checkpoint | failed 100% thresholds: 77.67% statements, 71.02% branches, 76.30% functions, 78.84% lines | `/tmp/maestro-phase7-coverage-after-maestro-p-index-20260618122013.log` |
| Current focused maestro-p entrypoint coverage | 1 file passed; 7 passed | `/tmp/maestro-p-index-focused-20260618121938.log` |
| Prior AnnotatorCanvas coverage checkpoint | failed 100% thresholds: 77.43% statements, 70.85% branches, 76.15% functions, 78.59% lines | `/tmp/maestro-phase7-coverage-after-annotator-canvas-20260618120250.log` |
| Current focused AnnotatorCanvas coverage | 1 file passed; 5 passed | `/tmp/maestro-annotator-canvas-focused-20260618120237.log` |
| Current integration file inventory | 36 tracked files; 36 working-tree files; 543 backup files | `git ls-files`, `rg --files`, and `git ls-tree` against `backup/full-e2e-coverage-campaign-119a0997b` |
| Prior MindMap/agentSessions coverage checkpoint | failed 100% thresholds: 77.08% statements, 70.61% branches, 75.88% functions, 78.23% lines | `/tmp/maestro-phase7-coverage-after-mindmap-agent-sessions-20260618114756.log` |
| Current focused agentSessions handler coverage | 1 file passed; 26 passed | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.config.mts src/__tests__/main/ipc/handlers/agentSessions.test.ts` |
| Current focused MindMap coverage | 1 file passed; 13 passed | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.config.mts src/__tests__/renderer/components/DocumentGraph/MindMap.test.ts` |
| Prior AgentSessionsModal focused coverage | 1 file passed; 7 passed | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.config.mts src/__tests__/renderer/components/AgentSessionsModal.test.tsx` |
| Prior AgentSessionsModal coverage checkpoint | failed 100% thresholds: 76.39% statements, 70.14% branches, 75.55% functions, 77.51% lines | `/tmp/maestro-phase7-coverage-after-agent-sessions-modal-20260618113305.log` |
| Prior AgentCreationDialog coverage checkpoint | failed 100% thresholds: 76.27% statements, 70.04% branches, 75.45% functions, 77.39% lines | `/tmp/maestro-phase7-coverage-after-agent-creation-dialog-20260618112226.log` |
| Current focused AgentCreationDialog coverage | 1 file passed; 8 passed | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.config.mts src/__tests__/renderer/components/AgentCreationDialog.test.tsx` |
| Current focused remote listener coverage | 1 file passed; 13 passed | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.config.mts src/__tests__/renderer/hooks/remote/useAppRemoteEventListeners.test.tsx` |
| Current focused AutoRunInline coverage | 1 file passed; 11 passed | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --config vitest.config.mts src/__tests__/web/mobile/AutoRunInline.test.tsx` |
| Current focused web/mobile coverage wrappers | 15 files passed; 246 passed | `/tmp/maestro-integration-coverage-wrappers-split-20260618102759.log` |
| Current DocumentGraph renderer suite | 12 files passed; 634 passed | `/tmp/maestro-document-graph-suite-20260618101609.log` |
| Current DocumentGraphView focused coverage | 1 file passed; 177 passed | `/tmp/maestro-document-graph-view-focused-20260618101550.log` |
| Current web-server factory coverage wrapper | 1 file passed; 75 passed | `/tmp/maestro-webserver-factory-current-wrapper-20260618102652.log` |
| Current restored main entrypoint unit tranche | 1 file passed; 9 passed | `/tmp/maestro-main-index-restore-20260618091509.log` |
| Current restored unit tranche plus main | 5 files passed; 56 passed | `/tmp/maestro-restored-unit-current-kept-plus-main-20260618091607.log` |
| Prior expanded remote listener checkpoint | failed 100% thresholds: 76.15% statements, 69.92% branches, 75.25% functions, 77.27% lines | `/tmp/maestro-phase7-coverage-after-remote-listeners-expanded-20260618111145.log` |
| Prior remote listener coverage checkpoint | failed 100% thresholds: 76.07% statements, 69.86% branches, 75.13% functions, 77.19% lines | `/tmp/maestro-phase7-coverage-after-remote-listeners-20260618110113.log` |
| Prior AutoRunInline coverage checkpoint | failed 100% thresholds: 75.90% statements, 69.75% branches, 74.97% functions, 77.02% lines | `/tmp/maestro-phase7-coverage-after-autoruninline-20260618104650.log` |
| Prior factory marketplace coverage checkpoint | failed 100% thresholds: 75.73% statements, 69.50% branches, 74.78% functions, 76.85% lines | `/tmp/maestro-phase7-coverage-after-factory-marketplace-20260618102827.log` |
| Current restored App/unit coverage tranche | 4 files passed; 47 passed | `/tmp/maestro-restored-unit-current-kept-20260618090626.log` |
| Current `npm run test` | 1,174 files passed; 32,190 tests passed; 0 skipped | `/tmp/maestro-phase7-unit-after-storage-20260618004245.log` |
| Current focused mobile integration tranche | 10 files passed; 145 passed | `/tmp/maestro-mobile-integration-restored-focused-20260618082238.log` |
| Current focused web-server integration tranche | 5 files passed; 98 passed | `/tmp/maestro-restored-webserver-integration-focused-20260618074456.log` |
| Current focused Jsonl/annotator batch | 4 files passed; 13 passed | `/tmp/maestro-jsonl-annotator-focused-20260618064635.log` |
| Prior App-restore `npm run test:coverage` | failed 100% thresholds: 73.91% statements, 68.25% branches, 72.40% functions, 74.91% lines | `/tmp/maestro-phase7-coverage-after-app-restore-20260618085542.log` |
| Prior focused debug/memory batch | 2 files passed; 6 passed | `/tmp/maestro-debug-memory-focused-20260618063930.log` |
| Prior debug/memory coverage checkpoint | failed 100% thresholds: 75.36% statements, 69.43% branches, 73.71% functions, 76.45% lines | `/tmp/maestro-phase7-coverage-after-debug-memory-20260618063410.log` |
| Prior focused useAutoRun batch | 1 file passed; 19 passed | `/tmp/maestro-use-autorun-focused-20260618061618.log` |
| Prior useAutoRun coverage checkpoint | failed 100% thresholds: 75.11% statements, 69.16% branches, 73.50% functions, 76.19% lines | `/tmp/maestro-phase7-coverage-after-use-autorun-20260618061657.log` |
| Prior focused jqFilter batch | 1 file passed; 84 passed | `/tmp/maestro-jqfilter-focused-20260618060710.log` |
| Prior jqFilter coverage checkpoint | failed 100% thresholds: 75.05% statements, 69.13% branches, 73.43% functions, 76.14% lines | `/tmp/maestro-phase7-coverage-after-jqfilter-20260618060742.log` |
| Prior focused agent/shortcut/annotator batch | 3 files passed; 11 passed | `/tmp/maestro-agent-shortcuts-annotator-focused-20260618055651.log` |
| Prior agent/shortcut coverage checkpoint | failed 100% thresholds: 74.95% statements, 68.99% branches, 73.40% functions, 76.05% lines | `/tmp/maestro-phase7-coverage-after-agent-shortcuts-20260618055718.log` |
| Prior focused annotator state batch | 1 file passed; 4 passed | `/tmp/maestro-annotator-state-focused-20260618054649.log` |
| Prior annotator state coverage checkpoint | failed 100% thresholds: 74.89% statements, 68.95% branches, 73.34% functions, 75.98% lines | `/tmp/maestro-phase7-coverage-after-annotator-state-20260618054748.log` |
| Prior focused callback/web-hooks batch | 4 files passed; 163 passed | `/tmp/maestro-callback-webhooks-focused-20260618053745.log` |
| Prior callback/web-hooks coverage checkpoint | failed 100% thresholds: 74.74% statements, 68.89% branches, 73.03% functions, 75.86% lines | `/tmp/maestro-phase7-coverage-after-callback-webhooks-20260618053801.log` |
| Prior focused preload process test batch | 1 file passed; 142 passed | `/tmp/maestro-preload-process-focused-20260618052639.log` |
| Prior preload-process coverage checkpoint | failed 100% thresholds: 74.39% statements, 68.67% branches, 72.33% functions, 75.54% lines | `/tmp/maestro-phase7-coverage-after-preload-process-20260618052654.log` |
| Prior Phase 7 restored-storage coverage | failed 100% thresholds: 69.79% statements, 64.84% branches, 66.67% functions, 70.92% lines | `/tmp/maestro-phase7-coverage-after-storage-20260618004650.log` |
| Prior post-skip-cleanup `npm run test` | 1,074 files passed; 31,302 tests passed; 0 skipped | `/tmp/maestro-phase7-unit-noskip-20260618001502.log` |
| Upstream-shaped `npm run validate:push` | format, TypeScript, ESLint, and unit execution passed; 108 unit skips | `/tmp/maestro-phase7-validate-push-20260617234110.log` |
| Upstream-shaped `npm run test:coverage` | failed 100% thresholds: 66% statements, 60.78% branches, 63.25% functions, 67.05% lines | `/tmp/maestro-upstream-overlay-test-coverage-20260617232642.log` |
| Pre-upstream-sync unit coverage checkpoint | 731 files passed, 28,679 tests passed, 100% statements/branches/functions/lines | `/tmp/maestro-final-test-coverage-20260617222450.log` |
| Pre-upstream-sync full integration with SSH | 539 files passed, 12,687 tests passed | `/tmp/maestro-integration-ssh-full-20260617220145.log` |
| Pre-upstream-sync final Phase 6 E2E shard A | 985 passed, 0 failed, 0 skipped | `/tmp/maestro-phase6-final-a.log` |
| Pre-upstream-sync final Phase 6 E2E shard B | 1,985 passed, 0 failed, 0 skipped | `/tmp/maestro-phase6-final-b.log` |
| Pre-upstream-sync combined Phase 6 E2E runtime | 2,970 passed, 0 failed, 0 skipped | `e2e-results/phase6-final-a`, `e2e-results/phase6-final-b` |

The temporary local SSH daemon used for the pre-sync integration verification was removed after that successful run.

## E2E Count Reconciliation

The campaign has three different counts that are easy to confuse:

- `3,025` is the authored active scenario matrix target. It is a coverage-planning count, not a one-to-one Playwright runtime count.
- `2,970` is the final Phase 6 runtime-expanded Playwright/Electron count: Shard A `985 passed` plus Shard B `1,985 passed`.
- Static scan of the current E2E source finds 16 spec files, 2,375 direct `test(...)` calls, 0 `test.skip(...)`, 0 `test.fixme(...)`, and 0 `test.only(...)`. Runtime-generated tests expand that source count to the 2,970 final Playwright tests.

Older `2,991` totals with `21 skipped` were Phase 5 historical runs and are superseded by the Phase 6 final proof above.

## Process And Mailer State

- `npm run test:e2e:stop` previously reported no Maestro E2E Playwright/Electron runners after cleanup.
- Current PM2 cleanup removed the temporary `maestro-integration-sshd` process.
- The old Phase 5 E2E status mailer was removed.
- The recurring Phase 6 status email cron was removed on 2026-06-18.
- `/Users/jeffscottward/.codex/scripts/maestro-phase6-status-email.mjs` now refuses to send routine email unless it is explicitly invoked with `--milestone` plus `--milestone-hours >= 6` or matching milestone environment variables.
- Legacy local Maestro mailers are also milestone-gated: `/Users/jeffscottward/.codex/scripts/maestro-e2e-status-email.mjs` and `/Users/jeffscottward/.codex/scripts/maestro-coverage-email.mjs` allow `--dry-run`, but real sends require `--milestone` plus `--milestone-hours >= 6` or matching milestone environment variables.
- `/Users/jeffscottward/.codex/scheduled-tasks/maestro-e2e-status-email.sh` now delegates to the milestone-gated E2E reporter instead of calling `mutt` directly, so stale scheduled invocations without `--milestone` skip instead of sending.
- Email cadence for the remaining campaign is major completion milestones only, roughly work blocks of 6+ hours or gates such as unit coverage complete, full integration complete, full E2E complete, or final branch handoff.

## Known Non-Active Residuals

These are not active failures or skipped Phase 6 runtime tests:

- Live provider/account-backed wizard handoff.
- Real operating-system default-app file handoff.
- Configured SSH file browsing.
- Live Symphony, GitHub, leaderboard, and backend polling paths.
- Downloadable achievement badge image verification.
- PDF page rendering.
- File-tree toolbar and multi-select product gaps.
