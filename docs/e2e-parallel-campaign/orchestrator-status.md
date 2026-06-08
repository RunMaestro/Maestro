# Parallel E2E Orchestrator Status

Last updated: 2026-06-08

## Base

- Campaign branch: `codex/full-e2e-coverage-campaign`
- Base commit before orchestration scaffold: `2da497d49`
- Prompt file normalized to: `docs/e2e-parallel-prompt.md`
- Worktree root: `/Users/jeffscottward/Github/tools/Maestro-worktrees`
- No E2E execution is allowed in this authoring phase.

## Dirty Work Preservation

The current worktree contained in-flight coverage work before orchestration.
These files were inspected and left unstashed/uncommitted by the orchestrator
because ownership could not be confirmed interactively:

- `docs/e2e-coverage-campaign.md`
- `e2e/app-shell.spec.ts`
- `e2e/web-mobile.spec.ts`
- `src/renderer/components/AgentSessionsBrowser.tsx`
- `src/renderer/components/NewInstanceModal.tsx`
- `src/web/hooks/useMobileSessionManagement.ts`

Lane worktrees are branched from committed `HEAD`, so this dirty work stays
preserved in the primary worktree and does not leak into parallel branches.

## Lane State

| Lane | Branch | Worktree | PM2 process | State | Notes |
| --- | --- | --- | --- | --- | --- |
| `agent-crud-provider` | `codex/e2e-agent-crud-provider` | `Maestro-worktrees/e2e-agent-crud-provider` | `maestro-e2e-agent-crud-provider` | pending launch | Agent CRUD/provider/Agent Sessions |
| `shell-tabs-command` | `codex/e2e-shell-tabs-command` | `Maestro-worktrees/e2e-shell-tabs-command` | `maestro-e2e-shell-tabs-command` | pending launch | Matrix-backed quota is 266; prompt typo notes 366 |
| `files-docs-history` | `codex/e2e-files-docs-history` | `Maestro-worktrees/e2e-files-docs-history` | `maestro-e2e-files-docs-history` | pending launch | Files, preview, history |
| `autorun-ai-terminal` | `codex/e2e-autorun-ai-terminal` | `Maestro-worktrees/e2e-autorun-ai-terminal` | `maestro-e2e-autorun-ai-terminal` | pending launch | Auto Run and Codex AI terminal |
| `wizard-settings-prompts` | `codex/e2e-wizard-settings-prompts` | `Maestro-worktrees/e2e-wizard-settings-prompts` | `maestro-e2e-wizard-settings-prompts` | pending launch | Wizard, settings, prompt surfaces |
| `git-groupchat-playbooks` | `codex/e2e-git-groupchat-playbooks` | `Maestro-worktrees/e2e-git-groupchat-playbooks` | `maestro-e2e-git-groupchat-playbooks` | pending launch | Git, group chat, playbooks |
| `stats-graph-symphony` | `codex/e2e-stats-graph-symphony` | `Maestro-worktrees/e2e-stats-graph-symphony` | `maestro-e2e-stats-graph-symphony` | pending launch | Stats, graph, Symphony |
| `debug-accessibility` | `codex/e2e-debug-accessibility` | `Maestro-worktrees/e2e-debug-accessibility` | `maestro-e2e-debug-accessibility` | pending launch | Debug modals, confirmations, a11y smoke |
| `mobile-web-bridge` | `codex/e2e-mobile-web-bridge` | `Maestro-worktrees/e2e-mobile-web-bridge` | `maestro-e2e-mobile-web-bridge` | pending launch | Mobile/web bridge |
| `fixtures-sharding-review` | `codex/e2e-fixtures-sharding-review` | `Maestro-worktrees/e2e-fixtures-sharding-review` | `maestro-e2e-fixtures-sharding-review` | pending launch | Shared fixtures and review |

## Merge Queue

No lane branches have been merged yet.

## Blockers

- User is unavailable, so existing dirty work was preserved by isolation instead
  of checkpoint-stashed or checkpoint-committed wholesale.
- The source prompt has a lane-quota inconsistency for `shell-tabs-command`.
  The canonical matrix remains authoritative until changed deliberately.
