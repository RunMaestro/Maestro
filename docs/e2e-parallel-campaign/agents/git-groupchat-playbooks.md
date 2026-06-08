# git-groupchat-playbooks

Status: first tranche authored

## Scope

Git/worktrees/PR/diff/log/Gist, group chat, playbooks, marketplace, Spec Kit,
OpenSpec.

## Checklist

- [x] Inspect existing related E2E coverage and component surfaces.
- [x] Author deterministic active scenarios for the first tranche.
- [x] Mock network or use skipped/env-gated cases for account-backed services.
- [x] Record files touched and scenario counts.
- [x] Commit lane work on `codex/e2e-git-groupchat-playbooks`.

## Progress

First tranche:

- Added `e2e/git-groupchat-playbooks.spec.ts`.
- Active scenarios: 5.
- Skipped/product-gap scenarios: 0.
- Env-gated scenarios: 0.
- Shared helper edits: none.
- Live GitHub, provider, marketplace, and network execution: none; marketplace
  and Spec Kit/OpenSpec IPC are stubbed locally.
- Validation passed:
  - `npx eslint e2e/git-groupchat-playbooks.spec.ts`
  - `git diff --check`

Remaining work:

- Expand PR creation, worktree lifecycle, Gist publish, group chat mutation,
  marketplace import/export, and Spec Kit/OpenSpec edit/reset matrices.
- Run actual Playwright/E2E validation only after orchestrator approval.
