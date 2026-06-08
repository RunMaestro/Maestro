# git-groupchat-playbooks

Status: fourth recovery tranche authored

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

Remaining work:

- Expand remaining Git diff/log details, PR failure variants, Gist modal coverage,
  group chat mutation/history, marketplace import/export edge cases, and
  Spec Kit/OpenSpec refresh/failure matrices.
- Continue from 338 remaining matrix-backed active scenarios after this recovery
  tranche.
- Run actual Playwright/E2E validation only after orchestrator approval.
