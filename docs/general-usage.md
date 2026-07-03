---
title: General Usage
description: Learn the Maestro UI layout, agent status indicators, file explorer, and output filtering.
icon: grid-2
---

## UI Overview

Maestro features a three-panel layout:

- **Left Panel** - Agent list with grouping, filtering, search, bookmarks, and drag-and-drop organization
- **Main Panel** - Center workspace with two modes per agent:
  - **AI Terminal** - Converse with your AI provider (Claude Code, Codex, or OpenCode). Supports multiple tabs (each tab is a session), `@` file mentions, image attachments, slash commands, and draft auto-save.
  - **Command Terminal** - PTY shell with tab completion for files, branches, tags, and command history.
  - **Views**: Session Explorer, File Preview, Git Diffs, Git Logs
- **Right Panel** - Three tabs: File Explorer, History Viewer, and Auto Run

![Main screen](./screenshots/main-screen.png)

## Agent Status Indicators

Each agent shows a color-coded status indicator:

- 🟢 **Green** - Ready and waiting
- 🟡 **Yellow** - Agent is thinking or waiting for user input
- 🔴 **Red** - No connection with agent
- 🟠 **Pulsing Orange** - Attempting to establish connection
- 🔴 **Red Badge** - Unread messages (small red dot overlapping top-right of status indicator, iPhone-style)

## File Explorer and Preview

The **File Explorer** (Right Panel → Files tab) lets you browse project files. Click any file to open it in the **File Preview** view.

![File viewer](./screenshots/file-viewer.png)

**File Preview features:**

- **Syntax highlighting** for code files
- **Markdown rendering** with toggle between raw/preview (`Cmd+E` / `Ctrl+E`)
- **Image viewing** for common image formats
- **Line numbers** for easy reference
- **Search within file** (`Cmd+F` / `Ctrl+F`)

### File Explorer Keyboard Shortcuts

With the Files tab focused, navigate the file list without touching the mouse:

| Shortcut                    | Action                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `Up` / `Down`               | Move the focused file up or down by one                                            |
| `Option+Up` / `Option+Down` | Jump ten files at a time (page up / page down)                                     |
| `Shift+Up` / `Shift+Down`   | **Peek scroll** - slide the file list up or down without changing the focused file |
| `Cmd+Up` / `Cmd+Down`       | Jump to the top or bottom of the list (`Ctrl+Up` / `Ctrl+Down` on Windows/Linux)   |
| `Left` / `Right`            | Collapse / expand the focused folder (`Left` on a file jumps to its parent folder) |
| `Enter`                     | Open the focused file (or toggle the folder if a folder is focused)                |

Use `Shift+Up` / `Shift+Down` when you want to glance further down the tree without losing your place - the focused file stays put while the viewport slides.

### Breadcrumb Navigation

When you open a file, a **breadcrumb trail** appears showing your navigation history. Click any breadcrumb to jump back to a previously viewed file. This makes it easy to compare files or return to where you were.

### File Editing

Files can be edited directly in the preview. Press `Cmd+S` / `Ctrl+S` to save changes. If you navigate away or close the preview with unsaved changes, a confirmation dialog will ask whether to discard them.

### Drag and Drop Files Into the Tree

Drag files or folders from your OS file manager (Finder on macOS, Explorer on Windows, your file manager on Linux) straight into the **Files tab** to copy them into the project:

- **Drop onto a folder row** to copy the items inside that folder. The folder highlights as you hover it.
- **Drop on empty space or a file row** to copy into the project root. The panel border highlights to show the root is the target.
- **Folders are copied recursively**, with all of their contents.
- If a name already exists at the destination, a prompt lets you **Overwrite**, **Auto-rename** (adds a numeric suffix), or **Skip** the conflicting items.

Where you drop decides what happens:

| Drop target                                      | Result                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Main panel** (the AI conversation)             | Attaches the file to your message - images become thumbnails, anything else becomes an `@reference` |
| **Files tab**                                    | Copies the file or folder into the tree, at the folder or root you dropped on                       |
| **Left bar**, or the **History / Auto Run** tabs | Nothing - those regions ignore dropped files                                                        |

<Note>
Importing into the tree copies from your local machine, so it is not available for agents running on an SSH remote. Attaching files to the chat still works on remotes.
</Note>

### Publish as GitHub Gist

Share files directly as GitHub Gists from the File Preview:

**Prerequisites:**

- [GitHub CLI](https://cli.github.com/) (`gh`) must be installed
- You must be authenticated (`gh auth login`)

**To publish a file:**

1. Open a file in File Preview
2. Click the **Share icon** (↗) in the header toolbar, or
3. Use `Cmd+K` / `Ctrl+K` → "Publish Document as GitHub Gist"

**Visibility options:**
| Option | Description |
|--------|-------------|
| **Publish Secret** (default) | Creates an unlisted gist - not searchable, only accessible via direct link |
| **Publish Public** | Creates a public gist - visible on your profile and searchable |

The confirmation modal focuses "Publish Secret" by default, so you can press `Enter` to quickly publish. Press `Esc` to cancel.

**After publishing:**

- The gist URL is automatically copied to your clipboard
- A toast notification appears with a link to open the gist in your browser

<Note>
The share button only appears when viewing files (not in edit mode) and when GitHub CLI is available and authenticated.
</Note>

### @ File Mentions

Reference files in your AI prompts using `@` mentions:

1. Type `@` followed by a filename
2. Select from the autocomplete dropdown
3. The file path is inserted, giving the AI context about that file

## Prompt Composer

For complex prompts that need more editing space, use the **Prompt Composer** - a fullscreen editing modal.

**To open the Prompt Composer:**

- Press `Cmd+Shift+P` / `Ctrl+Shift+P`, or
- Click the **pencil icon** (✏️) in the bottom-left corner of the AI input box

![Prompt Composer Button](./screenshots/prompt-composer-button.png)

The Prompt Composer provides:

- **Full-screen editing space** for complex, multi-paragraph prompts
- **Character and token count** displayed in the footer
- **All input controls** - History toggle, Read-only mode, Thinking toggle, and send shortcut indicator
- **Image attachment support** via the image icon in the footer

![Prompt Composer](./screenshots/prompt-composer.png)

When you're done editing, click **Send** or press the displayed shortcut to send your message. The composer closes automatically and your prompt is sent to the AI.

## Message Queue

You never have to wait for an agent to finish before lining up your next thought. Any message (or slash command) you send while an agent is busy is added to that tab's **queue** instead of being dropped, and dispatched automatically, in order, the moment the agent becomes ready. A **QUEUED (n)** separator appears in the transcript listing everything waiting to go.

Each queued item has a row of controls (hover reveals them, and they stay visible while you work):

| Control           | Icon  | What it does                                                                                            |
| ----------------- | ----- | ------------------------------------------------------------------------------------------------------- |
| **Edit**          | ✏️    | Reopen the message to change its text or add, annotate, and remove image attachments before it's sent   |
| **Copy**          | ⧉     | Copy the message text (or the command) to the clipboard                                                 |
| **Hold / Resume** | ⏸ / ▶ | Hold a message so the queue skips over it, then resume it later. Held items show a **HELD** badge       |
| **Reorder**       | ⠿     | Drag any item by its handle to change the order they'll be sent (available once two or more are queued) |
| **Remove**        | ✕     | Delete a message from the queue so it's never sent (asks for confirmation)                              |

**Editing** is only offered for messages, not slash commands. Long messages are truncated with a **Show all** toggle so the queue stays compact, and attached images collapse behind a click-to-expand thumbnail strip (click a thumbnail to open it full-size in the carousel).

### Force Send

When [Forced Parallel Execution](./features) is enabled and another tab in the same agent is already working, a queued item gains a **Force Send** button. This dispatches that message immediately, running it in parallel instead of waiting its turn in the cross-tab queue. A confirmation lists which other tabs are currently busy before it sends.

### Execution Queue view

Press `Cmd+Shift+X` / `Ctrl+Shift+X` (or click the queue indicator) to open the **Execution Queue** - a single view of everything queued across all of your agents. It offers the same per-item controls (edit, copy, hold/resume, reorder, remove) plus a jump-to-agent shortcut, so you can manage a busy fleet from one place. Items are processed sequentially per agent to keep concurrent file edits from colliding.

## Input Toggles

The AI input box includes three toggle buttons that control session behavior:

![Input Toggles](./screenshots/input-toggles.png)

| Toggle        | Shortcut                       | Description                                                          |
| ------------- | ------------------------------ | -------------------------------------------------------------------- |
| **History**   | `Cmd+S` / `Ctrl+S`             | Save a synopsis of each completion to the [History panel](./history) |
| **Read-only** | `Cmd+R` / `Ctrl+R`             | Enable plan/read-only mode - AI can read but not modify files        |
| **Thinking**  | `Cmd+Shift+K` / `Ctrl+Shift+K` | Show streaming thinking/reasoning as the AI works                    |

**Per-tab persistence:** Each toggle state is saved per tab. If you enable Thinking on one tab, it stays enabled for that tab even when you switch away and back.

### Configuring Defaults

Set the default state for new tabs in **Settings** (`Cmd+,` / `Ctrl+,`) → **General**:

![Input Toggle Defaults](./screenshots/input-toggles-defaults.png)

| Setting                          | Description                                         |
| -------------------------------- | --------------------------------------------------- |
| **Enable "History" by default**  | New tabs save synopses to History automatically     |
| **Enable "Thinking" by default** | New tabs show thinking/reasoning content by default |

### Send Key Configuration

Configure how messages are sent in each mode:

| Mode                    | Options                | Description                                         |
| ----------------------- | ---------------------- | --------------------------------------------------- |
| **AI Interaction Mode** | `Enter` or `Cmd+Enter` | Choose your preferred send key for AI conversations |
| **Terminal Mode**       | `Enter` or `Cmd+Enter` | Choose your preferred send key for shell commands   |

- When set to `Cmd+Enter` / `Ctrl+Enter`, pressing `Enter` alone creates a new line (for multi-line input)
- When set to `Enter`, use `Shift+Enter` for new lines
- The current send key is displayed in the input box (e.g., "⌘ + Enter")
- **Per-tab override:** Click the send key indicator in the input box to toggle between modes for that tab

## Image Carousel

When working with image attachments, use the **Image Carousel** to view, manage, and remove images.

**To open the Image Carousel:**

- Press `Cmd+Y` / `Ctrl+Y`, or
- Click the image icon in the input box when images are attached

**Carousel controls:**

- **Arrow keys** - Navigate between images
- **Delete** or **Backspace** - Remove the currently selected image
- **Click the X** - Remove an image by clicking its remove button
- **Esc** - Close the carousel

Images can be attached via drag-and-drop, paste, or the attachment button. The carousel shows all images queued for the current message.

## Output Filtering

Filter and search through AI output to find specific content or hide noise.

### Global Filter

The global filter applies to all AI output in the current session.

**To open the global filter:**

- Click the filter icon in the output toolbar
- The filter bar appears at the top of the output area

### Per-Response Filters

Each AI response has its own local filter. Hover over a response to reveal the filter icon, then click to open the filter bar for that specific response.

### Filter Modes

| Mode        | Icon       | Description                        |
| ----------- | ---------- | ---------------------------------- |
| **Include** | ➕ (green) | Show only lines matching the query |
| **Exclude** | ➖ (red)   | Hide lines matching the query      |

Click the mode icon to toggle between Include and Exclude.

### Text vs Regex Matching

| Mode           | Indicator | Description                         |
| -------------- | --------- | ----------------------------------- |
| **Plain text** | `Aa`      | Case-insensitive substring matching |
| **Regex**      | `.*`      | Regular expression pattern matching |

Click the indicator to toggle between plain text and regex mode.

### Filter Controls

- **Query input** - Type your search term or regex pattern
- **Esc** - Clear the filter and close the filter bar
- **Click outside** - If the query is empty, the filter bar closes

### Placeholders

The placeholder text updates to reflect the current mode:

- "Include by keyword" / "Exclude by keyword" for plain text
- "Include by RegEx" / "Exclude by RegEx" for regex mode

### Use Cases

**Finding specific content:**

- Set to **Include** mode with plain text
- Type a keyword like "error" or "function"
- Only matching lines are shown

**Hiding verbose output:**

- Set to **Exclude** mode with plain text
- Type patterns like "debug" or "verbose"
- Matching lines are hidden from view

**Complex pattern matching:**

- Enable **Regex** mode
- Use patterns like `\berror\b` for word boundaries
- Or `^\s*#` to match comment lines

## Command Interpreter

The command interpreter can be focused for a clean, terminal-only experience when you collapse the left panel.

![Command interpreter](./screenshots/command-interpreter.png)

## Command Terminal

Each agent has a Command Terminal alongside its AI Terminal - a real PTY shell scoped to the agent's working directory. Switch between them with `Cmd+J` / `Ctrl+J`. Open a new terminal tab with `Ctrl+Shift+` + `` ` ``; close, rename, and reorder it just like an AI tab. Right-click (or hover) a terminal tab to open its action menu.

### Startup Command

Configure a command to run automatically every time a terminal tab's shell is started - including after you quit and reopen Maestro. This is the simplest way to keep something like `npm run dev`, a watcher, or a long-running log tail attached to a specific tab.

**To configure:**

1. Hover the terminal tab and open its action menu.
2. Click **Startup Command…** (right under **Rename**).
3. Enter the command and, optionally, a working directory. The working directory defaults to the agent's working directory if left blank.
4. Click **Save**.

**Behavior:**

- The command runs each time the PTY for that tab is spawned. The most common trigger is launching Maestro after a quit - any open terminal tab is restored, its shell respawned, and the configured command executes.
- Configuring a command on an already-running shell does **not** retroactively run it. The next spawn (app restart, or close-and-reopen the tab) picks it up.
- The configured working directory becomes the shell's spawn directory, so the command starts in the right place even if the tab's last `cd` was somewhere else.
- Leave the command field empty and save to disable the feature for that tab.
- Each terminal tab has its own startup command - one tab can run a dev server while another runs a log tail.

> **SSH agents**: when the agent is configured to run on a remote host, the terminal tab also runs on that host, and the startup command executes remotely (the working directory must be a path on the remote machine).

## Agent Management

Agents are the core of Maestro - each agent represents an AI coding assistant running in its own workspace.

### Creating Agents

**To create a new agent:**

1. Press `Cmd+N` / `Ctrl+N`, or click the **New Agent** button in the bottom-left sidebar
2. Choose **Manual Setup** or **Guided Setup** (Wizard) - see [Getting Started](./getting-started) for details on each path
3. For Manual Setup: select an available AI provider (Claude Code, Codex, OpenCode, or Factory Droid), choose a working directory, and optionally name the agent

**Advanced configuration options:**

- **New Session Message** - A hidden message prefixed to the first message whenever a new session (tab) is created. Use this for initial context, setup instructions, or persona definitions that should apply at the start of every conversation. Not visible in chat.
- **Nudge Message** - A hidden message appended to every interactive user message sent to the agent. This is useful for persistent instructions or reminders that guide the agent's behavior across all conversations. **Note:** Nudge messages only apply to interactive AI messages - they are not included in Auto Run tasks.
- **Custom Path** - Override the default executable path
- **Custom Arguments** - Additional command-line arguments
- **Environment Variables** - Custom environment variables for the agent process
- **Model Selection** - Choose a specific model and (where supported) reasoning/effort level. This sets the default for new tabs in this agent. You can override the model or effort on any individual tab using the model/effort pill in the input bar - per-tab overrides only affect that tab and don't change the agent default or any other tab.

### Editing Agents

Right-click any agent in the left panel and select **Edit Agent...** to modify its configuration. You can change the name, new session message, nudge message, custom paths, arguments, environment variables, model, and effort. Model and effort set here apply as the default to new tabs; existing tabs that haven't been overridden also follow this default. To override on a single tab without changing the agent-wide default, use the model/effort pill in that tab's input bar.

### Deleting Agents

Right-click an agent and select **Remove Agent** to delete it. This removes the agent from Maestro but does not delete any files or AI session data.

### Agent Configuration via Quick Actions

Use `Cmd+K` / `Ctrl+K` → "Edit Agent" to quickly access agent configuration for the current session.

## Left Panel Operations

The left panel (sidebar) contains your agent list, groups, and navigation controls.

### Filtering and Search

Press `Cmd+F` / `Ctrl+F` while the sidebar is focused to open the session filter. The filter:

- Searches agent names and AI tab names
- Automatically expands groups containing matches
- Shows matching bookmarked agents
- Searches worktree branch names

### Bookmarks

Pin important agents to the top of the list:

- Right-click an agent → **Add Bookmark**
- Or use the context menu to toggle bookmark status

Bookmarked agents appear in a collapsible "Bookmarks" section at the top of the left panel.

### Groups

Organize agents into groups for better project management:

**Creating groups:**

- `Cmd+K` / `Ctrl+K` → "Create Group"
- Groups have a name and emoji for visual identification

**Moving agents to groups:**

- Right-click an agent → **Move to Group** → Select target group
- Or drag-and-drop agents between groups

**Collapsing/Expanding:**

- Click the group header to collapse or expand
- Groups remember their collapsed state

### Drag and Drop

Rearrange agents by dragging them:

- Drag agents between groups
- Drag to reorder within a group
- Drag to the "Ungrouped" section to remove from a group

### Context Menu

Right-click any agent for quick actions:

- **Rename** - Change the agent's display name
- **Edit Agent...** - Open configuration modal
- **Add/Remove Bookmark** - Toggle bookmark status
- **Move to Group** - Organize into groups
- **Create Worktree** - Create a git worktree sub-agent (if configured)
- **Configure Worktrees** - Set up worktree configuration
- **Remove Agent** - Delete the agent from Maestro

### Sidebar Width

Drag the right edge of the sidebar to resize it. The width is persisted across sessions.

### Collapsed Mode

Click the sidebar toggle (`Opt+Cmd+Left` / `Alt+Ctrl+Left`) to collapse the sidebar to icon-only mode. In collapsed mode:

- Agents show as icons with status indicators
- Hover for agent name tooltip
- Click to select an agent

## Tab Management

Each agent session can have multiple tabs, allowing you to work on different tasks within the same project workspace.

### Automatic Tab Naming

When you send your first message to a new tab, Maestro automatically generates a descriptive name based on your request. This helps you identify tabs at a glance without manual renaming.

**How it works:**

1. When you start a new conversation in a tab, your first message is analyzed
2. An AI generates a concise, relevant name (2-5 words)
3. The tab name updates automatically once the name is generated
4. If you've already renamed the tab, automatic naming is skipped

**Examples of generated tab names:**
| Your message | Generated name |
|--------------|----------------|
| "Help me implement user authentication with JWT" | JWT Auth Implementation |
| "Fix the bug in the checkout flow" | Checkout Bug Fix |
| "Add dark mode support to the app" | Dark Mode Support |
| "Refactor the database queries" | Database Query Refactor |

**Configuring automatic tab naming:**

- Go to **Settings** (`Cmd+,` / `Ctrl+,`) → **General**
- Toggle **Automatic Tab Naming** on or off
- Default: Enabled

<Note>
Automatic tab naming uses the same AI agent as your session, including SSH remote configurations. The naming request runs in parallel with your main prompt, so there's no delay to your workflow.
</Note>

### Manual Tab Renaming

You can always rename tabs manually:

- Right-click a tab → **Rename Tab**
- Or double-click the tab name to edit it directly
- Manual names take precedence over automatic naming

## Session Management

Browse, star, rename, and resume past sessions. The Session Explorer (`Cmd+Shift+L` / `Ctrl+Shift+L`) shows all conversations for an agent with search, filtering, and quick actions.

![Session tracking](./screenshots/session-tracking.png)
