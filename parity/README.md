# Maestro Web Parity & Bug-Fix Plan

CCPM-style project management adapted to Maestro's playbook system. Each `NNN-*.md` is a self-contained task that a Maestro agent can execute as a playbook (single-agent, fresh-session-per-task), with optional worktree isolation for parallel multi-agent runs.

## Directory layout

```
parity/                          ← top-level, tracked in git
├── README.md                    ← you are here
├── _prd/                        ← reference docs (not run as playbooks)
│   ├── 00-vision.md
│   ├── 01-execution-model.md
│   └── 02-pr-workflow.md
├── tier1-quick-wins/            ← 8 low-effort, high-value parity tasks
├── tier2-read-only-views/       ← stub — expand when tier 1 lands
├── tier3-rich-features/         ← stub
├── tier4-heavy-ipc/             ← stub
├── tier5-architecture-mismatch/ ← stub
└── bugs/                        ← 8 web-app bug fixes (parallel to tiers)
```

**Why top-level `parity/` and not `.maestro/playbooks/`?** `.maestro/` is gitignored (local Maestro state). Planning docs need to live with the code so multiple agents, multiple worktrees, and upstream maintainers can all see them.

## How to run a task as a playbook

1. **In Maestro:** open Auto Run → New Playbook
2. **Document:** point to the task file (e.g. `parity/tier1-quick-wins/001-execution-queue-mobile.md`)
3. **Prompt:** paste the [standard prompt template](#standard-playbook-prompt) below
4. **Worktree settings (recommended for parallel runs):**
   - `branchNameTemplate`: `parity/{{task-slug}}`
   - `createPROnCompletion`: `true`
   - `prTargetBranch`: `main`
5. **Run.** The agent will read the task doc, verify state, implement, test, commit, and open a PR to your fork's `main`.

For parallel multi-agent execution, launch several worktree-enabled playbooks at once — each gets an isolated branch, no merge conflicts.

For sequential single-agent execution, skip worktree settings and just run the playbook on your current branch.

## Standard playbook prompt

```
You are executing a Maestro parity/bug-fix task.

1. Read the task document at the path provided in the document list. Read it fully — context, acceptance criteria, file paths, every `- [ ]` item.
2. VERIFY STATE FIRST: this plan was authored at a point in time. Before implementing, check `git log` and the referenced files to confirm the gap/bug still exists. If the task is already done or in flight on another branch, STOP and report that — do not duplicate work.
3. Read all desktop reference files cited in the task. Match style and conventions.
4. Implement the change. Tabs for indentation. Stay strictly in scope — do not refactor adjacent code.
5. Tick off each `- [ ]` item as you complete it (edit the task doc in place).
6. Run validation: `npm run lint && npm run lint:eslint && npm run test`. Fix any failures.
7. Commit with message: `<type>(<scope>): <task title>` (e.g. `feat(web): port execution queue indicator to mobile`).
8. If `createPROnCompletion` is set, the playbook will open the PR for you. Otherwise push the branch and report the URL.

Constraints:
- Never write outside `/opt/Maestro` (except `/opt/Maestro/.maestro/playbooks/`).
- If the task balloons in scope, STOP and report — do not proceed past the listed acceptance criteria.
- If you discover a related bug or gap not covered by this task, note it in a "Follow-ups" section at the bottom of the task doc and keep going.
```

## Status tracking

| Tier                           | Tasks | Status  |
| ------------------------------ | ----- | ------- |
| Tier 1 — Quick wins            | 8     | planned |
| Tier 2 — Read-only views       | TBD   | stubbed |
| Tier 3 — Rich features         | TBD   | stubbed |
| Tier 4 — Heavy IPC             | TBD   | stubbed |
| Tier 5 — Architecture mismatch | TBD   | stubbed |
| Bugs                           | 8     | planned |

Update task status by ticking items in each task doc. Update tier status here once a tier is fully complete.

## Important: this plan is a snapshot

Items here were inferred from a point-in-time read of the codebase. The Maestro web app is actively maintained (PRs every 1-2 weeks). **Every executing agent must verify state before implementing** — the verify-first step in the standard prompt is non-negotiable. If you find a task is stale, mark it `~~obsolete~~` in the epic and move on.
