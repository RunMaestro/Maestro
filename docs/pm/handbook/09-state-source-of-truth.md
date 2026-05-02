# 09 — State Source of Truth

The most important rule in the Maestro PM system: **GitHub Projects v2 custom fields are the sole source of truth for all dispatch and lifecycle state**. Not labels. Not issue comments. Not local files. Custom fields.

This file explains why this matters, what the rule means in practice, and what anti-patterns to avoid.

---

## The Rule

> Read and write `AI Status`, `AI Role`, `AI Stage`, `AI Priority`, `AI Assigned Slot`, `AI Last Heartbeat`, `AI Parent PRD`, `AI Parent Epic`, and `External Mirror ID` on GitHub Projects v2 items.
>
> Do NOT read or write GitHub labels for any state-related purpose.

---

## Why Custom Fields, Not Labels

Labels are repo-scoped. Custom fields are project-scoped. The Dispatch Engine reads project items, not issue labels. When you set a label, the engine doesn't see it. When you set the `AI Status` custom field, the engine immediately responds.

Labels are also human-writable by anyone with repo access, which creates state drift. Custom fields can be set programmatically with `gh project item-edit`, giving the Dispatch Engine and PM mode a reliable, authoritative signal.

### Historical context

The old Symphony fork-runner (pre-#444 refactor) used `agent:*` labels:

- `agent:ready` — issue is ready for an agent to pick up
- `agent:running` — an agent has claimed the issue
- `agent:review` — agent has finished, PR is open
- `agent:failed-validation` — agent output failed checks

These labels are now **decorative and ignored**. The Dispatch Engine logs a warning if it sees them, but does not act on them. If you set `agent:ready` on an issue, nothing will happen. The engine will not pick it up.

---

## What Each Field Controls

### `AI Status` — lifecycle gate

This is the primary dispatch signal. The Dispatch Engine queries `AI Status` to determine what to do next.

| AI Status       | What the engine does                             |
| --------------- | ------------------------------------------------ |
| Tasks Ready     | Eligible for dispatch to a slot matching AI Role |
| In Progress     | Work is claimed — engine does not re-dispatch    |
| In Review       | Waiting for reviewer slot                        |
| Blocked         | Engine skips; waits for human to unblock         |
| Done            | Terminal — engine ignores                        |
| Everything else | Engine ignores                                   |

### `AI Role` — which slot picks up

When `AI Status = Tasks Ready`, the engine matches the item's `AI Role` to the configured slot roles:

- `runner` → runner slot picks up
- `fixer` → fixer slot picks up
- `reviewer` → reviewer slot picks up
- `merger` → merger slot picks up

If no slot is configured for the item's AI Role, the item stays unclaimed.

### `AI Assigned Slot` — exclusive claim

Non-empty = item is claimed. The engine uses this to prevent double-dispatch. Only one slot can own a claim at a time.

### `AI Last Heartbeat` — liveness signal

Written by the slot every ~30 seconds while work is running. Used by PM audit to detect crashed agents. Not read by the Dispatch Engine itself — it's a monitoring field.

### `AI Stage` — item type

Distinguishes PRD items (`prd`), epic items (`epic`), and task items (`task`). Used for filtering and hierarchy navigation. Does not directly control dispatch.

### `AI Priority` — ordering

Used by the PM and Dispatch Engine to prioritize which Tasks Ready items to dispatch first. P0 > P1 > P2 > P3.

### `AI Parent PRD` / `AI Parent Epic` — hierarchy

Links a task item back to its epic and PRD. Used for:

- Epic completion checks (are all child tasks Done?)
- Status roll-ups (how far along is this PRD?)
- Filtering (show me all tasks for this epic)

---

## Anti-Patterns — What NOT to Do

### Anti-pattern: Setting `agent:*` labels

```bash
# WRONG — this does nothing
gh issue edit 42 --add-label "agent:ready" --repo owner/repo

# CORRECT
gh project item-edit --id <ITEM_ID> ... --single-select-option-id <TASKS_READY_OPTION_ID>
```

### Anti-pattern: Using issue state as lifecycle state

```bash
# WRONG — closing an issue does not set AI Status = Done
gh issue close 42 --repo owner/repo

# CORRECT — set the field, then (optionally) close the issue
gh project item-edit --id <ITEM_ID> ... --single-select-option-id <DONE_OPTION_ID>
gh issue close 42 --repo owner/repo  # optional cleanup
```

### Anti-pattern: Tracking progress in a local file

Don't maintain a `status.json` or similar file that duplicates what's in the project. The project IS the state. If it gets out of sync with a local file, the Dispatch Engine will behave unexpectedly.

### Anti-pattern: Using the human `Status` field

The GitHub project has a built-in `Status` field that controls the kanban column. This is for humans to drag cards around. The Dispatch Engine does NOT read or write the `Status` field — only `AI Status`. Do not confuse them.

```bash
# WRONG — this sets the human kanban column, not the dispatch state
gh project item-edit --id <ITEM_ID> --field-id <STATUS_FIELD_ID> ...

# CORRECT — always use the AI Status field
gh project item-edit --id <ITEM_ID> --field-id <AI_STATUS_FIELD_ID> ...
```

To tell them apart: the human `Status` field has an id that looks like `PVTSSF_<hash>` but its name in `gh project field-list` output will be `Status` (not `AI Status`). Always filter for `"AI Status"` by name.

---

## Checking Current State Correctly

```bash
# Correct way to read state
gh project item-list <N> --owner <OWNER> --format json \
  | jq '.items[] | {title, aiStatus: (.fieldValues[] | select(.field.name == "AI Status") | .value)}'

# Wrong — reading issue labels
gh issue view 42 --repo owner/repo --json labels  # DO NOT use for dispatch state
```

---

## Summary Table

| What you want to know           | Where to look             | NOT here                   |
| ------------------------------- | ------------------------- | -------------------------- |
| Is this item ready to dispatch? | `AI Status = Tasks Ready` | Issue labels               |
| Who owns the claim?             | `AI Assigned Slot`        | Assignees                  |
| Is the claim alive?             | `AI Last Heartbeat`       | Issue comments             |
| What role picks this up?        | `AI Role`                 | Labels like `needs-review` |
| Is this task or PRD?            | `AI Stage`                | Issue type                 |
| What's the priority?            | `AI Priority`             | Labels like `p1`, `urgent` |
| What epic does this belong to?  | `AI Parent Epic`          | Issue milestone            |
