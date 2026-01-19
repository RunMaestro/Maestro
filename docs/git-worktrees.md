---
title: Git and Worktrees
description: Browse commit history, view diffs, and run AI agents in parallel on isolated branches with Git worktree sub-agents.
icon: code-branch
---

Maestro integrates deeply with Git, providing visual tools for exploring repository history and enabling parallel development with worktree sub-agents.

## Git Log Viewer

Browse your commit history directly in Maestro:

![Git logs](./screenshots/git-logs.png)

The log viewer shows:
- **Commit history** with messages, authors, and timestamps
- **Branch visualization** with merge points
- **Quick navigation** to any commit

Access via **Command Palette** (`Cmd+K` / `Ctrl+K`) → "Git Log" or the git menu in the Left Bar.

## Diff Viewer

Review file changes with syntax-highlighted diffs:

![Git diff](./screenshots/git-diff.png)

The diff viewer displays:
- **Side-by-side comparison** of file versions
- **Syntax highlighting** matched to file type
- **Line-by-line changes** with additions and deletions clearly marked

Access diffs from the git log viewer by clicking any commit, or use **Command Palette** → "Git Diff".

---

## Git Worktrees

Git worktrees enable true parallel development by letting you run multiple AI agents on separate branches simultaneously. Each worktree operates in its own isolated directory, so there's no risk of conflicts between parallel work streams.

### Managing Worktrees

Worktree sub-agents appear nested under their parent agent in the Left Bar:

![Worktree list](./screenshots/git-worktree-list.png)

- **Nested Display** — Worktree sub-agents appear indented under their parent agent
- **Branch Icon** — A green checkmark indicates the active worktree
- **Collapse/Expand** — Click the chevron on a parent agent to show/hide its worktree children
- **Independent Operation** — Each worktree agent has its own working directory, conversation history, and state

### Creating a Worktree Sub-Agent

1. In the agent list (Left Bar), hover over an agent in a git repository
2. Click the **git branch indicator** (shows current branch name)
3. In the overlay menu, click **"Create Worktree Sub-Agent"**
4. Configure the worktree:

![Worktree configuration](./screenshots/git-worktree-configuration.png)

| Option | Description |
|--------|-------------|
| **Worktree Directory** | Base folder where worktrees are created (should be outside the main repo) |
| **Watch for Changes** | Monitor the worktree for file system changes |
| **Create New Worktree** | Branch name for the new worktree (becomes the subdirectory name) |

**Tip:** Configure the worktree directory to be outside your main repository (e.g., `~/Projects/Maestro-WorkTrees/`). This keeps worktrees organized and prevents them from appearing in your main repo's file tree.

### Worktree Actions

Right-click any worktree sub-agent to access management options:

![Worktree right-click menu](./screenshots/git-worktree-right-click.png)

| Action | Description |
|--------|-------------|
| **Rename** | Change the display name of the worktree agent |
| **Edit Agent...** | Modify agent configuration |
| **Create Pull Request** | Open a PR from this worktree's branch |
| **Remove Worktree** | Delete the worktree agent (see below) |

### Creating Pull Requests

When you're done with work in a worktree:

1. **Right-click** the worktree agent → **Create Pull Request**, or
2. Press `Cmd+K` / `Ctrl+K` with the worktree active → search "Create Pull Request"

The PR modal shows:
- Source branch (your worktree branch)
- Target branch (configurable)
- Auto-generated title and description based on your work

**Requirements:** GitHub CLI (`gh`) must be installed and authenticated. Maestro will detect if it's missing and show installation instructions.

### Removing Worktrees

When removing a worktree, you have two options:

![Remove worktree confirmation](./screenshots/git-worktree-remove.png)

| Option | What It Does |
|--------|--------------|
| **Remove** | Removes the sub-agent from Maestro but keeps the git worktree directory on disk |
| **Remove and Delete** | Removes the sub-agent AND permanently deletes the worktree directory from disk |

The confirmation dialog shows the full path to the worktree directory so you know exactly what will be affected.

## Use Cases

| Scenario | How Worktrees Help |
|----------|-------------------|
| **Background Auto Run** | Run Auto Run in a worktree while working interactively in the main repo |
| **Feature Branches** | Spin up a sub-agent for each feature branch |
| **Code Review** | Create a worktree to review and iterate on a PR without switching branches |
| **Parallel Experiments** | Try different approaches simultaneously without git stash/pop |

## Tips

- **Name branches descriptively** — The branch name becomes the worktree directory name
- **Use a dedicated worktree folder** — Keep all worktrees in one place outside the main repo
- **Clean up when done** — Remove worktree agents after merging PRs to avoid clutter
- **Watch for Changes** — Enable file watching to keep the file tree in sync with worktree activity
- **Run multiple dev instances** — Use `VITE_PORT` environment variable to run Maestro in multiple worktrees simultaneously:
  ```bash
  # In main worktree
  npm run dev

  # In worktree 2 (different terminal/directory)
  VITE_PORT=5174 npm run dev
  ```
