# 08 — Blocked Items & Recovery

Blocked items are the most common cause of delivery stalls. This file covers how to mark items blocked, how to unstick them, how to recover from stale claims, and how to run the legacy label migration.

---

## Marking an Item Blocked

When the user says "issue N is blocked" or "we're stuck on N":

```bash
# Set AI Status = Blocked
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> \
  --single-select-option-id <BLOCKED_OPTION_ID>

# Clear AI Assigned Slot (release the claim)
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_ASSIGNED_SLOT_FIELD_ID> \
  --text ""

# Document the blocking reason on the issue
gh issue comment <ISSUE_NUMBER> \
  --repo <OWNER>/<REPO> \
  --body "**Blocked** — <specific reason, e.g., 'waiting on Stripe API key from @user' or 'depends on #52 which is not yet Done'>"
```

Confirm to the user: "Issue #N set to Blocked. Blocking reason recorded in issue comments."

---

## Unblocking an Item

When the blocker is resolved:

```bash
# Reset to previous state (usually Tasks Ready, unless it was In Progress before)
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> \
  --single-select-option-id <TASKS_READY_OPTION_ID>

# Comment that it's unblocked
gh issue comment <ISSUE_NUMBER> \
  --repo <OWNER>/<REPO> \
  --body "**Unblocked** — <what resolved the block>. Ready for dispatch."
```

If the item was In Progress when it got blocked and the slot is still running, set it back to In Progress (not Tasks Ready) — the work didn't stop, just paused.

---

## Stale Claim Audit

A stale claim is: `AI Status = In Progress` + `AI Last Heartbeat` timestamp is >5 minutes old.

### How to find stale claims

```bash
# Get all In Progress items
gh project item-list <PROJECT_NUMBER> \
  --owner <OWNER> \
  --format json \
  | jq '.items[] | select((.fieldValues[] | select(.field.name == "AI Status") | .value) == "In Progress") | {
      title,
      url: .content.url,
      slot: (.fieldValues[] | select(.field.name == "AI Assigned Slot") | .value // ""),
      heartbeat: (.fieldValues[] | select(.field.name == "AI Last Heartbeat") | .value // "")
    }'
```

Compare each heartbeat to current time. If delta >5 minutes, it's stale.

### Resetting a stale claim

Confirm with user before resetting:
"Issue #N has a stale claim (last heartbeat: <timestamp>, <N> minutes ago). The agent may have crashed or been killed. Reset to Tasks Ready?"

On confirm:

```bash
# Reset to Tasks Ready
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

# Document the reset
gh issue comment <ISSUE_NUMBER> \
  --repo <OWNER>/<REPO> \
  --body "Stale claim reset by PM audit (heartbeat was $(( ($(date +%s) - $(date -d '<heartbeat>' +%s 2>/dev/null || echo 0)) / 60 )) minutes old). Ready for re-dispatch."
```

---

## Dependency Blockers

Sometimes an item is blocked because its `depends_on` items are not Done yet. This is a configuration issue, not a crash.

### Check dependency state

```bash
# For a task with depends_on: [42, 43]
gh issue view 42 --repo <OWNER>/<REPO> --json state,title
gh issue view 43 --repo <OWNER>/<REPO> --json state,title
```

If the blocking issue is closed but the project item still shows Tasks Ready (not Done), the project item state may be stale. Fix:

```bash
gh project item-edit \
  --id <DEP_ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> \
  --single-select-option-id <DONE_OPTION_ID>
```

Then the Dispatch Engine will see the dependency is satisfied and dispatch the waiting item.

---

## Legacy Label Migration (`/PM migrate-labels`)

Old repos may have `agent:*` labels that were set by a previous version of the Symphony fork-runner. These labels are ignored by the current Dispatch Engine, but they create confusion.

### Labels that need migration

| Legacy label              | Maps to AI Status |
| ------------------------- | ----------------- |
| `agent:ready`             | `Tasks Ready`     |
| `agent:running`           | `In Progress`     |
| `agent:review`            | `In Review`       |
| `agent:failed-validation` | `Blocked`         |

### How to migrate

The `/PM migrate-labels` command calls the Maestro IPC `pm:migrateLegacyLabels` handler, which:

1. Queries all issues in the repo with `agent:*` labels
2. For each, sets the corresponding AI Status on the project item
3. Removes the `agent:*` label from the issue

To trigger from PM mode:
"Run `/PM migrate-labels`" or "migrate the legacy labels".

The handler is in `src/main/ipc/handlers/pm-migrate-labels.ts`. Requires the `deliveryPlanner` Encore feature flag.

### After migration

Verify no issues still have `agent:*` labels:

```bash
gh issue list \
  --repo <OWNER>/<REPO> \
  --label "agent:ready" \
  --json number,title

gh issue list \
  --repo <OWNER>/<REPO> \
  --label "agent:running" \
  --json number,title
```

If any remain, the migration was incomplete. Check the Maestro log for errors.

After confirming no labels remain, delete the labels from the repo:

```bash
gh label delete "agent:ready" --repo <OWNER>/<REPO> --yes
gh label delete "agent:running" --repo <OWNER>/<REPO> --yes
gh label delete "agent:review" --repo <OWNER>/<REPO> --yes
gh label delete "agent:failed-validation" --repo <OWNER>/<REPO> --yes
```

---

## Common Recovery Scenarios

### "The runner finished but AI Status is still In Progress"

The slot may have crashed before releasing the claim. Reset:

1. Check if a PR was opened: `gh pr list --repo <OWNER>/<REPO> --state open`
2. If PR exists: set AI Status = In Review, clear slot, set AI Role = reviewer
3. If no PR: set AI Status = Tasks Ready (re-dispatch runner), clear slot

### "Two agents both claimed the same item"

GitHub Projects v2 fields are not transactional. Double-claims can happen under race conditions.

Recovery:

1. Identify which agent produced better output (check the issue comments)
2. Keep that one; reset the other by setting its AI Status back to appropriate state
3. Clear `AI Assigned Slot`
4. Add a comment explaining what happened

### "Merger merged but AI Status is still In Review"

The merger slot may have merged without setting the field. Fix manually:

```bash
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> \
  --single-select-option-id <DONE_OPTION_ID>
```

### "Issue is Done but epic is still In Progress"

Check if all sibling tasks are Done (see handbook/06-review-merge.md). If yes, set the epic to Done manually.
