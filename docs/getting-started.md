---
title: Getting Started
description: Get from install to your first productive session with Maestro in minutes.
icon: rocket
---

This guide gets you from install to a first productive session with Maestro.

## 1. Install and launch

Follow the [Installation](./installation) instructions for your platform, then launch Maestro.

## 2. Create an agent

Maestro supports **Claude Code**, **Codex** (OpenAI), **OpenCode**, and **Factory Droid** as providers. Make sure at least one is installed and authenticated.

<Note>
Maestro is a pass-through to your provider. Your MCP tools, custom skills, permissions, and authentication all work in Maestro exactly as they do when running the provider directly. The only difference is batch mode execution—Maestro sends a prompt and receives a response rather than running an interactive session.
</Note>

Click the **New Agent** button in the bottom-left sidebar (or press `Cmd+N` / `Ctrl+N`). You'll see the **New Agent** selector:

![New Agent selector](./screenshots/new-agent-selector.png)

**Manual Setup** — Choose your agent, working directory, and configuration options directly. Best for power users who want full control.

**Guided Setup** (Recommended for new users) — Launches the **Onboarding Wizard**, which walks you through:

1. Selecting an AI provider
2. Choosing your project directory
3. Having a discovery conversation where the AI learns about your project
4. Generating an initial Auto Run Playbook with tasks

![Wizard Document Generation](./screenshots/wizard-doc-generation.png)

The Wizard creates a fully configured agent with an Auto Run document folder ready to go. Generated documents are saved to an `Initiation/` subfolder within `.maestro/playbooks/` to keep them organized separately from documents you create later.

<Note>
The guided wizard captures application input until it completes. For a lighter touch, create an agent manually, then run the `/wizard` slash command or click the wand button in the Auto Run panel. The in-tab wizard runs alongside your other work.
</Note>

### Introductory Tour

After completing the Wizard, you'll be offered an **Introductory Tour** that highlights key UI elements:

- The AI Terminal and how to interact with it
- The Auto Run panel and how document processing works
- File Explorer and preview features
- Keyboard shortcuts for power users

You can skip the tour and access it later via **Quick Actions** (`Cmd+K` / `Ctrl+K`) → "Start Tour".

## 3. Open a project

Point your new agent at a project directory. Maestro will detect git repos automatically and enable git-aware features like diffs, logs, and worktrees.

## 4. Start a conversation

Use the **AI Terminal** to talk with your AI provider, and the **Command Terminal** for shell commands. Toggle between them with `Cmd+J` / `Ctrl+J`. Each tab in the AI Terminal is a separate session.

## 5. Try Auto Run

Create a markdown checklist, then run it through Auto Run to see the spec-driven workflow in action. See [Auto Run + Playbooks](./autorun-playbooks) for a full walkthrough.
