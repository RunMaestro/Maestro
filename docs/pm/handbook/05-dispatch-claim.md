# 05 — Dispatch & Claim

The Dispatch Engine is the subsystem that automatically picks up eligible work items and runs them through agent slots. This file explains the four roles, how claiming works, what the heartbeat is, and how to recover from stale claims.

---

## The Four Roles

| Role       | What it does                                                  | When it runs                                  |
| ---------- | ------------------------------------------------------------- | --------------------------------------------- |
| `runner`   | Implements the task from scratch                              | When AI Status=Tasks Ready and AI Role=runner |
| `fixer`    | Corrects validation errors, test failures, or review feedback | When runner output fails automated checks     |
| `reviewer` | Verifies the implementation meets acceptance criteria         | After runner (and fixer) complete             |
| `merger`   | Merges the approved PR and closes the issue                   | After reviewer approves                       |

### Role flow for a typical task

```
Tasks Ready
    │
    ▼
runner slot claims → implements → opens PR
    │
    ▼ (if validation fails)
fixer slot claims → corrects → pushes to same branch
    │
    ▼
reviewer slot claims → verifies → approves PR
    │
    ▼
merger slot claims → merges PR → closes issue → AI Status=Done
```

If there are no failures, fixer is skipped: runner → reviewer → merger.

---

## Slot Configuration

Slots are configured per-project in Maestro Settings → Symphony → Roles:

```
projectRoleSlots[projectPath] = {
  runner:   { agentId: "<session-id>", enabled: true, modelOverride?: "...", effortOverride?: "..." },
  fixer:    { agentId: "<session-id>", enabled: true },
  reviewer: { agentId: "<session-id>", enabled: true },
  merger:   { agentId: "<session-id>", enabled: true },
}
```

**agentId** references an existing Left Bar agent. The agent must have `projectRoot` matching this project and (for local projects) not be SSH-remote for the runner role.

### Runner slot constraints (hard)

1. **Local only**: the runner slot agent must be a local agent (not SSH-remote). SSH-remote agents are silently skipped for runner-role items.
2. **Project-scoped**: the runner agent's `projectRoot` must match the `git remote get-url origin` of the project.

Fixer, reviewer, and merger slots may be SSH-remote.

---

## The AI Assigned Slot Field

When a slot claims a work item, the Dispatch Engine writes the slot's ID into `AI Assigned Slot`. This prevents double-claiming: any other slot that polls and sees a non-empty `AI Assigned Slot` skips the item.

```bash
# Read who owns a claim
gh project item-list <N> --owner <OWNER> --format json \
  | jq '.items[] | {title, assignedSlot: (.fieldValues[] | select(.field.name == "AI Assigned Slot") | .value)}'
```

---

## The AI Last Heartbeat Field

While a slot is running work, it periodically writes the current ISO-8601 timestamp into `AI Last Heartbeat`. This is the liveness signal.

If a slot crashes or the process is killed, the heartbeat goes stale. The Dispatch Engine (and PM mode) uses this to detect stuck claims.

**Stale threshold**: a claim is considered stale if `AI Last Heartbeat` is more than 5 minutes in the past and `AI Status` is still `In Progress`.

```bash
# Check heartbeat on all In Progress items
gh project item-list <N> --owner <OWNER> --format json \
  | jq '.items[] | select((.fieldValues[] | select(.field.name == "AI Status") | .value) == "In Progress") | {title, heartbeat: (.fieldValues[] | select(.field.name == "AI Last Heartbeat") | .value)}'
```

---

## Manual Claim (PM-driven)

When the user says "start working on issue N" or "claim issue N":

1. Verify the issue exists and AI Status=Tasks Ready.
2. Identify which role applies (usually runner for fresh implementation).
3. Set fields:

```bash
# Set AI Status = In Progress
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> \
  --single-select-option-id <IN_PROGRESS_OPTION_ID>

# Set AI Role = runner
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_ROLE_FIELD_ID> \
  --single-select-option-id <RUNNER_OPTION_ID>

# Set AI Assigned Slot (use the actual slot ID from config, or "manual" for human work)
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_ASSIGNED_SLOT_FIELD_ID> \
  --text "manual"

# Set AI Last Heartbeat = now
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_LAST_HEARTBEAT_FIELD_ID> \
  --text "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
```

---

## Releasing a Claim

When work is done and the PR is open, the slot releases the claim by advancing AI Status:

```bash
# Advance to In Review (claim released, reviewer can now pick up)
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> \
  --single-select-option-id <IN_REVIEW_OPTION_ID>

# Clear AI Assigned Slot
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_ASSIGNED_SLOT_FIELD_ID> \
  --text ""
```

---

## Stale Claim Recovery

When the PM audit shows stale claims (heartbeat >5 min, still In Progress):

1. Confirm with user: "Issue #N has a stale claim (last heartbeat: <timestamp>). Reset to Tasks Ready?"
2. On confirm:

```bash
# Reset AI Status to Tasks Ready
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> \
  --single-select-option-id <TASKS_READY_OPTION_ID>

# Clear AI Assigned Slot
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_ASSIGNED_SLOT_FIELD_ID> \
  --text ""

# Clear AI Last Heartbeat
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_LAST_HEARTBEAT_FIELD_ID> \
  --text ""

# Add a comment explaining the reset
gh issue comment <ISSUE_NUMBER> \
  --repo <OWNER>/<REPO> \
  --body "Claim reset by PM audit — heartbeat was stale. Ready for re-dispatch."
```

3. Confirm: "Claim released. Issue #N is back to Tasks Ready."

---

## Dispatch Engine Auto-Pickup

The Dispatch Engine polls for eligible items automatically when slots are configured. It picks up items where:

- `AI Status = Tasks Ready`
- `AI Role` matches the slot's configured role
- `AI Assigned Slot` is empty
- All items in `depends_on` have `AI Status = Done`

You do not need to manually trigger dispatch. If work is not being picked up, check:

1. Is the slot enabled? (Symphony → Roles tab)
2. Is the agent session running? (check Left Bar)
3. Is `AI Assigned Slot` stuck with an old value? (stale claim — see above)
4. Are there unresolved dependencies? (check `depends_on` on the item)
