# 06 — Review & Merge

After the runner (and fixer, if needed) completes work, the delivery pipeline enters the review phase. This file covers how AI Status transitions through In Review to Done, what the reviewer slot does, and how the merger slot ships the change.

---

## Trigger

The review phase starts when:

- The runner slot opens a PR and sets AI Status=In Review, OR
- The user says "PR is open for issue N" / "review issue N"

---

## AI Status Transitions in This Phase

```
In Progress
    │
    ▼ (runner opens PR)
In Review         ← reviewer slot picks up here
    │
    ├──► In Progress (regression found — reviewer sends back)
    │
    ▼ (reviewer approves)
Done              ← merger slot merges PR, closes issue, sets Done
```

---

## Setting AI Status = In Review

When the runner finishes and opens a PR:

```bash
# Advance to In Review
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> \
  --single-select-option-id <IN_REVIEW_OPTION_ID>

# Set AI Role = reviewer (so the reviewer slot recognizes it)
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_ROLE_FIELD_ID> \
  --single-select-option-id <REVIEWER_OPTION_ID>

# Clear AI Assigned Slot (runner releases)
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_ASSIGNED_SLOT_FIELD_ID> \
  --text ""
```

---

## Reviewer Slot Behavior

The reviewer slot picks up items where:

- `AI Status = In Review`
- `AI Role = reviewer`
- `AI Assigned Slot` is empty

The reviewer slot:

1. Claims the item (sets AI Assigned Slot, updates heartbeat)
2. Reads the PR diff
3. Runs any available automated checks: `gh pr checks <N>`
4. Verifies each acceptance criterion from the original task
5. Either approves: `gh pr review <N> --approve` and advances to merger role
6. Or requests changes: posts review comment, sets AI Status back to In Progress (fixer picks up)

---

## Manual Review (PM-driven)

If no reviewer slot is configured, or the user wants to review manually:

```bash
# View the PR
gh pr view <PR_NUMBER> --repo <OWNER>/<REPO>

# Check CI status
gh pr checks <PR_NUMBER> --repo <OWNER>/<REPO>

# Approve
gh pr review <PR_NUMBER> --repo <OWNER>/<REPO> --approve

# Request changes (send back to fixer)
gh pr review <PR_NUMBER> --repo <OWNER>/<REPO> \
  --request-changes \
  --body "<What needs to be fixed>"

# After requesting changes, reset dispatch state
gh project item-edit --id <ITEM_ID> ... --single-select-option-id <IN_PROGRESS_OPTION_ID>
gh project item-edit --id <ITEM_ID> ... (set AI Role = fixer)
```

---

## Merger Slot Behavior

The merger slot picks up items where:

- PR is approved (no pending review requests)
- `AI Status = In Review`
- `AI Role = merger`
- `AI Assigned Slot` is empty

The merger slot:

1. Claims the item
2. Verifies the PR has at least one approval and CI is green: `gh pr checks <N>`
3. Merges: `gh pr merge <N> --squash --delete-branch --repo <OWNER>/<REPO>`
4. Closes the issue if not auto-closed: `gh issue close <N> --repo <OWNER>/<REPO>`
5. Sets AI Status = Done on the project item
6. Releases claim

---

## Manual Merge (PM-driven)

```bash
# Verify checks pass
gh pr checks <PR_NUMBER> --repo <OWNER>/<REPO>

# Merge (squash by default — matches one-commit-per-issue convention)
gh pr merge <PR_NUMBER> \
  --repo <OWNER>/<REPO> \
  --squash \
  --delete-branch

# Set AI Status = Done
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> \
  --single-select-option-id <DONE_OPTION_ID>

# Clear AI Assigned Slot
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_ASSIGNED_SLOT_FIELD_ID> \
  --text ""
```

---

## Epic Completion Check

After setting a task to Done, check if all sibling tasks in the epic are also Done:

```bash
# Get all tasks with this epic as parent
gh project item-list <PROJECT_NUMBER> \
  --owner <OWNER> \
  --format json \
  | jq --arg epic_id "<EPIC_ITEM_ID>" \
    '.items[] | select((.fieldValues[] | select(.field.name == "AI Parent Epic") | .value) == $epic_id) | {title, status: (.fieldValues[] | select(.field.name == "AI Status") | .value)}'
```

If all tasks are Done, set the epic item to Done:

```bash
gh project item-edit \
  --id <EPIC_ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> \
  --single-select-option-id <DONE_OPTION_ID>
```

Also set the parent PRD item to Done if all epics under it are Done.

---

## Regression Found During Review

If the reviewer finds a problem after the runner completed:

1. Set AI Status = In Progress (not back to Tasks Ready — the work started)
2. Set AI Role = fixer
3. Post a detailed comment on the issue explaining what failed and what to fix:

```bash
gh issue comment <ISSUE_NUMBER> \
  --repo <OWNER>/<REPO> \
  --body "**Reviewer feedback — sent back to fixer**\n\n<specific description of what failed and what the fix should be>"
```

4. Fixer slot picks up and corrects, then sets AI Status = In Review again

---

## What PM Should Never Do

- Never merge a PR that has failing CI checks (unless the user explicitly overrides)
- Never merge without at least one approval (unless the user explicitly overrides)
- Never set AI Status = Done without verifying the issue is actually closed
- Never delete a branch without the `--delete-branch` flag (use the flag, don't do it manually separately)
