---
title: Getting Started
description: Get from install to your first productive session with Maestro in minutes.
icon: rocket
---

This guide gets you from install to a first productive session with Maestro.

## 1. Install and launch

Follow the [Installation](./installation) instructions for your platform, then launch Maestro.

## 2. Create an agent (or use the Wizard)

Maestro supports **Claude Code**, **OpenAI Codex**, and **OpenCode** as providers. Make sure at least one is installed and authenticated.

**Option A: Quick Setup**
Create your first agent manually using the **+** button in the sidebar.

**Option B: Onboarding Wizard** (Recommended for new users)
Press `Cmd+Shift+N` / `Ctrl+Shift+N` to launch the **Onboarding Wizard**, which guides you through:
1. Selecting an AI provider
2. Choosing your project directory
3. Having a discovery conversation where the AI learns about your project
4. Generating an initial Auto Run document with tasks

The Wizard creates a fully configured agent with an Auto Run document folder ready to go.

### Introductory Tour

After completing the Wizard, you'll be offered an **Introductory Tour** that highlights key UI elements:
- The AI Terminal and how to interact with it
- The Auto Run panel and how batch processing works
- File Explorer and preview features
- Keyboard shortcuts for power users

You can skip the tour and access it later via **Quick Actions** (`Cmd+K` / `Ctrl+K`) → "Start Tour".

## 3. Open a project

Point your new agent at a project directory. Maestro will detect git repos automatically and enable git-aware features like diffs, logs, and worktrees.

## 4. Start a conversation

Use the **AI Terminal** to talk with your AI provider, and the **Command Terminal** for shell commands. Toggle between them with `Cmd+J` / `Ctrl+J`. Each tab in the AI Terminal is a separate session.

## 5. Try Auto Run

Create a markdown checklist, then run it through Auto Run to see the spec-driven workflow in action. See [Auto Run + Playbooks](./autorun-playbooks) for a full walkthrough.
