---
title: Getting Started
description: Get from install to your first productive session with Maestro in minutes.
icon: rocket
---

This guide gets you from install to a first productive session with Maestro.

## 1. Install and launch

Follow the [Installation](./installation) instructions for your platform, then launch Maestro.

### First run

The first time Maestro opens, it asks three short questions before getting out of the way. Every answer is an ordinary setting you can change later, and **Back** steps you through the series in either direction.

**Choose your typography.** Two presets, previewed side by side on real sample text:

![The first-run typography chooser](./screenshots/onboarding-typography.png)

- **Default** - proportional to read, monospace to work. The interface, AI chat, and file preview use a proportional face; the terminal and file editor stay monospace.
- **Hacker** - monospace everywhere.

Pick either, or **Fine-tune in Settings** to set a font per surface right away. See [Typography](./configuration#typography).

**Pick a theme.** Click any theme to try it on - the whole app changes as you browse, and nothing is saved until you keep it. Dark and light sets are offered separately. See [Themes](./configuration).

**Your Agents Can Drive Maestro.** The closing screen makes a point worth reading, because it is the part people miss: you just set your typography and theme by hand, and you did not have to. Agents running inside Maestro reach the same controls the interface does, so you can ask for what you want in plain language instead of finding the screen.

![The first-run screen explaining that agents can drive Maestro](./screenshots/onboarding-agent-powers.png)

Examples it offers, all of which work:

- "Set my AI chat font to Inter, switch me to a light theme, and turn on OS notifications."
- "Create a new agent called Scratch pointed at my home directory."
- "Every weekday at 9am, summarize what changed in this repo overnight."
- "Whenever a pull request opens on this repo, have an agent review it and report back."

Maestro is a keyboard-first power tool, and it rewards learning the shortcuts. It does not require it.

## 2. Create an agent

Maestro supports **Claude Code**, **Codex** (OpenAI), and **OpenCode**, plus **Factory Droid**, **Copilot-CLI**, **Hermes**, **Pi**, **Qwen3 Coder**, and **Oh My Pi** in beta. Make sure at least one is installed and authenticated.

<Note>
Maestro is a pass-through to your provider. Your MCP tools, custom skills, permissions, and authentication all work in Maestro exactly as they do when running the provider directly. The only difference is batch mode execution - Maestro sends a prompt and receives a response rather than running an interactive session.
</Note>

Click the **New Agent** button in the bottom-left sidebar (or press `Cmd+N` / `Ctrl+N`). You'll see the **New Agent** selector:

![New Agent selector](./screenshots/new-agent-selector.png)

**Manual Setup** - Choose your agent, working directory, and configuration options directly. Best for power users who want full control.

**Guided Setup** (Recommended for new users) - Launches the **Onboarding Wizard**, which walks you through:

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
