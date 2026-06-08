# git-groupchat-playbooks

Status: second tranche authored

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
- Commit: `52db7e713`.
- Validation passed:
  - `npx eslint e2e/git-groupchat-playbooks.spec.ts`
  - `git diff --check`

Remaining work:

- Expand PR creation, worktree lifecycle, Gist publish, group chat mutation,
  marketplace import/export, and Spec Kit/OpenSpec edit/reset matrices.
- Run actual Playwright/E2E validation only after orchestrator approval.
