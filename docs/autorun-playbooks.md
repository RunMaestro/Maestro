---
title: Auto Run + Playbooks
description: Process markdown checklists with AI agents using Auto Run documents and reusable Playbooks.
icon: play
---

Auto Run is a file-system-based document runner that lets you process tasks using AI agents. Select a folder containing markdown documents with task checkboxes, and Maestro will work through them one by one, spawning a fresh AI session for each task.

![Auto Run](./screenshots/autorun-1.png)

## Setting Up Auto Run

1. Navigate to the **Auto Run** tab in the right panel (`Cmd+Shift+1`)
2. Select a folder containing your markdown task documents
3. Each `.md` file becomes a selectable document

## Creating Tasks

Use markdown checkboxes in your documents:

```markdown
# Feature Implementation Plan

- [ ] Implement user authentication
- [ ] Add unit tests for the login flow
- [ ] Update API documentation
```

**Tip**: Press `Cmd+L` (Mac) or `Ctrl+L` (Windows/Linux) to quickly insert a new checkbox at your cursor position.

## Running Single Documents

1. Select a document from the dropdown
2. Click the **Run** button (or the ▶ icon)
3. Customize the agent prompt if needed, then click **Go**

## Running Multiple Auto Run Documents

Auto Run supports running multiple documents in sequence:

1. Click **Run** to open the Auto Run configuration modal
2. Click **+ Add Docs** to add more documents to the queue
3. Drag to reorder documents as needed
4. Configure options per document:
   - **Reset on Completion** - Creates a working copy in `Runs/` subfolder instead of modifying the original. The original document is never touched, and working copies (e.g., `TASK-1735192800000-loop-1.md`) serve as audit logs.
   - **Duplicate** - Add the same document multiple times
5. Enable **Loop Mode** to cycle back to the first document after completing the last
6. Click **Go** to start running documents

## Playbooks

Save your Auto Run configurations as Playbooks for reuse:

1. Configure your documents, order, and options
2. Click **Save as Playbook** and enter a name
3. Load saved playbooks from the **Load Playbook** dropdown
4. Update or discard changes to loaded playbooks

![Playbooks](./screenshots/autorun-2.png)

### Inline Wizard

Generate new playbooks from within an existing session using the **Inline Wizard**:

1. Type `/wizard` in any AI tab (or click the Wizard button in the Auto Run panel)
2. Have a conversation with the AI about your project goals
3. Watch the confidence gauge build as the AI understands your requirements
4. At 80%+ confidence, the AI generates detailed Auto Run documents

![Inline Wizard](./screenshots/wizard-inline.png)

The Inline Wizard creates documents in a unique subfolder under your Auto Run folder, keeping generated playbooks organized. When complete, your tab is renamed to reflect the project and you can immediately start running the generated tasks.

### Playbook Exchange

Looking for pre-built playbooks? The [Playbook Exchange](./playbook-exchange) offers community-contributed playbooks for common workflows like security audits, code reviews, and documentation generation. Open it via Quick Actions (`Cmd+K`) or click the Exchange button in the Auto Run panel.

## Progress Tracking

The runner will:
- Process tasks serially from top to bottom
- Skip documents with no unchecked tasks
- Show progress: "Document X of Y" and "Task X of Y"
- Mark tasks as complete (`- [x]`) when done
- Log each completion to the **History** panel

## Session Isolation

Each task executes in a completely fresh AI session with its own unique session ID. This provides:

- **Clean context** - No conversation history bleeding between tasks
- **Predictable behavior** - Tasks in looping playbooks execute identically each iteration
- **Independent execution** - The agent approaches each task without memory of previous work

This isolation is critical for playbooks with `Reset on Completion` documents that loop indefinitely. Each loop creates a fresh working copy from the original document, and the AI approaches it without memory of previous iterations.

## Environment Variables

Maestro sets environment variables that your agent hooks can use to customize behavior:

| Variable | Value | Description |
|----------|-------|-------------|
| `MAESTRO_SESSION_RESUMED` | `1` | Set when resuming an existing session (not set for new sessions) |

**Example: Conditional Hook Execution**

Since Maestro spawns a new agent process for each message (batch mode), agent "session start" hooks will run on every turn. Use `MAESTRO_SESSION_RESUMED` to skip hooks on resumed sessions:

```bash
# In your agent's session start hook
[ "$MAESTRO_SESSION_RESUMED" = "1" ] && exit 0
# ... rest of your hook logic for new sessions only
```

This works with any agent provider (Claude Code, Codex, OpenCode) since the environment variable is set by Maestro before spawning the agent process.

## History & Tracking

Each completed task is logged to the History panel with:
- **AUTO** label indicating automated execution
- **Session ID** pill (clickable to jump to that AI conversation)
- **Summary** of what the agent accomplished
- **Full response** viewable by clicking the entry

**Keyboard navigation in History**:
- `Up/Down Arrow` - Navigate entries
- `Enter` - View full response
- `Esc` - Close detail view and return to list

## Expanded Editor View

For editing complex Auto Run documents, use the **Expanded Editor** — a fullscreen modal that provides more screen real-estate.

**To open the Expanded Editor:**
- Click the **expand icon** (↗️) in the top-right corner of the Auto Run panel
- Or press `Cmd+Shift+E` (Mac) / `Ctrl+Shift+E` (Windows/Linux) to toggle

![Expanded Auto Run Editor](./screenshots/autorun-expanded.png)

The Expanded Editor provides:
- **Edit/Preview toggle** — Switch between editing markdown and previewing rendered output
- **Document selector** — Switch between documents without closing the modal
- **Run controls** — Start, stop, and monitor Auto Run progress from the expanded view
- **Task progress** — See "X of Y tasks completed" and token count at the bottom
- **Full toolbar** — Create new documents, refresh, and open folder

Click **Collapse** or press `Esc` to return to the sidebar panel view.

## Saving Documents

Save your changes with `Cmd+S` (Mac) or `Ctrl+S` (Windows/Linux), or click the **Save** button in the editor footer. The editor shows "Unsaved changes" and a **Revert** button when you have pending edits. Full undo/redo support with `Cmd+Z` / `Cmd+Shift+Z`.

**Note**: Switching documents discards unsaved changes. Save before switching if you want to preserve your edits.

## Image Support

Paste images directly into your documents. Images are saved to an `images/` subfolder with relative paths for portability.

## Stopping the Runner

Click the **Stop** button at any time. The runner will:
- Complete the current task before stopping
- Preserve all completed work
- Allow you to resume later by clicking Run again

## Parallel Auto Runs

Auto Run can execute in parallel across different agents without conflicts — each agent works in its own project directory, so there's no risk of clobbering each other's work.

**Same project, parallel work:** To run multiple Auto Runs in the same repository simultaneously, create worktree sub-agents from the git branch menu (see [Git Worktrees](./git-worktrees)). Each worktree operates in an isolated directory with its own branch, enabling true parallel task execution on the same codebase.
