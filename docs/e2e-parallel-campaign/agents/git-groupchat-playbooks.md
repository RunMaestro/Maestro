# git-groupchat-playbooks

Status: sixth fallback tranche authored

## Scope

Git/worktrees/PR/diff/log/Gist, group chat, playbooks, marketplace, Spec Kit,
OpenSpec.

## Checklist

- [x] Inspect existing related E2E coverage and component surfaces.
- [x] Author deterministic active scenarios for the first tranche.
- [x] Mock network or use skipped/env-gated cases for account-backed services.
- [x] Record files touched and scenario counts.
- [x] Commit first tranche on `codex/e2e-git-groupchat-playbooks`.
- [x] Commit second tranche on `codex/e2e-git-groupchat-playbooks`.
- [x] Commit third tranche on `codex/e2e-git-groupchat-playbooks`.
- [x] Commit fourth recovery tranche on `codex/e2e-git-groupchat-playbooks`.
- [x] Commit fifth fallback tranche on `codex/e2e-git-groupchat-playbooks`.
- [x] Commit sixth fallback tranche on `codex/e2e-git-groupchat-playbooks-fallback-2`.

## Progress

First tranche:

- Added `e2e/git-groupchat-playbooks.spec.ts`.
- Active scenarios: 5.
- Skipped/product-gap scenarios: 0.
- Env-gated scenarios: 0.
- Shared helper edits: none.
- Live GitHub, provider, marketplace, and network execution: none; marketplace
  and Spec Kit/OpenSpec IPC are stubbed locally.
- Commit: `f56007a23` (accepted by orchestrator before recovery continuation).
- Validation passed:
  - `npx eslint e2e/git-groupchat-playbooks.spec.ts`
  - `git diff --check`

Second tranche:

- Extended `e2e/git-groupchat-playbooks.spec.ts`.
- Active scenarios added: 6 (`GGP-A06` through `GGP-A11`).
- Skipped/env-gated rows added: 3 (`GGP-S01` through `GGP-S03`).
- Cumulative active scenarios authored in this lane: 11.
- Cumulative skipped/env-gated scenarios authored in this lane: 3.
- Matrix-backed active scenarios still remaining: 352.
- Files touched:
  - `e2e/git-groupchat-playbooks.spec.ts`
  - `docs/e2e-parallel-campaign/agents/git-groupchat-playbooks.md`
- Coverage added:
  - Git Log IPC error fallback.
  - Git Log empty repository state.
  - Playbook Exchange manifest failure and retry recovery.
  - Playbook Exchange empty manifest state.
  - Marketplace README/document missing-content fallbacks.
  - Spec Kit/OpenSpec failed IPC load empty states.
- Skipped/env-gated blockers:
  - Real GitHub PR creation needs authenticated `gh` and live network.
  - Real Gist publishing needs authenticated `gh` and live network.
  - Live marketplace refresh needs network-backed GitHub state.
- Shared helper edits: none; `broadcasts.md` unchanged.
- Live GitHub, marketplace network, provider, headed/UI E2E, and full E2E
  execution: none.
- Commit: `365727129`.
- Validation passed:
  - `npx eslint e2e/git-groupchat-playbooks.spec.ts`
  - `git diff --check`

Third tranche:

- Extended `e2e/git-groupchat-playbooks.spec.ts`.
- Active scenarios added: 7 (`GGP-A12` through `GGP-A18`).
- Skipped/env-gated rows added: 2 (`GGP-S04` through `GGP-S05`).
- Cumulative active scenarios authored in this lane: 18.
- Cumulative skipped/env-gated scenarios authored in this lane: 5.
- Matrix-backed active scenarios still remaining: 345.
- Files touched:
  - `e2e/git-groupchat-playbooks.spec.ts`
  - `docs/e2e-parallel-campaign/agents/git-groupchat-playbooks.md`
- Coverage added:
  - Worktree child Create PR Quick Actions visibility.
  - Create PR authenticated and unauthenticated stub paths.
  - Quick worktree branch-name validation.
  - Playbook Exchange import success with recorded IPC payload.
  - Spec Kit prompt edit/reset path.
  - OpenSpec prompt edit/reset path.
- Skipped/env-gated blockers:
  - Existing Gist URL open requires authenticated gh state because the UI affordance
    is hidden without gh availability.
  - Remote marketplace import requires configured SSH remote state and remote
    filesystem access.
- Shared helper edits: none; `broadcasts.md` unchanged.
- Live GitHub, Gist publishing, marketplace network, SSH remote, provider,
  headed/UI E2E, and full E2E execution: none.
- Commit: `811681847`.
- Validation passed:
  - `npx eslint e2e/git-groupchat-playbooks.spec.ts`
  - `git diff --check`

Fourth recovery tranche:

- Extended `e2e/git-groupchat-playbooks.spec.ts`.
- Active scenarios added: 7 (`GGP-A19` through `GGP-A25`).
- Skipped/env-gated rows added: 2 (`GGP-S06` through `GGP-S07`).
- Cumulative active scenarios authored in this lane: 25.
- Cumulative skipped/env-gated scenarios authored in this lane: 7.
- Matrix-backed active scenarios still remaining: 338.
- Files touched:
  - `e2e/git-groupchat-playbooks.spec.ts`
  - `docs/e2e-parallel-campaign/agents/git-groupchat-playbooks.md`
- Coverage added:
  - Git Log commit refs, body, file stats, and parsed diff preview.
  - GitHub CLI missing-install guidance in Create Pull Request.
  - Create Pull Request failure state with stubbed gh error/link rendering.
  - Playbook Exchange category/search filtering.
  - Marketplace import target-folder validation.
  - Spec Kit metadata refresh from IPC stubs.
  - OpenSpec metadata refresh from IPC stubs.
- Skipped/env-gated blockers:
  - Live multi-agent group chat fan-in requires provider accounts and real agent
    launches.
  - Live Spec Kit/OpenSpec refresh requires GitHub network access.
- Shared helper edits: none; `broadcasts.md` unchanged.
- Live GitHub, Gist publishing, marketplace network, SSH remote, provider,
  headed/UI E2E, Playwright list, and full E2E execution: none.
- Commit: `06cbac9f3`.
- Validation passed:
  - `npx eslint e2e/git-groupchat-playbooks.spec.ts`
  - `git diff --check`

Fifth fallback tranche:

- Extended `e2e/git-groupchat-playbooks.spec.ts`.
- PM2 context:
  - `maestro-e2e-git-groupchat-playbooks-t7` was launched as a one-shot worker
    with `--no-autorestart`.
  - It exited before edits with Codex managed-account 503 errors from model
    refresh and `/responses`.
- Active scenarios added: 5 (`GGP-A26` through `GGP-A30`).
- Skipped/env-gated rows added: 0.
- Cumulative active scenarios authored in this lane: 30.
- Cumulative skipped/env-gated scenarios authored in this lane: 7.
- Matrix-backed active scenarios still remaining: 333.
- Files touched:
  - `e2e/git-groupchat-playbooks.spec.ts`
  - `docs/e2e-parallel-campaign/agents/git-groupchat-playbooks.md`
- Coverage added:
  - Create Pull Request target-branch selection before stubbed submission.
  - Create Pull Request cancel path without submitting IPC payload.
  - Playbook Exchange marketplace document preview.
  - Playbook Exchange full import payload recording.
  - Quick Actions filtering to a seeded group chat result.
- Skipped/env-gated blockers: unchanged.
- Shared helper edits: none; `broadcasts.md` unchanged.
- Live GitHub, Gist publishing, marketplace network, SSH remote, provider,
  headed/UI E2E, Playwright list, and full E2E execution: none.
- Commit: `b5e623c04`.
- Validation passed:
  - `npx prettier --write e2e/git-groupchat-playbooks.spec.ts`
  - `npx eslint e2e/git-groupchat-playbooks.spec.ts`
  - `npx tsc --noEmit --target ES2020 --lib ES2020,DOM,DOM.Iterable --module ESNext --skipLibCheck --moduleResolution bundler --allowImportingTsExtensions --resolveJsonModule --isolatedModules --strict --noUnusedLocals --noUnusedParameters --noFallthroughCasesInSwitch --types node,@playwright/test e2e/git-groupchat-playbooks.spec.ts e2e/fixtures/electron-app.ts`
  - `git diff --check -- e2e/git-groupchat-playbooks.spec.ts`
  - Static Git/group-chat/playbooks spec ID/`.only` scan.
- Review:
  - Focused code review found no critical or high issues.

Sixth fallback tranche:

- Extended `e2e/git-groupchat-playbooks.spec.ts`.
- Active scenarios added: 5 (`GGP-A31` through `GGP-A35`).
- Skipped/env-gated rows added: 0.
- Cumulative active scenarios authored in this lane: 35.
- Cumulative skipped/env-gated scenarios authored in this lane: 7.
- Matrix-backed active scenarios still remaining: 328.
- Files touched:
  - `e2e/git-groupchat-playbooks.spec.ts`
  - `docs/e2e-parallel-campaign/agents/git-groupchat-playbooks.md`
- Coverage added:
  - Multi-file Git Diff tabs from a stubbed IPC diff.
  - Group Chat header metadata after Quick Actions navigation.
  - Active Group Chat management commands in Quick Actions.
  - Playbook Exchange loop settings for a category-filtered playbook.
  - Spec Kit prompt edit cancellation without marking the command modified.
- Skipped/env-gated blockers: unchanged.
- Shared helper edits: none; `broadcasts.md` unchanged.
- Live GitHub, Gist publishing, marketplace network, SSH remote, provider,
  headed/UI E2E, Playwright list, and full E2E execution: none.
- Commit: `705b731a7`.
- Validation passed:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --check e2e/git-groupchat-playbooks.spec.ts`
  - `npx eslint e2e/git-groupchat-playbooks.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - Static Git/group-chat/playbooks spec ID/`.only` scan.
  - `git diff --check`
- Review:
  - Focused code review found no critical or high issues; E2E execution remains deferred.

Seventh fallback tranche:

- Extended `e2e/git-groupchat-playbooks.spec.ts`.
- Active scenarios added: 5 (`GGP-A36` through `GGP-A40`).
- Skipped/env-gated rows added: 0.
- Cumulative active scenarios authored in this lane: 40.
- Cumulative skipped/env-gated scenarios authored in this lane: 7.
- Matrix-backed active scenarios still remaining: 323.
- Files touched:
  - `e2e/git-groupchat-playbooks.spec.ts`
  - `docs/e2e-parallel-campaign/agents/git-groupchat-playbooks.md`
- Coverage added:
  - Git Diff empty state from stubbed IPC output.
  - Playbook Exchange help popover open/close behavior.
  - Playbook Exchange cache refresh status from cached to live.
  - OpenSpec prompt edit cancellation without marking the command modified.
  - Create Pull Request disabled state when the PR title is cleared.
- Skipped/env-gated blockers: unchanged.
- Shared helper edits: none; `broadcasts.md` unchanged.
- Live GitHub, Gist publishing, marketplace network, SSH remote, provider,
  headed/UI E2E, Playwright list, and full E2E execution: none.
- Commit: `035001d86`.
- Validation passed:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --check e2e/git-groupchat-playbooks.spec.ts docs/e2e-parallel-campaign/agents/git-groupchat-playbooks.md`
  - `npx eslint e2e/git-groupchat-playbooks.spec.ts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - Static Git/group-chat/playbooks spec ID/`.only` scan.
  - `git diff --check -- e2e/git-groupchat-playbooks.spec.ts docs/e2e-parallel-campaign/agents/git-groupchat-playbooks.md`
- Review:
  - Focused static review found one high-risk stale prompt assertion; fixed before
    commit. No critical issues remain; E2E execution remains deferred.

Eighth fallback tranche:

- Extended `e2e/git-groupchat-playbooks.spec.ts`.
- Active scenarios added: 5 (`GGP-A41` through `GGP-A45`).
- Skipped/env-gated rows added: 0.
- Cumulative active scenarios authored in this lane: 45.
- Cumulative skipped/env-gated scenarios authored in this lane: 7.
- Matrix-backed active scenarios still remaining: 318.
- Files touched:
  - `e2e/git-groupchat-playbooks.spec.ts`
  - `docs/e2e-parallel-campaign/agents/git-groupchat-playbooks.md`
- Coverage added:
  - Create Pull Request branch defaults, generated title, and dirty-work warning.
  - Create Pull Request non-URL failure state without closing the modal.
  - Playbook Exchange detail-view back navigation to a filtered list.
  - Playbook Exchange keyboard search focus and Escape containment.
  - Playbook Exchange detail-view document cycling with keyboard shortcuts.
- Skipped/env-gated blockers: unchanged.
- Shared helper edits: none; `broadcasts.md` unchanged.
- Live GitHub, Gist publishing, marketplace network, SSH remote, provider,
  headed/UI E2E, Playwright list, and full E2E execution: none.
- Commit: `ac81d7b1f`.
- Validation passed:
  - `NODE_OPTIONS=--max-old-space-size=8192 npx prettier --write e2e/git-groupchat-playbooks.spec.ts`
  - `npx eslint e2e/git-groupchat-playbooks.spec.ts`
  - `npm run build:prompts`
  - `npx tsc -p tsconfig.lint.json --noEmit`
  - Static Git/group-chat/playbooks spec ID/`.only` scan.
  - `git diff --check -- e2e/git-groupchat-playbooks.spec.ts`
- Review:
  - Focused static review found no critical or high issues; E2E execution remains
    deferred.

Remaining work:

- Expand remaining Git diff/log details, PR failure variants, Gist modal coverage,
  group chat mutation/history, marketplace import/export edge cases, and
  Spec Kit/OpenSpec refresh/failure matrices.
- Continue from 318 remaining matrix-backed active scenarios after this recovery
  fallback tranche.
- Run actual Playwright/E2E validation only after orchestrator approval.
