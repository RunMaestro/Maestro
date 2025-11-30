# Maestro

> A unified, highly-responsive developer command center for managing your fleet of AI coding agents.

Maestro is a desktop application that allows you to run and manage multiple AI coding instances in parallel with a Linear/Superhuman-level responsive interface. Currently supporting Claude Code with plans for additional agentic coding tools (Aider, OpenCode, etc.) based on user demand.

<img width="3592" height="2302" alt="image" src="https://github.com/user-attachments/assets/ba496fb7-708f-486c-a3ed-20a4a643a958" />


## Installation

### Download

Download the latest release for your platform from the [Releases](https://github.com/pedramamini/maestro/releases) page:

- **macOS**: `.dmg` or `.zip`
- **Windows**: `.exe` installer
- **Linux**: `.AppImage`, `.deb`, or `.rpm`

### Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Git (optional, for git-aware features)

## Features

- 🚀 **Multi-Instance Management** - Run multiple Claude Code instances and Command Terminal sessions simultaneously
- 🤖 **Automatic Runner** - Batch-process tasks using AI agents with serial execution, history tracking, and saved session per task
- 🔄 **Dual-Mode Input** - Switch between Command Terminal and AI Terminal seamlessly
- ⌨️ **Keyboard-First Design** - Built for fast flow with full keyboard control, customizable shortcuts, and rapid navigation
- 🔍 **Powerful Output Filtering** - Search, filter, and navigate output with include/exclude modes and per-response local filters
- 🎨 **Beautiful Themes** - 12 themes including Dracula, Monokai, Nord, Tokyo Night, GitHub Light, and more
- 🔀 **Git Integration** - Automatic git status, diff tracking, and workspace detection
- 📁 **File Explorer** - Browse project files with syntax highlighting and markdown preview
- 📋 **Session Management** - Group, rename, bookmark, and organize your sessions
- 📝 **Scratchpad** - Built-in markdown editor with live preview for task management
- ⚡ **Slash Commands** - Extensible command system with autocomplete
- 📬 **Message Queueing** - Queue messages while AI is busy; they're sent automatically when ready
- 🌐 **Mobile Remote Control** - Access sessions from your phone with QR codes, live sessions, and a mobile-optimized web interface
- 💰 **Cost Tracking** - Real-time token usage and cost tracking per session

> **Note**: Maestro currently supports Claude Code only. Support for other agentic coding tools may be added in future releases based on community demand.

## Architecture

Maestro organizes work into **Projects** (workspaces), each with a **CLI Terminal** and multiple **Agent Tabs**. Each tab can be connected to an **Agent Session** - either newly created or resumed from the session pool.

```mermaid
graph LR
    subgraph Maestro["Maestro App"]
        subgraph ProjectA["Project A (workspace)"]
            TermA[CLI Terminal]
            subgraph TabsA["Agent Tabs"]
                Tab1A[Tab 1]
                Tab2A[Tab 2]
            end
        end
        subgraph ProjectB["Project B (workspace)"]
            TermB[CLI Terminal]
            subgraph TabsB["Agent Tabs"]
                Tab1B[Tab 1]
                Tab2B[Tab 2]
            end
        end
    end

    subgraph SessionPool["Agent Session Pool"]
        direction TB
        S1["Session α"]
        S2["Session β"]
        S3["Session γ"]
        S4["Session δ"]
        S5["..."]
    end

    Tab1A -.->|"resume"| S1
    Tab2A -.->|"resume"| S2
    Tab1B -.->|"resume"| S3
    Tab2B -.->|"new"| S4

    style Maestro fill:#9b8cd6,stroke:#6b5b95
    style ProjectA fill:#87ceeb,stroke:#4682b4
    style ProjectB fill:#87ceeb,stroke:#4682b4
    style TermA fill:#90ee90,stroke:#228b22
    style TermB fill:#90ee90,stroke:#228b22
    style TabsA fill:#ffe4a0,stroke:#daa520
    style TabsB fill:#ffe4a0,stroke:#daa520
    style SessionPool fill:#ffb6c1,stroke:#dc143c
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Project** | A workspace tied to a directory. Contains one CLI terminal and multiple agent tabs. |
| **CLI Terminal** | A PTY shell session for running commands directly. One per project. |
| **Agent Tab** | A conversation context within a project. Each tab has its own input, images, and message history. |
| **Agent Session** | A persistent conversation with an AI coding agent. Can be resumed across tabs or app restarts. |
| **Session Pool** | All agent sessions for a project, including those created by AutoRun, manually by user, or imported. Sessions can be starred, named, and mapped to tabs. |

## UI Overview

Maestro features a three-panel layout:

- **Left Bar** - Session list with grouping, filtering, bookmarks, and organization
- **Main Window** - Center workspace with two modes:
  - **AI Terminal** - Interact with Claude Code AI assistant
  - **Command Terminal** - Execute shell commands and scripts
  - **File Preview** - View images and text documents with source highlighting and markdown rendering
  - **Diff Preview** - View the current diff when working in Git repositories
- **Right Bar** - File explorer, command history, and scratchpad

### Session Status Indicators

Each session shows a color-coded status indicator:

- 🟢 **Green** - Ready and waiting
- 🟡 **Yellow** - Agent is thinking
- 🔴 **Red** - No connection with agent
- 🟠 **Pulsing Orange** - Attempting to establish connection

## Keyboard Shortcuts

### Global Shortcuts

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Quick Actions | `Cmd+K` | `Ctrl+K` |
| Toggle Sidebar | `Cmd+B` | `Ctrl+B` |
| Toggle Right Panel | `Cmd+\` | `Ctrl+\` |
| New Agent | `Cmd+N` | `Ctrl+N` |
| Kill Agent | `Cmd+Shift+Backspace` | `Ctrl+Shift+Backspace` |
| Move Session to Group | `Cmd+Shift+M` | `Ctrl+Shift+M` |
| Previous Agent | `Cmd+Shift+{` | `Ctrl+Shift+{` |
| Next Agent | `Cmd+Shift+}` | `Ctrl+Shift+}` |
| Switch AI/Command Terminal | `Cmd+J` | `Ctrl+J` |
| Show Shortcuts Help | `Cmd+/` | `Ctrl+/` |
| Open Settings | `Cmd+,` | `Ctrl+,` |
| View Agent Sessions | `Cmd+Shift+L` | `Ctrl+Shift+L` |
| Jump to Bottom | `Cmd+Shift+J` | `Ctrl+Shift+J` |
| Cycle Focus Areas | `Tab` | `Tab` |
| Cycle Focus Backwards | `Shift+Tab` | `Shift+Tab` |

### Panel Shortcuts

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Go to Files Tab | `Cmd+Shift+F` | `Ctrl+Shift+F` |
| Go to History Tab | `Cmd+Shift+H` | `Ctrl+Shift+H` |
| Go to Scratchpad | `Cmd+Shift+S` | `Ctrl+Shift+S` |
| Toggle Markdown Raw/Preview | `Cmd+E` | `Ctrl+E` |
| Insert Checkbox (Scratchpad) | `Cmd+L` | `Ctrl+L` |

### Input & Output

| Action | Key |
|--------|-----|
| Send Message | `Enter` or `Cmd+Enter` (configurable in Settings) |
| Multiline Input | `Shift+Enter` |
| Navigate Command History | `Up Arrow` while in input |
| Slash Commands | Type `/` to open autocomplete |
| Focus Output | `Esc` while in input |
| Focus Input | `Esc` while in output |
| Open Output Search | `/` while in output |
| Scroll Output | `Up/Down Arrow` while in output |
| Page Up/Down | `Alt+Up/Down Arrow` while in output |
| Jump to Top/Bottom | `Cmd+Up/Down Arrow` while in output |

### Navigation & Search

| Action | Key |
|--------|-----|
| Navigate Sessions | `Up/Down Arrow` while in sidebar |
| Select Session | `Enter` while in sidebar |
| Open Session Filter | `/` while in sidebar |
| Navigate Files | `Up/Down Arrow` while in file tree |
| Open File Tree Filter | `/` while in file tree |
| Open File Preview | `Enter` on selected file |
| Close Preview/Filter/Modal | `Esc` |

### File Preview

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Copy File Path | `Cmd+P` | `Ctrl+P` |
| Open Search | `/` | `/` |
| Scroll | `Up/Down Arrow` | `Up/Down Arrow` |
| Close | `Esc` | `Esc` |

*Most shortcuts are customizable in Settings > Shortcuts*

## Slash Commands

Maestro includes an extensible slash command system with autocomplete:

| Command | Description |
|---------|-------------|
| `/clear` | Clear the output history for the current mode |
| `/jump` | Jump to current working directory in file tree (terminal mode only) |

Type `/` in the input area to open the autocomplete menu, use arrow keys to navigate, and press `Tab` or `Enter` to select.

### Custom AI Commands

Create your own slash commands in **Settings > Custom AI Commands**. Each command has a trigger (e.g., `/deploy`) and a prompt that gets sent to the AI agent.

Commands support **template variables** that are automatically substituted at runtime:

| Variable | Description |
|----------|-------------|
| `{{SESSION_NAME}}` | Current session name |
| `{{CLAUDE_SESSION_ID}}` | Claude Code session ID (for conversation continuity) |
| `{{PROJECT_NAME}}` | Project folder name |
| `{{PROJECT_PATH}}` | Full path to project directory |
| `{{GIT_BRANCH}}` | Current git branch (if in a git repo) |
| `{{DATE}}` | Current date (YYYY-MM-DD) |
| `{{TIME}}` | Current time (HH:MM:SS) |
| `{{WEEKDAY}}` | Day of week (Monday, Tuesday, etc.) |

**Example**: A custom `/standup` command with prompt:
```
It's {{WEEKDAY}}, {{DATE}}. I'm on branch {{GIT_BRANCH}} in {{PROJECT_NAME}}.
Summarize what I worked on yesterday and suggest priorities for today.
```

See the full list of available variables in the **Template Variables** section within the Custom AI Commands panel.

## Automatic Runner

The Automatic Runner lets you batch-process tasks using AI agents. Define your tasks as markdown checkboxes in the Scratchpad, and Maestro will work through them one by one, spawning a fresh AI session for each task.

### Creating Tasks

Use markdown checkboxes in the Scratchpad tab:

```markdown
- [ ] Implement user authentication
- [ ] Add unit tests for the login flow
- [ ] Update API documentation
```

**Tip**: Press `Cmd+L` (Mac) or `Ctrl+L` (Windows/Linux) to quickly insert a new checkbox at your cursor position.

### Running the Automation

1. Navigate to the **Scratchpad** tab in the right panel
2. Add your tasks as unchecked markdown checkboxes (`- [ ]`)
3. Click the **Run** button (or the ▶ icon)
4. Customize the agent prompt if needed, then click **Go**

The runner will:
- Process tasks serially from top to bottom
- Spawn a fresh AI session for each task
- Mark tasks as complete (`- [x]`) when done
- Log each completion to the **History** panel

### History & Tracking

Each completed task is logged to the History panel with:
- **AUTO** label indicating automated execution
- **Session ID** pill (clickable to jump to that AI conversation)
- **Summary** of what the agent accomplished
- **Full response** viewable by clicking the entry

**Keyboard navigation in History**:
- `Up/Down Arrow` - Navigate entries
- `Enter` - View full response
- `Esc` - Close detail view and return to list

### Read-Only Mode

While automation is running, the AI operates in **read-only/plan mode**. You can still send messages to review progress, but the agent won't make changes. This prevents conflicts between manual interactions and automated tasks.

The input area shows a **READ-ONLY** indicator with a warning-tinted background during automation.

### Stopping the Runner

Click the **Stop** button at any time. The runner will:
- Complete the current task before stopping
- Preserve all completed work
- Allow you to resume later by clicking Run again

### Parallel Batches

You can run separate batch processes in different Maestro sessions simultaneously. Each session maintains its own independent batch state.

## Configuration

Settings are stored in:

- **macOS**: `~/Library/Application Support/maestro/`
- **Windows**: `%APPDATA%/maestro/`
- **Linux**: `~/.config/maestro/`

## Remote Access

Maestro includes a built-in web server for mobile remote control:

1. **Automatic Security**: Web server runs on a random port with an auto-generated security token embedded in the URL
2. **QR Code Access**: Scan a QR code to connect instantly from your phone
3. **Global Access**: All sessions are accessible when the web interface is enabled - the security token protects access

### Mobile Web Interface

The mobile web interface provides:
- Real-time session monitoring and command input
- Device color scheme preference support (light/dark mode)
- Connection status indicator with automatic reconnection
- Offline queue for commands typed while disconnected
- Swipe gestures for common actions
- Quick actions menu for the send button

To access sessions from your phone:
1. Click the "OFFLINE" button in the header (next to the MAESTRO logo) to enable the web interface
2. The button changes to "LIVE" and shows a QR code overlay
3. Scan the QR code or copy the secure URL to access all your sessions remotely
4. Click "LIVE" again to view the QR code, or toggle off to disable remote access

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture details, and contribution guidelines.

## License

[MIT License](LICENSE)
