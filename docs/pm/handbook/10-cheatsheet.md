# 10 — gh CLI Cheatsheet

Quick reference for every common gh CLI operation in the Maestro PM pipeline. Copy-pasteable. Replace `<OWNER>`, `<REPO>`, `<PROJECT_NUMBER>`, `<PROJECT_ID>`, `<ITEM_ID>`, `<ISSUE_NUMBER>`, `<PR_NUMBER>`, `<FIELD_ID>`, and `<OPTION_ID>` with real values.

Get your field IDs once per session — see "Cache Field IDs" below.

---

## Project Operations

```bash
# List all projects for an owner
gh project list --owner <OWNER> --format json

# List all items in a project (with all field values)
gh project item-list <PROJECT_NUMBER> \
  --owner <OWNER> \
  --format json

# Get all custom field IDs and option IDs
gh project field-list <PROJECT_NUMBER> \
  --owner <OWNER> \
  --format json \
  | jq '.fields[] | {name, id, options}'

# Get just AI-prefixed fields
gh project field-list <PROJECT_NUMBER> \
  --owner <OWNER> \
  --format json \
  | jq '.fields[] | select(.name | startswith("AI")) | {name, id, options}'

# Create a new draft item
gh project item-create <PROJECT_NUMBER> \
  --owner <OWNER> \
  --title "<TITLE>"

# Add an existing issue to the project
gh project item-add <PROJECT_NUMBER> \
  --owner <OWNER> \
  --url "https://github.com/<OWNER>/<REPO>/issues/<ISSUE_NUMBER>"
```

---

## Setting Custom Fields

```bash
# Set a single-select field (AI Status, AI Role, AI Stage, AI Priority)
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <FIELD_ID> \
  --single-select-option-id <OPTION_ID>

# Set a text field (AI Assigned Slot, AI Last Heartbeat, AI Parent PRD, AI Parent Epic)
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <FIELD_ID> \
  --text "<VALUE>"

# Clear a text field
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <FIELD_ID> \
  --text ""

# Set AI Last Heartbeat to now
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_LAST_HEARTBEAT_FIELD_ID> \
  --text "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
```

---

## Common Field Transitions (paste and fill in IDs)

```bash
# Tasks Ready → In Progress (claim)
gh project item-edit --id <ITEM_ID> --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> --single-select-option-id <IN_PROGRESS_OPTION_ID>
gh project item-edit --id <ITEM_ID> --project-id <PROJECT_ID> \
  --field-id <AI_ASSIGNED_SLOT_FIELD_ID> --text "<SLOT_ID>"
gh project item-edit --id <ITEM_ID> --project-id <PROJECT_ID> \
  --field-id <AI_LAST_HEARTBEAT_FIELD_ID> --text "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# In Progress → In Review (runner done)
gh project item-edit --id <ITEM_ID> --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> --single-select-option-id <IN_REVIEW_OPTION_ID>
gh project item-edit --id <ITEM_ID> --project-id <PROJECT_ID> \
  --field-id <AI_ROLE_FIELD_ID> --single-select-option-id <REVIEWER_OPTION_ID>
gh project item-edit --id <ITEM_ID> --project-id <PROJECT_ID> \
  --field-id <AI_ASSIGNED_SLOT_FIELD_ID> --text ""

# In Review → Done (merged)
gh project item-edit --id <ITEM_ID> --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> --single-select-option-id <DONE_OPTION_ID>
gh project item-edit --id <ITEM_ID> --project-id <PROJECT_ID> \
  --field-id <AI_ASSIGNED_SLOT_FIELD_ID> --text ""

# Reset stale claim → Tasks Ready
gh project item-edit --id <ITEM_ID> --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> --single-select-option-id <TASKS_READY_OPTION_ID>
gh project item-edit --id <ITEM_ID> --project-id <PROJECT_ID> \
  --field-id <AI_ASSIGNED_SLOT_FIELD_ID> --text ""
gh project item-edit --id <ITEM_ID> --project-id <PROJECT_ID> \
  --field-id <AI_LAST_HEARTBEAT_FIELD_ID> --text ""

# Mark Blocked
gh project item-edit --id <ITEM_ID> --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> --single-select-option-id <BLOCKED_OPTION_ID>
gh project item-edit --id <ITEM_ID> --project-id <PROJECT_ID> \
  --field-id <AI_ASSIGNED_SLOT_FIELD_ID> --text ""
```

---

## Issue Operations

```bash
# Create an issue
gh issue create \
  --title "<TITLE>" \
  --body "<BODY>" \
  --repo <OWNER>/<REPO>

# Create an issue with a label
gh issue create \
  --title "<TITLE>" \
  --body "<BODY>" \
  --repo <OWNER>/<REPO> \
  --label "<LABEL>"

# View an issue
gh issue view <ISSUE_NUMBER> \
  --repo <OWNER>/<REPO> \
  --json number,title,body,state,labels,createdAt

# List open issues
gh issue list \
  --repo <OWNER>/<REPO> \
  --state open \
  --json number,title,state,labels

# Close an issue
gh issue close <ISSUE_NUMBER> --repo <OWNER>/<REPO>

# Comment on an issue
gh issue comment <ISSUE_NUMBER> \
  --repo <OWNER>/<REPO> \
  --body "<COMMENT>"

# Edit issue title
gh issue edit <ISSUE_NUMBER> \
  --repo <OWNER>/<REPO> \
  --title "<NEW_TITLE>"

# Add a label to an issue
gh issue edit <ISSUE_NUMBER> \
  --repo <OWNER>/<REPO> \
  --add-label "<LABEL>"

# Remove a label from an issue
gh issue edit <ISSUE_NUMBER> \
  --repo <OWNER>/<REPO> \
  --remove-label "<LABEL>"
```

---

## PR Operations

```bash
# List open PRs
gh pr list \
  --repo <OWNER>/<REPO> \
  --state open \
  --json number,title,headRefName,state

# View a PR
gh pr view <PR_NUMBER> \
  --repo <OWNER>/<REPO> \
  --json number,title,body,state,reviews,checks

# Check CI status
gh pr checks <PR_NUMBER> --repo <OWNER>/<REPO>

# Approve a PR
gh pr review <PR_NUMBER> \
  --repo <OWNER>/<REPO> \
  --approve

# Request changes
gh pr review <PR_NUMBER> \
  --repo <OWNER>/<REPO> \
  --request-changes \
  --body "<What needs to change>"

# Merge (squash)
gh pr merge <PR_NUMBER> \
  --repo <OWNER>/<REPO> \
  --squash \
  --delete-branch
```

---

## Useful Queries

```bash
# All In Progress items with heartbeat
gh project item-list <PROJECT_NUMBER> --owner <OWNER> --format json \
  | jq '.items[] | select((.fieldValues[] | select(.field.name == "AI Status") | .value) == "In Progress") | {title, slot: (.fieldValues[] | select(.field.name == "AI Assigned Slot") | .value), hb: (.fieldValues[] | select(.field.name == "AI Last Heartbeat") | .value)}'

# All Tasks Ready items sorted by priority
gh project item-list <PROJECT_NUMBER> --owner <OWNER> --format json \
  | jq '[.items[] | select((.fieldValues[] | select(.field.name == "AI Status") | .value) == "Tasks Ready")] | sort_by(.fieldValues[] | select(.field.name == "AI Priority") | .value)'

# All Blocked items
gh project item-list <PROJECT_NUMBER> --owner <OWNER> --format json \
  | jq '.items[] | select((.fieldValues[] | select(.field.name == "AI Status") | .value) == "Blocked") | {title, url: .content.url}'

# Items by parent epic
gh project item-list <PROJECT_NUMBER> --owner <OWNER> --format json \
  | jq --arg epic "<EPIC_ITEM_ID>" '.items[] | select((.fieldValues[] | select(.field.name == "AI Parent Epic") | .value) == $epic) | {title, status: (.fieldValues[] | select(.field.name == "AI Status") | .value)}'

# Count items by AI Status
gh project item-list <PROJECT_NUMBER> --owner <OWNER> --format json \
  | jq '[.items[] | .fieldValues[] | select(.field.name == "AI Status") | .value] | group_by(.) | map({status: .[0], count: length})'
```

---

## Cache Field IDs — Session Bootstrap

Run this once at the start of a PM conversation and remember the IDs:

```bash
gh project field-list <PROJECT_NUMBER> \
  --owner <OWNER> \
  --format json \
  | jq '.fields[] | select(.name | startswith("AI")) | {
      name,
      fieldId: .id,
      options: (.options // [] | map({label: .name, optionId: .id}))
    }'
```

Store the results as variables in your reasoning:

```
AI_STATUS_FIELD_ID = PVTSSF_abc123
AI_STATUS_OPTIONS:
  Backlog            = abc
  Idea               = def
  PRD Draft          = ghi
  Refinement         = jkl
  Tasks Ready        = mno
  In Progress        = pqr
  In Review          = stu
  Blocked            = vwx
  Done               = yz1
```

You'll need these for every `item-edit` call. Running `field-list` repeatedly is fine but slower.
