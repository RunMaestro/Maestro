# Maestro

[![Made with Maestro](docs/assets/made-with-maestro.svg)](https://github.com/RunMaestro/Maestro)
[![Discord](https://img.shields.io/badge/Discord-Join%20Us-5865F2?logo=discord&logoColor=white)](https://runmaestro.ai/discord)
[![User Docs](https://img.shields.io/badge/Docs-Usage%20%26%20Documentation-blue?logo=readthedocs&logoColor=white)](https://docs.runmaestro.ai/)

> Maestro hones fractured attention into focused intent.

Maestro is a cross-platform desktop app for orchestrating your fleet of AI agents and projects. It's a high-velocity solution for hackers who are juggling multiple projects in parallel. Designed for power users who live on the keyboard and rarely touch the mouse.

Collaborate with AI to create detailed specification documents, then let Auto Run execute them automatically, each task in a fresh session with clean context. Allowing for long-running unattended sessions, my current record is nearly 24 hours of continuous runtime.

Run multiple agents in parallel with a Linear/Superhuman-level responsive interface. Currently supporting **Claude Code**, **OpenAI Codex**, **OpenCode**, and **Factory Droid** with plans for additional agentic coding tools (Gemini CLI, Qwen3 Coder) based on user demand.

> **How It Works:** Maestro is a pass-through to your AI provider. Whatever MCP tools, skills, permissions, or authentication you have configured in Claude Code, Codex, or OpenCode works identically in Maestro. The only difference is we're not running interactively—each task gets a prompt and returns a response, whether it's a new session or resuming a prior one.

<div align="center">
  <a href="https://youtu.be/fmwwTOg7cyA?si=dJ89K54tGflKa5G4">
    <img src="https://github.com/user-attachments/assets/deaf601d-1898-4ede-bf5a-42e46874ebb3"
         alt="Maestro Video Thumbnail"
         width="650" />
  </a>

  <div>
    <a href="https://youtu.be/fmwwTOg7cyA?si=VOkjO6oYjCSQvM0A">~27m Walkthrough and Demo</a>
    &nbsp;|&nbsp;
    <a href="https://youtu.be/3wX5Q1I0sgI?si=oJkJDxgAWUvBXX4D">~6m Onboarding Demo</a>
  </div>
</div>

## Features

### Power Features

- 🌳 **[Git Worktrees](https://docs.runmaestro.ai/git-worktrees)** - Run AI agents in parallel on isolated branches. Create worktree sub-agents from the git branch menu, each operating in their own directory. Work interactively in the main repo while sub-agents process tasks independently—then create PRs with one click. True parallel development without conflicts.
- 🤖 **[Auto Run & Playbooks](https://docs.runmaestro.ai/autorun-playbooks)** - File-system-based task runner that batch-processes markdown checklists through AI agents. Create playbooks for repeatable workflows, run in loops, and track progress with full history. Each task gets its own AI session for clean conversation context.
- 💬 **[Group Chat](https://docs.runmaestro.ai/group-chat)** - Coordinate multiple AI agents in a single conversation. A moderator AI orchestrates discussions, routing questions to the right agents and synthesizing their responses for cross-project questions and architecture discussions.
- 🌐 **[Mobile Remote Control](https://docs.runmaestro.ai/remote-access)** - Built-in web server with QR code access. Monitor and control all your agents from your phone. Supports local network access and remote tunneling via Cloudflare for access from anywhere.
- 💻 **[Command Line Interface](https://docs.runmaestro.ai/cli)** - Full CLI (`maestro-cli`) for headless operation. List agents/groups, run playbooks from cron jobs or CI/CD pipelines, with human-readable or JSONL output for scripting.
- 🚀 **Multi-Agent Management** - Run unlimited agents and terminal sessions in parallel. Each agent has its own workspace, conversation history, and isolated context.
- 📬 **Message Queueing** - Queue messages while AI is busy; they're sent automatically when the agent becomes ready. Never lose a thought.

### Core Features

- 🔄 **Dual-Mode Sessions** - Each agent has both an AI Terminal and Command Terminal. Switch seamlessly between AI conversation and shell commands with `Cmd+J`.
- ⌨️ **[Keyboard-First Design](https://docs.runmaestro.ai/keyboard-shortcuts)** - Full keyboard control with customizable shortcuts and [mastery tracking](https://docs.runmaestro.ai/keyboard-shortcuts#keyboard-mastery) that rewards you for leveling up. `Cmd+K` quick actions, rapid agent switching, and focus management designed for flow state.
- 📋 **Session Discovery** - Automatically discovers and imports existing sessions from all supported providers, including conversations from before Maestro was installed. Browse, search, star, rename, and resume any session.
- 🔀 **Git Integration** - Automatic repo detection, branch display, diff viewer, commit logs, and git-aware file completion. Work with git without leaving the app.
- 📁 **[File Explorer](https://docs.runmaestro.ai/general-usage#file-explorer-and-preview)** - Browse project files with syntax highlighting, markdown preview, and image viewing. Reference files in prompts with `@` mentions.
- 🔍 **[Powerful Output Filtering](https://docs.runmaestro.ai/general-usage#output-filtering)** - Search and filter AI output with include/exclude modes, regex support, and per-response local filters.
- ⚡ **[Slash Commands](https://docs.runmaestro.ai/slash-commands)** - Extensible command system with autocomplete. Create custom commands with template variables for your workflows.
- 💾 **Draft Auto-Save** - Never lose work. Drafts are automatically saved and restored per session.
- 🔊 **Speakable Notifications** - Audio alerts with text-to-speech announcements when agents complete tasks.
- 🎨 **[Beautiful Themes](THEMES.md)** - 12 themes including Dracula, Monokai, Nord, Tokyo Night, GitHub Light, and more.
- 💰 **Cost Tracking** - Real-time token usage and cost tracking per session and globally.
- 🏆 **[Achievements](https://docs.runmaestro.ai/achievements)** - Level up from Apprentice to Titan of the Baton based on cumulative Auto Run time. 11 conductor-themed ranks to unlock.

### Analytics & Visualization

- 📊 **Usage Dashboard** - Comprehensive analytics for tracking AI usage patterns across all sessions. View aggregated statistics with multiple time ranges (day, week, month, year, all time), compare agent performance, analyze user vs. Auto Run activity distribution, and explore activity heatmaps. Includes CSV export, real-time updates, and configurable colorblind-friendly palettes. Access via `Opt+Cmd+U` (macOS) / `Alt+Ctrl+U` (Windows/Linux) or the Command K menu.
- 🕸️ **Document Graph** - Visual knowledge graph of your markdown documentation. Automatically discovers internal `[[wiki-links]]` and `[markdown](links)`, visualizes document relationships with interactive nodes and edges. Toggle between force-directed and hierarchical layouts, search/filter documents, navigate via keyboard, and track external link references. Includes mini-map, legend, and pagination for large directories. Access from the File Explorer context menu or Command K menu.

#### Keyboard Shortcuts for Analytics Features

**Usage Dashboard** (`Opt+Cmd+U` / `Alt+Ctrl+U`):
| Action | Key |
|--------|-----|
| Navigate view tabs | Arrow Left/Right/Up/Down |
| Move between sections | Tab / Shift+Tab |
| Jump to first/last section | Home / End |
| Close dashboard | Escape |

**Document Graph** (Command K → "Document Graph"):
| Action | Key |
|--------|-----|
| Navigate to connected node | Arrow Up/Down/Left/Right |
| Cycle through connections | Tab |
| Open selected document/link | Enter |
| Close graph | Escape |
| Search documents | Focus search input, type query |

Additional interactions: Drag nodes to reposition, scroll to zoom, use mini-map for overview.

> **Note**: Maestro supports Claude Code, OpenAI Codex, OpenCode, and Factory Droid. Support for additional agents (Gemini CLI, Qwen3 Coder) may be added in future releases based on community demand.

## Quick Start

### Installation

Download the latest release for your platform from the [Releases page](https://github.com/RunMaestro/Maestro/releases).

Or build from source:

```bash
git clone https://github.com/RunMaestro/Maestro.git
cd Maestro
npm install
npm run dev
```

### Requirements

- At least one supported AI coding agent installed and authenticated:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) - Anthropic's AI coding assistant
  - [OpenAI Codex](https://github.com/openai/codex) - OpenAI's coding agent
  - [OpenCode](https://github.com/sst/opencode) - Open-source AI coding assistant
- Git (optional, for git-aware features)

### Essential Keyboard Shortcuts

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Quick Actions | `Cmd+K` | `Ctrl+K` |
| New Agent | `Cmd+N` | `Ctrl+N` |
| Switch AI/Terminal | `Cmd+J` | `Ctrl+J` |
| Previous/Next Agent | `Cmd+[` / `Cmd+]` | `Ctrl+[` / `Ctrl+]` |
| Toggle Sidebar | `Cmd+B` | `Ctrl+B` |
| New Tab | `Cmd+T` | `Ctrl+T` |
| Usage Dashboard | `Opt+Cmd+U` | `Alt+Ctrl+U` |
| All Shortcuts | `Cmd+/` | `Ctrl+/` |

[Full keyboard shortcut reference](https://docs.runmaestro.ai/keyboard-shortcuts)

## Screenshots

<p align="center">
  <img src="docs/screenshots/main-screen.png" alt="Maestro Main Screen" width="800">
</p>

*Main screen with multiple agents and conversation*

<p align="center">
  <img src="docs/screenshots/group-chat.png" alt="Group Chat" width="800">
</p>

*Group Chat coordinates multiple AI agents in a single conversation*

<p align="center">
  <img src="docs/screenshots/cmd-k-1.png" alt="Command Palette" width="800">
</p>

*Quick Actions palette for rapid navigation (CTRL/CMD + K)*

<p align="center">
  <img src="docs/screenshots/git-diff.png" alt="Git Diff Viewer" width="800">
</p>

*Git diff viewer with syntax highlighting*

[See more...](docs/screenshots/)

## Documentation

Full documentation and usage guide available at **[docs.runmaestro.ai](https://docs.runmaestro.ai)**

- [Installation](https://docs.runmaestro.ai/installation)
- [Getting Started](https://docs.runmaestro.ai/getting-started)
- [Features Overview](https://docs.runmaestro.ai/features)
- [Auto Run + Playbooks](https://docs.runmaestro.ai/autorun-playbooks)
- [Git Worktrees](https://docs.runmaestro.ai/git-worktrees)
- [Keyboard Shortcuts](https://docs.runmaestro.ai/keyboard-shortcuts)
- [Context Management](https://docs.runmaestro.ai/context-management)
- [MCP Server](https://docs.runmaestro.ai/mcp-server) - Connect AI apps to Maestro docs
- [Troubleshooting](https://docs.runmaestro.ai/troubleshooting)

## Community

- **Discord**: [Join Us](https://runmaestro.ai/discord)
- **GitHub Issues**: [Report bugs & request features](https://github.com/RunMaestro/Maestro/issues)

## Team

Meet the team behind Maestro at [runmaestro.ai/team](https://runmaestro.ai/team/).

### Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture details, and contribution guidelines.

## License

[AGPL-3.0 License](LICENSE)
