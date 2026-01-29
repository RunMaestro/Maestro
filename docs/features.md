---
title: Features
description: Explore Maestro's power features including Git Worktrees, Auto Run, Group Chat, and Remote Access.
icon: sparkles
---

## Power Features

- 🌳 **[Git Worktrees](./git-worktrees)** - Run AI agents in parallel on isolated branches. Create worktree sub-agents from the git branch menu, each operating in their own directory. Work interactively in the main repo while sub-agents process tasks independently — then create PRs with one click. True parallel development without conflicts.
- 🤖 **[Auto Run & Playbooks](./autorun-playbooks)** - File-system-based task runner that processes markdown checklists through AI agents. Create Playbooks (collections of Auto Run documents) for repeatable workflows, run in loops, and track progress with full history. Each task gets its own AI session for clean conversation context.
- 🏪 **[Playbook Exchange](./playbook-exchange)** - Browse and import community-contributed playbooks directly into your Auto Run folder. Categories, search, and one-click import get you started with proven workflows for security audits, code reviews, documentation, and more.
- 🎵 **[Maestro Symphony](./symphony)** - Contribute to open source by donating AI tokens. Browse registered projects, select GitHub issues, and let Maestro clone, process Auto Run docs, and create PRs automatically. Distributed computing for AI-assisted development.
- 💬 **[Group Chat](./group-chat)** - Coordinate multiple AI agents in a single conversation. A moderator AI orchestrates discussions, routing questions to the right agents and synthesizing their responses for cross-project questions and architecture discussions.
- 🌐 **[Remote Access](./remote-access)** - Built-in web server with QR code access. Monitor and control all your agents from your phone. Supports local network access and remote tunneling via Cloudflare for access from anywhere.
- 🔗 **[SSH Remote Execution](./ssh-remote-execution)** - Run AI agents on remote hosts via SSH. Leverage powerful cloud VMs, access tools not installed locally, or work with projects requiring specific environments — all while controlling everything from your local Maestro instance.
- 💻 **[Command Line Interface](./cli)** - Full CLI (`maestro-cli`) for headless operation. List agents/groups, run playbooks from cron jobs or CI/CD pipelines, with human-readable or JSONL output for scripting.
- 🚀 **Multi-Agent Management** - Run unlimited agents in parallel. Each agent has its own workspace, conversation history, and isolated context.
- 📬 **Message Queueing** - Queue messages while AI is busy; they're sent automatically when the agent becomes ready. Never lose a thought.

## Core Features

- 🔄 **Dual-Mode Sessions** - Each agent has both an AI Terminal and Command Terminal. Switch seamlessly between AI conversation and shell commands with `Cmd+J` / `Ctrl+J`.
- ⌨️ **[Keyboard-First Design](./keyboard-shortcuts)** - Full keyboard control with customizable shortcuts and [mastery tracking](./achievements) that rewards you for leveling up. `Cmd+K` / `Ctrl+K` quick actions, rapid agent switching, and focus management designed for flow state.
- 📋 **Session Discovery** - Automatically discovers and imports existing sessions from all supported providers, including conversations from before Maestro was installed. Browse, search, star, rename, and resume any session.
- 🔀 **Git Integration** - Automatic repo detection, branch display, diff viewer, commit logs, and git-aware file completion. Work with git without leaving the app.
- 📁 **[File Explorer](./general-usage)** - Browse project files with syntax highlighting, markdown preview, and image viewing. Reference files in prompts with `@` mentions.
- 🕸️ **[Document Graph](./document-graph)** - Visualize markdown file relationships and wiki-link connections in an interactive graph. Navigate with keyboard shortcuts, adjust depth, and see how your documentation connects.
- 🔍 **[Powerful Output Filtering](./general-usage)** - Search and filter AI output with include/exclude modes, regex support, and per-response local filters.
- ⚡ **[Slash Commands](./slash-commands)** - Extensible command system with autocomplete. Create custom commands with template variables for your workflows. Includes bundled [Spec-Kit](./speckit-commands) for feature specifications and [OpenSpec](./openspec-commands) for change proposals.
- 💾 **Draft Auto-Save** - Never lose work. Drafts are automatically saved and restored per session.
- 🔊 **Speakable Notifications** - Audio alerts with text-to-speech announcements when agents complete tasks.
- 🎨 **[Beautiful Themes](https://github.com/pedramamini/Maestro/blob/main/THEMES.md)** - 17 built-in themes across dark (Dracula, Monokai, Nord, Tokyo Night, Catppuccin Mocha, Gruvbox Dark), light (GitHub, Solarized, One Light, Gruvbox Light, Catppuccin Latte, Ayu Light), and vibe (Pedurple, Maestro's Choice, Dre Synth, InQuest) categories, plus a fully customizable theme builder.
- 💰 **Cost Tracking** - Real-time token usage and cost tracking per session and globally.
- 📊 **[Usage Dashboard](./usage-dashboard)** - Comprehensive analytics for tracking AI usage patterns. View aggregated statistics, compare agent performance, analyze activity heatmaps, and export data to CSV. Access via `Opt+Cmd+U` / `Alt+Ctrl+U`.
- 🏆 **[Achievements](./achievements)** - Level up from Apprentice to Titan of the Baton based on cumulative Auto Run time. 11 conductor-themed ranks to unlock.

> **Note**: Maestro currently supports Claude Code, Codex (OpenAI), OpenCode, and Factory Droid as fully-integrated providers. Support for additional providers (Gemini CLI, Qwen3 Coder) is planned for future releases based on community demand.
