# PRD 01 — Execution Model

How tasks in this plan get executed by Maestro agents.

## Three execution modes

### A. Sequential single-agent

Run one playbook at a time on your current branch. Agent executes tasks in document order, fresh session per task. Best for: early sanity-check runs, tasks with shared touchpoints (e.g. multiple changes to the same component).

**Setup:** No worktree settings. Run playbook normally.

### B. Worktree-parallel multi-agent

Each task gets its own playbook run on its own git worktree (its own branch, its own checkout). Multiple Maestro agents execute simultaneously on different worktrees. Best for: independent tasks with no shared file changes (most of Tier 1).

**Setup per playbook:**

```json
{
	"worktreeSettings": {
		"branchNameTemplate": "parity/{{task-slug}}",
		"createPROnCompletion": true,
		"prTargetBranch": "main"
	}
}
```

**Coordinator pattern:** open N agents in Maestro, kick off one playbook per agent pointed at different task docs. They run concurrently in their own worktrees.

### C. Subagent fan-out within a task

A single playbook task where the executing agent uses the `Task` tool (Claude Code's subagent system) to parallelize _within_ the task — e.g. "research file X, file Y, file Z in parallel, then implement." This is up to the executing agent; not something we configure at the playbook level.

## Recommended mode per tier

| Tier / Lane            | Recommended mode                                                  | Why                                                                |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| Tier 1 quick wins      | **B (worktree-parallel)**                                         | Tasks are independent UI components, perfect for parallel branches |
| Tier 2 read-only views | B with one exception (file preview tasks share `FilePreview.tsx`) | Mostly independent                                                 |
| Tier 3 rich features   | **A (sequential)**                                                | Higher complexity, more chance of conflicts                        |
| Tier 4 heavy IPC       | A                                                                 | Deep architectural changes — review one at a time                  |
| Bugs                   | **B for P0/P1, A for P2**                                         | Bugs are independent fixes; ship them parallel                     |

## Conflict avoidance

Before launching parallel runs, scan the task docs for shared file paths. If two tasks both edit (e.g.) `src/web/mobile/SessionStatusBanner.tsx`, run them sequentially to avoid merge headaches.

The epic for each tier flags known shared touchpoints in its "Dependencies" section.

## Validation per task

Every task ends with:

```bash
npm run lint && npm run lint:eslint && npm run test
```

If any fails, the agent must fix it before the playbook completes. Worktree mode opens the PR automatically; you do final visual review in browser.
