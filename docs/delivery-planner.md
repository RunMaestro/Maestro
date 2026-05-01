---
title: Delivery Planner
description: Turn a PRD into tracked GitHub issues and agent-ready tasks using the PRD wizard, decomposition flow, and CCPM mirror.
icon: map
---

Delivery Planner lifts the CCPM workflow into Maestro as a first-class feature. Write a Product Requirements Document in the PRD Wizard, decompose it into an epic and tasks, sync each task to GitHub, and watch the dashboard update in real time as agents pick up and complete work.

## Opening Delivery Planner

The Delivery Planner dashboard lives in the **Right Bar**. Click the **Planner** tab in the Right Bar header to open it.

You can also reach Delivery Planner features from any AI Terminal using the `/ccpm` slash commands.

---

## PRD Wizard

The PRD Wizard guides you through capturing a product idea as a structured document.

### Starting a New PRD

1. Click **New PRD** in the Planner tab header.
2. Fill in the wizard fields:
   - **Title** — short name for the feature
   - **Goal** — one-sentence description of the desired outcome
   - **Background** — context, motivation, or prior art
   - **Acceptance Criteria** — measurable conditions that define done
   - **Out of Scope** — explicit exclusions to prevent scope creep
3. Click **Create PRD** to save.

Maestro creates a Work Graph `document` item tagged `delivery-planner` and `prd`, then writes a mirror file to `.claude/prds/<slug>.md` inside your project root.

### Editing a PRD

Click the PRD title in the dashboard to open the detail view. All fields are editable inline. Changes are saved to the Work Graph on blur and the disk mirror is updated automatically.

### Slash Command

```
/ccpm prd <feature description>
```

The `/ccpm prd` command drafts a PRD from the current agent conversation. The agent fills in all fields from context, then presents a review step before saving.

---

## Decompose to Epic

Once a PRD is approved, convert it to a planning epic.

### From the Dashboard

1. Open the PRD detail view.
2. Click **Decompose → Create Epic**.
3. Confirm the epic title and scope. Maestro links the new epic to the PRD and writes `.claude/epics/<slug>/epic.md`.

### From an AI Terminal

```
/ccpm decompose
```

With a PRD in context, `/ccpm decompose` runs the full decomposition flow interactively.

---

## Decompose to Tasks

With an epic created, break it into concrete, agent-ready tasks.

### Automatic Decomposition

1. Open the Epic detail view.
2. Click **Decompose → Generate Tasks**.
3. Maestro calls the decomposer (AI-assisted) to draft a task list with dependency edges.
4. Review the proposed tasks. Edit titles, descriptions, or acceptance criteria before confirming.
5. Click **Confirm Tasks** to save.

Each confirmed task becomes a Work Graph `task` item. When a task has a title, description, acceptance criteria, and capability hints, Maestro marks it `agent-ready` and it appears in the Agent Dispatch kanban board.

Task files are written to `.claude/epics/<slug>/tasks/001.md`, `002.md`, and so on.

### Dependency Graph

Tasks that cannot start until another finishes are linked as dependencies. The dependency graph is visible in the Epic detail view as a simple list under each task. Tasks with unresolved dependencies are shown as **Blocked** in the kanban board.

---

## GitHub Sync

Sync any Work Graph item to a GitHub issue in one click.

### Syncing a Task

1. Open the task detail view in the dashboard or kanban board.
2. Click **Sync to GitHub**.
3. Maestro creates or updates a GitHub issue, writes back the `issueNumber` and URL to the Work Graph item, and sets the following project fields:

| Field              | Value                             |
| ------------------ | --------------------------------- |
| `Work Item Type`   | `task`                            |
| `CCPM ID`          | e.g. `delivery-planner#task-3`    |
| `Agent Pickup`     | `Ready` / `Claimed` / `Not Ready` |
| `Parent Work Item` | Epic work item ID                 |

Labels `delivery-planner` and `agent-ready` are applied automatically when the task is marked agent-ready.

### Progress Comments

After GitHub sync, you can post progress updates directly to the issue without leaving Maestro:

1. Open the task detail view.
2. Type a message in the **Progress Comment** field.
3. Click **Post Comment**.

The comment is appended to the Work Graph item's metadata and posted to the linked GitHub issue.

### Bug Follow-Ups

When a task uncovers a defect worth tracking:

1. Open the task detail view.
2. Click **New Bug Follow-Up**.
3. Fill in the title and description.

Maestro creates a `bug` Work Graph item linked to the parent task, creates a GitHub issue with the `bug-follow-up` label, and cross-references both issues.

### Slash Command

```
/ccpm sync
```

Syncs all unsynchronized Delivery Planner items in the current project to GitHub in a single pass.

---

## Dashboard

The dashboard provides a summary view of all PRDs, epics, and tasks for the active project.

### Layout

The dashboard has three columns:

| Column    | Contents                                                 |
| --------- | -------------------------------------------------------- |
| **PRDs**  | All product requirements documents, with status badges   |
| **Epics** | Epics linked to each PRD, with task counts               |
| **Tasks** | Tasks for the selected epic, with status and GitHub link |

Click any row to open the detail panel on the right. The detail panel shows all fields, sync status, dependency list, and progress comments.

### Status Badges

| Badge           | Meaning                                       |
| --------------- | --------------------------------------------- |
| **Draft**       | Item created, not yet reviewed                |
| **Ready**       | Marked agent-ready; visible in Agent Dispatch |
| **In Progress** | An agent holds an active claim                |
| **Review**      | Work completed, awaiting human review         |
| **Done**        | Closed                                        |
| **Blocked**     | Has unresolved dependencies                   |

### Live Updates

The dashboard subscribes to Work Graph broadcast events. Status changes made by agents, the kanban board, or the CLI are reflected without a manual refresh.

---

## CCPM Mirror

Delivery Planner maintains a mirror of Work Graph state in CCPM-compatible Markdown files. The mirror is human-readable and compatible with the Maestro CLI's CCPM skill.

### File Layout

```
.claude/
├── prds/
│   └── <feature-slug>.md
└── epics/
    └── <epic-slug>/
        ├── epic.md
        ├── tasks/
        │   ├── 001.md
        │   └── 002.md
        ├── progress.md
        └── bugs/
```

### Mirror vs. Work Graph

The Work Graph is the source of truth. Mirror files are kept in sync on every write but are treated as read-friendly artifacts, not editable inputs. If you edit a mirror file externally (e.g., with the CCPM CLI skill), the next Delivery Planner write will detect the hash mismatch and offer three options:

- **Overwrite** — replace the file with Work Graph state
- **Skip** — leave the disk file as-is for this operation
- **Merge** — open a diff view to reconcile manually

### CCPM Compatibility

Existing `.claude/` files written by the CCPM CLI skill can be imported into the Work Graph via **Settings → Delivery Planner → Import CCPM Files**. Imported items appear in the dashboard alongside natively-created items.

---

## Slash Commands

All Delivery Planner slash commands are available in the AI input area in AI mode. Type `/ccpm` to see them in the autocomplete menu.

| Command           | Description                                                          |
| ----------------- | -------------------------------------------------------------------- |
| `/ccpm prd`       | Draft a new PRD from the current agent conversation                  |
| `/ccpm decompose` | Decompose the active PRD or epic into tasks                          |
| `/ccpm sync`      | Sync all unsynchronized items to CCPM mirror files and GitHub        |
| `/ccpm next`      | Show the next agent-ready task for the current project               |
| `/ccpm status`    | Show Delivery Planner status: item counts, sync state, blocked tasks |
| `/ccpm bug`       | Draft a bug follow-up linked to the current task                     |

---

## Web and Mobile

The Delivery Planner dashboard and sync controls are available in the Maestro web and mobile interfaces. The web sync endpoint requires `{ confirmed: true }` in the request body as a safety gate before any GitHub API call is made.

---

## Troubleshooting

### Dashboard shows no items

The dashboard reads from the Work Graph. Items appear after you create a PRD via the wizard or import existing CCPM files. If you created items through an agent using `/ccpm prd` but they don't appear, run `/ccpm sync` to push the mirror state back to the Work Graph.

### "CCPM root must be inside the active project" error

A path slug contains an absolute path or `..` segments that would resolve outside the project root. Check that your PRD and epic slugs don't start with `/` and don't contain relative traversal sequences.

### Mirror conflict after external edit

If the on-disk CCPM file was modified after the last Delivery Planner write, you'll see a **Mirror Conflict** notice in the task detail view. Choose **Overwrite**, **Skip**, or open the diff view to merge. Work Graph state is always preserved regardless of which option you pick.

### GitHub sync creates duplicate issues

Delivery Planner checks `WorkItem.github.issueNumber` before creating a new issue. Duplicates can appear if the `issueNumber` field was cleared manually. Open the task detail view and enter the existing issue number in the **GitHub Issue** field before syncing again.

### Task not appearing in Agent Dispatch

A task must be marked `agent-ready` before Agent Dispatch can pick it up. Open the task detail view and confirm that all required fields are filled: title, description, acceptance criteria, and at least one capability hint. Click **Mark Agent-Ready** if the button is available, or run `/ccpm status` to see what's blocking promotion.

### Sync button is grayed out

The sync button is disabled until the item has a title and the project path is resolved. If the button remains grayed out after saving, check that the active project is set in **Settings → Project** and that a valid Git working directory is detected.

### "POST /sync returns 400" from the web interface

The web sync endpoint requires `{ "confirmed": true }` in the request body. Any request without this field is rejected before the GitHub API is contacted. Ensure your web client or API consumer includes this field.

### Stats DB entries appearing for planner actions

Delivery Planner operations are routed through the Work Graph, not the stats database. If planner actions are creating entries in the stats DB, a handler has been misrouted. Check `src/main/ipc/handlers/delivery-planner.ts` and confirm no call reaches `src/main/stats-db.ts`.
