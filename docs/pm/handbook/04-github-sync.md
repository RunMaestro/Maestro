# 04 — GitHub Sync

GitHub sync is the process of taking local task files and making them real GitHub issues, linking them to the project, and setting all custom fields. After sync, the Dispatch Engine can see and claim work. Before sync, tasks exist only in `docs/pm/epics/` and are invisible to automation.

---

## Prerequisites

1. `gh auth status` — must be authenticated
2. `projectGithubMap` configured for this project (owner, repo, projectNumber, projectId)
3. Field IDs cached for the project (run `gh project field-list` once per session)
4. Epic decomposition confirmed by user (see handbook/02-epic-decomposition.md)

---

## Step 1: Cache Field IDs

Run this once per conversation and store the results. You need field IDs and option IDs for every subsequent `gh project item-edit` call.

```bash
gh project field-list <PROJECT_NUMBER> \
  --owner <OWNER> \
  --format json \
  | jq '.fields[] | select(.name | startswith("AI")) | {name, id, options}'
```

From the output, extract and remember:

- `AI Status` field id + option IDs for each value (Backlog, Tasks Ready, In Progress, etc.)
- `AI Role` field id + option IDs (runner, fixer, reviewer, merger)
- `AI Stage` field id + option IDs (prd, epic, task)
- `AI Priority` field id + option IDs (P0, P1, P2, P3)
- `AI Assigned Slot`, `AI Last Heartbeat`, `AI Parent PRD`, `AI Parent Epic` field IDs (text fields, no option IDs)

---

## Step 2: Create Issues

For each task in the epic, create a GitHub issue:

```bash
gh issue create \
  --title "<Task Title>" \
  --body "$(cat docs/pm/epics/<slug>/<N>.md | sed '1,/^---$/d; 1,/^---$/d')" \
  --repo <OWNER>/<REPO>
```

The sed command strips the YAML frontmatter so only the markdown body goes into the issue.

**Capture the issue number** from the output (e.g., `https://github.com/owner/repo/issues/42` → number is 42).

---

## Step 3: Link Issue to Project

```bash
gh project item-add <PROJECT_NUMBER> \
  --owner <OWNER> \
  --url "https://github.com/<OWNER>/<REPO>/issues/<ISSUE_NUMBER>"
# Returns: item ID (PVTI_...)
```

**Capture the item ID** — you need it for all subsequent `item-edit` calls.

---

## Step 4: Set Custom Fields

Set all relevant fields on each newly added project item:

```bash
# AI Status = Tasks Ready
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> \
  --single-select-option-id <TASKS_READY_OPTION_ID>

# AI Stage = task
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STAGE_FIELD_ID> \
  --single-select-option-id <TASK_OPTION_ID>

# AI Role = runner (or fixer/reviewer/merger per task)
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_ROLE_FIELD_ID> \
  --single-select-option-id <RUNNER_OPTION_ID>

# AI Priority = P2 (or per-task value)
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_PRIORITY_FIELD_ID> \
  --single-select-option-id <P2_OPTION_ID>

# AI Parent PRD = <parent PRD item ID>
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_PARENT_PRD_FIELD_ID> \
  --text "<PARENT_PRD_ITEM_ID>"

# AI Parent Epic = <parent epic item ID> (if epic item exists)
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_PARENT_EPIC_FIELD_ID> \
  --text "<PARENT_EPIC_ITEM_ID>"
```

---

## Step 5: Update Task File with Issue Number

After sync, update the task file frontmatter to record the GitHub URL:

```bash
# Update the github field in frontmatter
sed -i "s|github: (will be set on sync)|github: https://github.com/<OWNER>/<REPO>/issues/<N>|" \
  docs/pm/epics/<slug>/<TASK_FILE>.md
```

Also update `depends_on` in each file to use issue numbers instead of sequential numbers.

---

## Step 6: Update Parent PRD Item

After all task items are synced, update the parent PRD project item:

```bash
# AI Status = Tasks Ready
gh project item-edit \
  --id <PRD_ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> \
  --single-select-option-id <TASKS_READY_OPTION_ID>
```

---

## Step 7: Confirm

Print a summary to the user:

```
Synced epic: <slug>
Issues created: #42, #43, #44, #45, #46
All set to AI Status=Tasks Ready in project #<N>
Parent PRD item updated to Tasks Ready

Next: the Dispatch Engine will pick up runner tasks automatically
if a runner slot is configured. Check Symphony → Roles tab.
```

---

## Batch Sync Script Pattern

For large epics (>5 tasks), use a loop:

```bash
# Pseudocode — adapt to your slug and project config
for task_file in docs/pm/epics/<slug>/[0-9]*.md; do
  title=$(grep '^name:' "$task_file" | cut -d' ' -f2-)
  body=$(sed '1,/^---$/d; 1,/^---$/d' "$task_file")
  issue_url=$(gh issue create \
    --title "$title" \
    --body "$body" \
    --repo <OWNER>/<REPO> \
    --json url -q .url)
  item_id=$(gh project item-add <PROJECT_NUMBER> \
    --owner <OWNER> \
    --url "$issue_url" \
    --format json | jq -r '.id')
  # set fields...
  echo "Created: $issue_url → item $item_id"
done
```

---

## Updating a Single Field (ad-hoc)

When you need to change one field on an existing item (e.g., promote a task from Tasks Ready to In Progress):

```bash
gh project item-edit \
  --id <ITEM_ID> \
  --project-id <PROJECT_ID> \
  --field-id <AI_STATUS_FIELD_ID> \
  --single-select-option-id <IN_PROGRESS_OPTION_ID>
```

---

## Reading Current Item State

```bash
# All items in the project with custom field values
gh project item-list <PROJECT_NUMBER> \
  --owner <OWNER> \
  --format json \
  | jq '.items[] | {title: .title, status: .fieldValues[] | select(.field.name == "AI Status") | .value}'
```

Or using the Maestro IPC (from an agent in PM mode):

```
pm:resolveGithubProject → returns owner, repo, projectNumber, projectId
```

---

## Common Errors and Fixes

### `--project-id is required`

You must pass the project's node ID (format: `PVT_...`), not the project number. Get it:

```bash
gh project list --owner <OWNER> --format json | jq '.projects[] | {number, id}'
```

### `field-id not found`

Run `gh project field-list` again — field IDs can change after project reconfiguration.

### `single-select-option-id not found`

Option IDs change if someone renamed an option in the project settings. Re-run field-list to get fresh IDs.

### Issue created but not linked to project

You missed Step 3. Run `gh project item-add` for each unlinked issue.
