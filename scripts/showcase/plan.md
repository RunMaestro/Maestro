# Showcase Mode (`npm run dev:showcase`)

## Overview

Add a `npm run dev:showcase` launch option that starts Maestro with a curated, pre-populated data directory at `/tmp/maestro-showcase`. On every launch the seed data is copied fresh from `scripts/showcase/seed/data/` (JSON configs and group chat data), producing a fully reproducible demo environment matching the reference screenshot. Electron creates its own internal files (cache, storage, etc.) on first launch.

## Reference Screenshot

See `scripts/showcase/screenshot.png` — the target UI state this showcase must reproduce.

---

## Screenshot Analysis

### Left Bar — Groups & Agents (12 agents, 2 groups)

| #   | Group         | Agent Name  | `toolType`      | Notes                                                      |
| --- | ------------- | ----------- | --------------- | ---------------------------------------------------------- |
| 1   | BOOKMARKS     | DATA AI     | `claude-code`   | Data analytics project                                     |
| 2   | BOOKMARKS     | OpenCode    | `opencode`      | Showcases OpenCode agent type                              |
| 3   | BOOKMARKS     | INVESTOR    | `claude-code`   | Finance/investor portal                                    |
| 4   | BOOKMARKS     | OpenAPI     | `codex`         | Showcases Codex agent type                                 |
| 5   | PROJECTS      | Maestro MCS | `claude-code`   | MCP server project                                         |
| 6   | PROJECTS      | Kinesis MCS | `claude-code`   | Streaming/event service                                    |
| 7   | PROJECTS      | **Maestro** | `claude-code`   | **Main demo agent — 5 tabs, selected, CWD = Maestro repo** |
| 8   | PROJECTS      | Prototyper  | `claude-code`   | Rapid prototyping project                                  |
| 9   | PROJECTS      | FIXinator   | `factory-droid` | Showcases Factory Droid agent type                         |
| 10  | PROJECTS      | MiriX MCP   | `claude-code`   | MCP integration project                                    |
| 11  | PROJECTS      | Stripe MCP  | `claude-code`   | Another MCP project                                        |
| 12  | _(ungrouped)_ | Development | `claude-code`   | General dev sandbox                                        |

### Main Panel — Maestro Agent (5 AI Tabs)

| Tab | Name                           | Active  | Conversation Content                                   |
| --- | ------------------------------ | ------- | ------------------------------------------------------ |
| 1   | Setup Report                   | no      | Project setup status report (build, deps, config)      |
| 2   | Growth Check                   | no      | Repo growth metrics (contributors, commits, LOC)       |
| 3   | Monthly Stats                  | no      | Monthly development summary / sprint recap             |
| 4   | **Demo Tab**                   | **yes** | User: "pitch me on Maestro…" → AI: full markdown pitch |
| 5   | Understanding the Architecture | no      | Codebase architecture overview (main/renderer/shared)  |

### Demo Tab Content (Active Tab — Must Match Screenshot)

**User prompt:**

> pitch me on Maestro. what is it all about? why should I use it? Who is it for? what can it do?

**AI response (rendered markdown):**

```markdown
# Maestro: Multi-Agent AI Coding Assistant Manager

## What Is It?

Maestro is an Electron desktop app that lets you run and manage multiple AI coding assistants simultaneously through a unified, keyboard-first interface. Think of it as a command center for AI-powered development.

## Who Is It For?

- **Power users** who work across multiple projects or repositories at once
- **Developers** who want to leverage multiple AI coding assistants without constant context-switching
- **Teams** exploring different AI tools (Claude Code, Codex, Gemini CLI, etc.)
- Anyone who prefers **keyboard-driven workflows** over mouse clicking

## Key Capabilities

### 1. Multi-Agent Management

- Run Claude Code, Codex, OpenCode, Gemini CLI, and Factory Droid side by side
- Each agent gets its own workspace with independent tabs, file trees, and terminal
- Switch between agents instantly with keyboard shortcuts (Ctrl+1-9)

### 2. Tabbed Conversations

- Multiple AI conversation tabs per agent (like browser tabs)
- Star important conversations, rename tabs, drag to reorder
- Session history with full conversation replay

### 3. Auto Run (Batch Processing)

- Queue markdown "playbook" documents for sequential execution
- Monitor progress across multiple agents simultaneously
- Pause, resume, or cancel runs at any time

### 4. Keyboard-First Design

- Every action accessible via keyboard shortcuts
- Command palette (Cmd+K) for quick navigation
- Vim-style navigation between agents and tabs

### 5. Built-in Terminal

- Integrated terminal per agent with full PTY support
- Switch between AI and shell mode seamlessly
- Terminal tabs alongside AI conversation tabs

### 6. Smart File Explorer

- Live file tree synced to each agent's working directory
- Click-to-preview any file without leaving the conversation
- Git-aware change tracking

### 7. Group Organization

- Organize agents into named groups (e.g., "Frontend", "Backend", "DevOps")
- Collapse/expand groups in the sidebar
- Drag and drop agents between groups

### 8. Web Interface

- Access any agent remotely via built-in web server
- Mobile-responsive interface for on-the-go monitoring
- Secure with optional authentication

### 9. SSH Remote Execution

- Run agents on remote hosts via SSH
- Same UI, same shortcuts — just runs on a different machine
- File explorer and terminal work transparently over SSH

### 10. Maestro Cue (Event-Driven Automation)

- Watch for file changes, GitHub events, or time intervals
- Automatically trigger agent prompts based on events
- Configure via YAML, manage via dashboard
```

### Right Bar

- **Files** tab active, showing Maestro project file tree
- History and Auto Run tabs visible but inactive

### Status Bar

- "Talking to ♪ Maestro powered by Claude"

### Settings

- Theme: Dracula
- Font size: 14
- Window: 1400×900

---

## Data Architecture

### Seed Data Pipeline

```
scripts/showcase/seed/data/     ← Curated JSON configs + group chat data
         │
         ▼  (scripts/showcase/setup.js)
/tmp/maestro-showcase/          ← Fresh copy on every launch (Electron creates its own internals)
```

### Files to Generate in `scripts/showcase/seed/data/`

| File                                  | Description                                                        |
| ------------------------------------- | ------------------------------------------------------------------ |
| `maestro-sessions.json`               | All 12 agents with full session data, tabs, and fake conversations |
| `maestro-groups.json`                 | 2 groups: BOOKMARKS (⭐), PROJECTS (📁)                            |
| `maestro-settings.json`               | Dracula theme, font 14, no API keys, no SSH, sane defaults         |
| `maestro-window-state.json`           | 1400×900, not maximized                                            |
| `maestro-claude-session-origins.json` | Origins for all `claude-code` agents                               |
| `maestro-agent-session-origins.json`  | Origins for `opencode`, `codex`, `factory-droid` agents            |

### Agent CWD Paths

| Agent       | CWD                                                                             |
| ----------- | ------------------------------------------------------------------------------- |
| **Maestro** | `$CWD` (replaced at copy time with `process.cwd()` — the Maestro repo checkout) |
| All others  | `/tmp/showcase-projects/<agent-slug>` (fake paths, don't need to exist)         |

### Session Data per Agent

**Maestro agent (7 — main showcase):**

- 5 AI tabs with rich fake conversations (see tab table above)
- `activeTabId` → Demo Tab
- `fileTree` populated with Maestro repo structure
- `contextUsage: 42` (looks active but not maxed)
- `activeTimeMs: 3600000` (1 hour of "usage")
- `usageStats` with realistic token counts

**All other agents (1–6, 8–12):**

- 1 AI tab each with a short 1-turn conversation relevant to the project name
- `state: 'idle'`
- Realistic but minimal `usageStats`

---

## Implementation Tasks

### 1. Create showcase seed data files

Generate the 6 JSON files listed above in `scripts/showcase/seed/data/`. The Maestro agent's `cwd`/`fullPath`/`projectRoot` fields use the literal string `$CWD` as a placeholder.

### 2. Create `scripts/showcase/setup.js`

Node script that:

1. `rm -rf /tmp/maestro-showcase`
2. Creates `/tmp/maestro-showcase/`
3. Copies `scripts/showcase/seed/data/*.json` → `/tmp/maestro-showcase/`
4. Copies `scripts/showcase/seed/data/group-chats/` → `/tmp/maestro-showcase/group-chats/`
5. Replaces `$CWD` → repo root in session/origin JSON files
6. Replaces `$USERDATA` → `/tmp/maestro-showcase` in group chat metadata
7. Optionally patches theme (`--theme`) and window size (`--size`) from CLI args
8. Exits 0

### 3. Add npm script

In `package.json`:

```json
"dev:showcase": "node scripts/showcase/launch.js"
```

This reuses the existing `MAESTRO_DEMO_DIR` mechanism — no new constants or code changes needed in `src/main/`. The setup script handles the curated data overlay.

### 4. Documentation

Update `CONTRIBUTING.md` to document the new script:

````markdown
### Showcase Mode

```bash
npm run dev:showcase
```
````

Starts Maestro with a curated, pre-populated data directory for demos, recordings, and presentations. Every launch resets to a clean state from seed data. The main "Maestro" agent points to the current repo checkout.

````

---

## Updating Seed Data

All seed data lives in `scripts/showcase/seed/data/`. Electron creates its own internal files (cache, storage, etc.) on first launch — no base directory is needed.

To update the seed data:

- **Edit JSON files directly** in `scripts/showcase/seed/data/` for small changes (e.g., tweaking agent names, conversations, settings).
- **Regenerate from scratch** by running the generator script:
  ```bash
  node scripts/showcase/generate-seed.js
  ```
  This rebuilds all curated JSON configs and group chat data in `scripts/showcase/seed/data/`.

---

## Open Questions

- Should showcase mode disable telemetry/Sentry to avoid noise?
- Should there be a theme override for projector readability (larger font, higher contrast)?
- Should the fake file tree data be statically baked in, or should it be generated from the actual repo at copy time?
````
