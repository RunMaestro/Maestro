---
title: Release Notes
description: Version history and changelog for Maestro releases
icon: tag
---

# Release Notes

This page documents the version history of Maestro, including new features, improvements, and bug fixes for each release.

<Tip>
Maestro can update itself automatically! This feature was introduced in **v0.8.7** (December 16, 2025). Enable auto-updates in Settings to stay current.
</Tip>

---

## v1.0.x - Full Orchestra

**Latest: v1.0.0** | Released October 9, 2026

# 1.0.0 Highlights

Maestro 1.0 is the first major release. It brings the entire 0.18 release-candidate line to the stable channel in one step, so if you have been running stable, everything below is new to you: agents that consult each other, a fleet you can spread across windows and screens, the full app in any browser, and Auto Run that keeps working toward a goal while you are away.

🌐 **The whole Maestro app now runs in your browser.** Turn Live on and any laptop, tablet, or phone on your network gets the real desktop interface, not a cut-down companion. On a phone it switches to a layout built for thumbs, with drawers, a folding composer, swipe to dismiss, and a tab bar where a tap switches tabs and a long press opens the menu, and you can add it to your Home Screen. A large fleet opens quickly because each conversation loads when you open it. Want more than a URL standing between a browser and your machine? Turn on Web Login in Settings > Plugins and everyone signs in with a username and password, with every turn credited to the account that sent it.

💬 **Your agents can ask each other for help.** Type `@`, pick another agent, and Maestro hands it the relevant part of your conversation, runs it in the background, and brings its answer back stamped with who replied. Each consult is read-only or read/write, so you decide whether a teammate may touch your files, and Stop ends every consult a message fanned out. When your own agent is working on the same message, it holds its final reply behind a **WAITING FOR CONSULT** item until every mentioned agent has answered, then writes its reply with their findings in hand. Agents can do the same from their own shell with `maestro-cli ask`, which lands in a private thread instead of interrupting the chat you have open.

🪟 **Spread your fleet across windows and panes.** Right-click an agent and choose Move to Window to give it its own OS window on another monitor, with its tabs, files, and running turn coming along untouched. Inside any window, tile tabs together: drag a tab onto the one that is showing, or press `Ctrl+Cmd+T`, `B`, `F`, or `J` to tile a new chat, browser, file, or terminal below the pane you are in, and the new pane takes the keyboard right away. A tiled set sits in the tab bar as one chip you can rename, give an emoji, or snooze as a whole, and a tab you close and reopen goes back into the tile it came from.

🎹 **Pianola watches your agents so you do not have to.** Agents rarely fail loudly. They stop and wait for a yes, and you find four of them parked on questions twenty minutes later. Pianola is a manager agent pinned to the top of the Left Bar that watches the agents you point it at, spots the ones waiting on a permission prompt, a plan, or a question, and either answers from a rule you wrote or escalates to you. Its Dashboard shows who needs you, who is working, and every decision it made and why, and it can read your past transcripts to suggest rules that match how you already answer. Pianola is an opt-in plugin, and with no rules it only reports.

🎯 **Auto Run can chase a goal, show its work, and pick itself back up.** Switch the Run dialog to Goal-Driven, describe the objective in plain English, and each pass makes one increment of progress until the goal is met, a real blocker stops it, or progress stalls. `maestro-cli goal-run` runs the same thing headless. The Thought Stream shows a running agent's reasoning with every tool call reduced to one plain line, and its compass button is now where you steer a run, so a message typed in the chat goes to the agent again. A run that hits a usage limit resumes by itself once the window reopens, even across a restart, and a run stopped by an ordinary error retries on its own a few times before it asks for you.

🧩 **Encore Features become plugins, and two new ones let agents see what you see.** Settings > Plugins lists every built-in feature as a card with its permissions spelled out, and the same catalog is ready for third-party plugins once you switch them on. Coworking lets Claude Code, Codex, OpenCode, and Factory Droid read your terminal scrollback and look at your in-app browser tabs, so an agent can see the stack trace your dev server just printed without you pasting it. Clicking and typing are allowed only for agents you add to a list that starts empty, and every action is audited. Concerto lets an agent answer with something you can look at: live panels of stats, tables, and progress on a floating stage. Both stay off until you turn them on.

🤖 **Five more providers join the lineup.** Antigravity CLI, Grok CLI, Hermes, Oh My Pi, and Pi now run alongside Claude Code, Codex, OpenCode, Factory Droid, and Copilot CLI, locally or over SSH, and the provider pickers only offer the ones your machine can actually run.

## Also in 1.0.0

- 🗣️ **Group Chat is out of Beta.** Its queue belongs to the room, so it is the same on every device, survives a reload or a quit, and pauses when you press Stop All. New Group Chat moves to `Opt+Cmd+G`, since `Opt+Cmd+C` now opens the Concerto stage.
- 🔑 **Claude Code gets a Standard permission mode**: click the permission pill to cycle Full Access, Standard, and Read-Only, and in Standard every approval and ask-back question shows up in Maestro for you to answer inline.
- 📁 **Give an agent extra directories** in Edit Agent, each with its own read and write switch and an optional note on what it is for, passed to the provider natively wherever it supports that.
- 🕸️ **The Git Log is a real branch graph** you can walk from the keyboard, search with `/` across hashes, messages, authors, branches, and dates, and switch branches from a dropdown.
- 🧭 **Codex replies become clickable.** Suggested next steps turn into chips that send the prompt, file references open the file, review comments render as cards, and git suggestions show the exact command before you run it.
- 🪝 **Fire a Cue pipeline from anything that can send an HTTP request** with the new generic webhook trigger.
- 📊 **The Usage Dashboard gains a Delegation Score**, one number for how much of your AI time runs without you, and its Tokens and Cost cards now follow the time range you pick.
- 📈 **Click the context gauge for the Context Timeline**, a turn-by-turn record of how a conversation filled its context window.
- 🗂️ **Groups+ nests groups two levels deep** and gives them icons and label colors, as an opt-in plugin that `maestro-cli create-group` and `update-group` can script.
- 🪶 **A Utility Agent setting sends tab naming and context grooming** to a cheaper or faster agent of your choosing, under Settings > General.
- 💳 **Redeem a Codex usage reset credit from the Usage Dashboard**, or opt into auto-reset and let Maestro spend one when your workspace runs dry.
- ⏳ **A turn an outage sends back to the queue wears an "Awaiting retry" badge**, so a prompt sitting in both the transcript and the queue no longer looks like a double send.
- 📨 **`maestro-cli dispatch --notify-on-complete` wakes the calling agent** with the result once the work it handed off is done.
- 😴 **Snooze a tab with a prompt to run the moment it wakes**, or park a whole tiled group, layout and all.
- 🔐 **SSH remotes take their own `ssh -o` options**, so a bastion host or an unusual transport is a setting instead of a workaround.
- 🆕 **Right-click a folder in the Files panel and choose New Agent Here** to start an agent right there.
- ✏️ **Rename a file preview tab**, and scroll a crowded tab strip with the mouse wheel.
- 🔔 **Every toast shows the time it arrived**, so a notification you come back to later still makes sense.
- 🎨 **Indigo Blue joins the theme list.**
- 🧠 **The model pill takes any model ID you type**, even one discovery cannot see, and Claude Code's model list now comes straight from Claude Code.
- 🖤 **A window whose renderer dies reloads itself** instead of sitting there black.
- ⏎ **A quick double Enter no longer queues a copy** of the message you just sent, while a genuinely new message typed in that moment still goes through.
- 🧜 **Mermaid timelines accept clock times and `#` in their periods**, and untagged code blocks holding a directory tree or plain prose stop lighting up as Swift.

---

## v0.17.x - Maestro Cue

**Latest: v0.17.9** | Released January 1, 1

## Also in 0.17.9

- 🕒 **Mermaid timelines take clock times and `#` in their periods.** A period like `16:18 : Email received` or a section titled `12:00 - 14:00` used to fail with a parse error, and `Issue #1710 : opened` rendered with its events silently missing. Both now draw exactly as written.

- 🌳 **Directory trees and plain prose in code blocks stop lighting up as Swift.** A fence with no language tag holding `tree` output or ordinary sentences used to get colored as Swift code. Those blocks now render as plain text, and a fence tagged `swift` still highlights.

### Previous Releases in this Series

- **v0.17.8** (October 4, 2026) - Security Release
- **v0.17.7** (October 4, 2026) - Maestro Cue
- **v0.17.6** (October 2, 2026) - Maestro Cue
- **v0.17.5** (September 25, 2026) - Maestro Cue
- **v0.17.4** (September 21, 2026) - Maestro Cue
- **v0.17.3** (July 4, 2026) - Maestro Cue
- **v0.17.2** (June 27, 2026) - Maestro Cue
- **v0.17.1** (June 20, 2026) - Maestro Cue
- **v0.17.0** (June 15, 2026) - Maestro Cue

---

## v0.15.x - Maestro Symphony

**Latest: v0.15.3** | Released April 5, 2026

# Major 0.15.x Additions

🎶 **Maestro Symphony** — Contribute to open source with AI assistance! Browse curated issues from projects with the `runmaestro.ai` label, clone repos with one click, and automatically process the relevant Auto Run playbooks. Track your contributions, streaks, and stats. You're contributing CPU and tokens towards your favorite open source projects and features.

🎬 **Director's Notes** — Aggregates history across all agents into a unified timeline with search, filters, and an activity graph. Includes an AI Overview tab that generates a structured synopsis of recent work. Off by default, gated behind a new "Encore Features" panel under settings. This is a precursor to an eventual plugin system, allowing for extensions and customizations without bloating the core app.

🏷️ **Conductor Profile** — Available under Settings > General. Provide a short description on how Maestro agents should interface with you.

🧠 **Three-State Thinking Toggle** — The thinking toggle now cycles through three modes: off, on, and sticky. Sticky mode keeps thinking content visible after the response completes. Cycle with CMD/CTRL+SHIFT+K.

🤖 **Factory.ai Droid Support** — Added support for the [Factory.ai](https://factory.ai/product/cli) droid agent. Full session management and output parsing integration.

## Changes in v0.15.3

- **CLI settings management:** Full `maestro-cli settings` command suite — list, get, set, and reset any Maestro setting from the command line. Includes per-agent configuration (custom paths, args, env vars, model overrides). Supports category filtering, verbose descriptions, and machine-readable JSON output for scripting
- **Live settings reload:** Settings changes made via the CLI are automatically detected by the running desktop app — no restart required
- **Plan-Mode toggle:** Claude Code and OpenCode agents now show "Plan-Mode" instead of "Read-Only" for the read-only toggle, matching their native terminology
- **Solarized Dark theme:** New Solarized Dark color theme with tuned contrast for tags, code blocks, and pill labels
- **Files pane icon theme:** Choose between default and rich icon themes in the files pane — rich theme adds colorful, language-specific icons for 70+ file types and folder categories. Toggle under Settings > Display
- **Persistent web link:** The web/mobile interface link now persists across app restarts — no need to re-enable it each session
- **OpenCode v1.2+ session support:** Automatically reads OpenCode's new SQLite session storage format alongside the legacy JSONL format
- **Group chat @mentions:** Use `@agent-name` syntax in the prompt composer to direct messages to specific agents in group chat
- **Group chat over SSH:** Group chat synthesis and moderation now run correctly on SSH remote agents instead of always spawning locally
- **Group chat participant management:** Remove button on participant cards lets you remove stale or unwanted participants from a group chat
- **Batch resume/abort:** New controls in the right panel for resuming or aborting batch operations
- **Default worktree directory:** Worktree configuration now defaults to the parent of the agent's working directory instead of blank
- **Drawfinity in Symphony:** Added Drawfinity to the Symphony project registry

### Previous Releases in this Series

- **v0.15.2** (March 12, 2026) - Maestro Symphony
- **v0.15.1** (March 3, 2026) - Maestro Symphony

---

## v0.14.x - Doc Graphs, SSH Agents, Inline Wizard

**Latest: v0.14.5** | Released January 24, 2026

Changes in this point release include:

- Desktop app performance improvements (more to come on this, we want Maestro blazing fast) 🐌
- Added local manifest feature for custom playbooks 📖
- Agents are now inherently aware of your activity history as seen in the history panel 📜 (this is built-in cross context memory!)
- Added markdown rendering support for AI responses in mobile view 📱
- Bugfix in tracking costs from JSONL files that were aged out 🏦
- Added BlueSky social media handle for leaderboard 🦋
- Added options to disable GPU rendering and confetti 🎊
- Better handling of large files in preview 🗄️
- Bug fix in Claude context calculation 🧮
- Addressed bug in OpenSpec version reporting 🐛

The major contributions to 0.14.x remain:

🗄️ Document Graphs. Launch from file preview or from the FIle tree panel. Explore relationships between Markdown documents that contain links between documents and to URLs.

📶 SSH support for agents. Manage a remote agent with feature parity over SSH. Includes support for Git and File tree panels. Manage agents on remote systems or in containers. This even works for Group Chat, which is rad as hell.

🧙‍♂️ Added an in-tab wizard for generating Auto Run Playbooks via `/wizard` or a new button in the Auto Run panel.

# Smaller Changes in 014.x

- Improved User Dashboard, available from hamburger menu, command palette or hotkey 🎛️
- Leaderboard tracking now works across multiple systems and syncs level from cloud 🏆
- Agent duplication. Pro tip: Consider a group of unused "Template" agents ✌️
- New setting to prevent system from going to sleep while agents are active 🛏️
- The tab menu has a new "Publish as GitHub Gist" option  📝
- The tab menu has options to move the tab to the first or last position 🔀
- [Maestro-Playbooks](https://github.com/pedramamini/Maestro-Playbooks) can now contain non-markdown assets 📙
- Improved default shell detection 🐚
- Added logic to prevent overlapping TTS notifications 💬
- Added "Toggle Bookmark" shortcut (CTRL/CMD+SHIFT+B) ⌨️
- Gist publishing now shows previous URLs with copy button 📋

Thanks for the contributions: @t1mmen @aejfager @Crumbgrabber @whglaser @b3nw @deandebeer @shadown @breki @charles-dyfis-net @ronaldeddings @jlengrand @ksylvan

### Previous Releases in this Series

- **v0.14.4** (January 11, 2026) - Doc Graphs, SSH Agents, Inline Wizard
- **v0.14.3** (January 9, 2026) - Doc Graphs, SSH Agents, Inline Wizard
- **v0.14.2** (January 7, 2026) - Doc Graphs, SSH Agents, Inline Wizard
- **v0.14.1** (January 6, 2026) - Doc Graphs, SSH Agents, Inline Wizard
- **v0.14.0** (January 2, 2026) - Document Graphs and Agents over SSH

---

## v0.13.x - Playbook Exchange & Usage Dashboard

**Latest: v0.13.2** | Released December 29, 2025

### Changes

- TAKE TWO! Fixed Linux ARM64 build architecture contamination issues 🏗️

### v0.13.1 Changes
- Fixed Linux ARM64 build architecture contamination issues 🏗️
- Enhanced error handling for Auto Run batch processing 🚨

### v0.13.0 Changes
- Added a global usage dashboard, data collection begins with this install 🎛️
- Added a Playbook Exchange for downloading pre-defined Auto Run playbooks from [Maestro-Playbooks](https://github.com/pedramamini/Maestro-Playbooks) 📕
- Bundled OpenSpec commands for structured change proposals 📝
- Added pre-release channel support for beta/RC updates 🧪
- Implemented global hands-on time tracking across sessions ⏱️
- Added new keyboard shortcut for agent settings (Opt+Cmd+, | Ctrl+Alt+,) ⌨️
- Added directory size calculation with file/folder counts in file explorer 📊
- Added sleep detection to exclude laptop sleep from time tracking ⏰

### Previous Releases in this Series

- **v0.13.1** (December 29, 2025) - Playbook Exchange & Usage Dashboard
- **v0.13.0** (December 29, 2025) - Playbook Exchange & Usage Dashboard

---

## v0.12.x - Thinking, Spec-Kits, Context Management

**Latest: v0.12.3** | Released December 28, 2025

The big changes in the v0.12.x line are the following three:

## Show Thinking
🤔 There is now a toggle to show thinking for the agent, the default for new tabs is off, though this can be changed under Settings > General. The toggle shows next to History and Read-Only. Very similar pattern. This has been the #1 most requested feature, though personally, I don't think I'll use it as I prefer to not see the details of the work, but the results of the work. Just as we work with our colleagues. 

## GitHub Spec-Kit Integration
🎯 Added [GitHub Spec-Kit](https://github.com/github/spec-kit) commands into Maestro with a built in updater to grab the latest prompts from the repository. We do override `/speckit-implement` (the final step) to create Auto Run docs and guide the user through their execution, which thanks to Wortrees from v0.11.x allows us to run in parallel!

## Context Management Tools
📖 Added context management options from tab right-click menu. You can now compress, merge, and transfer contexts between agents. You will received (configurable) warnings at 60% and 80% context consumption with a hint to compact.

## Changes Specific to v0.12.3:
- We now have hosted documentation through Mintlify 📚
- Export any tab conversation as self-contained themed HTML file 📄
- Publish files as private/public Gists 🌐
- Added tab hover overlay menu with close operations and export 📋
- Added social handles to achievement share images 🏆

### Previous Releases in this Series

- **v0.12.1** (December 27, 2025) - Thinking, Spec-Kits, Context Management
- **v0.12.0** (December 25, 2025) - Thinking, Spec-Kits, Context Management

---

## v0.11.x - Worktrees

**Latest: v0.11.0** | Released December 22, 2025

🌳 Github Worktree support was added. Any agent bound to a Git repository has the option to enable worktrees, each of which show up as a sub-agent with their own write-lock and Auto Run capability. Now you can truly develop in parallel on the same project and issue PRs when you're ready, all from within Maestro. Huge improvement, major thanks to @petersilberman.

# Other Changes

- @ file mentions now include documents from your Auto Run folder (which may not live in your agent working directory) 🗄️
- The wizard is now capable of detecting and continuing on past started projects 🧙
- Bug fixes 🐛🐜🐞

---

## v0.10.x - Group Chat

**Latest: v0.10.2** | Released December 22, 2025

### Changes

- Export group chats as self-contained HTML ⬇️
- Enhanced system process viewer now has details view with full process args 💻
- Update button hides until platform binaries are available in releases. ⏳
- Added Auto Run stall detection at the loop level, if no documents are updated after a loop 🔁
- Improved Codex session discovery 🔍
- Windows compatibility fixes 🐛
- 64-bit Linux ARM build issue fixed (thanks @LilYoopug) 🐜
- Addressed session enumeration issues with Codex and OpenCode 🐞
- Addressed pathing issues around gh command (thanks @oliveiraantoniocc) 🐝

### Previous Releases in this Series

- **v0.10.1** (December 21, 2025) - Group Chat
- **v0.10.0** (December 21, 2025) - Group Chat

---

## v0.9.x - Codex & OpenCode Support

**Latest: v0.9.1** | Released December 18, 2025

### Changes

- Add Sentry crashing reporting monitoring with opt-out 🐛
- Stability fixes on v0.9.0 along with all the changes it brought along, including...
  - Major refactor to enable supporting of multiple providers 👨‍👩‍👧‍👦
  - Added OpenAI Codex support 👨‍💻
  - Added OpenCode support 👩‍💻
  - Error handling system detects and recovers from agent failures 🚨
  - Added option to specify CLI arguments to AI providers ✨
  - Bunch of other little tweaks and additions 💎

### Previous Releases in this Series

- **v0.9.0** (December 18, 2025) - Codex & OpenCode Support

---

## v0.8.x - Nudge Messages

**Latest: v0.8.8** | Released December 17, 2025

### Changes

- Added "Nudge" messages. Short static copy to include with every interactive message sent, perhaps to remind the agent on how to work 📌
- Addressed various resource consumption issues to reduce battery cost 📉
- Implemented fuzzy file search in quick actions for instant navigation 🔍
- Added "clear" command support to clean terminal shell logs 🧹
- Simplified search highlighting by integrating into markdown pipeline ✨
- Enhanced update checker to filter prerelease tags like -rc, -beta 🚀
- Fixed RPM package compatibility for OpenSUSE Tumbleweed 🐧 (H/T @JOduMonT)
- Added libuuid1 support alongside standard libuuid dependency 📦
- Introduced Cmd+Shift+U shortcut for tab unread toggle ⌨️
- Enhanced keyboard navigation for marking tabs unread 🎯
- Expanded Linux distribution support with smart dependencies 🌐
- Major underlying code re-structuring for maintainability 🧹
- Improved stall detection to allow for individual docs to stall out while not affecting the entire playbook 📖 (H/T @mattjay)
- Added option to select a static listening port for remote control 🎮 (H/T @b3nw)

### Previous Releases in this Series

- **v0.8.7** (December 16, 2025) - Automatic Updates
- **v0.8.6** (December 16, 2025) - Markdown Improvements
- **v0.8.5** (December 15, 2025) - Worktrees
- **v0.8.4** (December 14, 2025) - Leaderboard
- **v0.8.3** (December 14, 2025) - Leaderboard
- **v0.8.2** (December 14, 2025) - RunMaestro.ai Leaderboard
- **v0.8.1** (December 13, 2025) - RunMaestro.ai Leaderboard (Signed!)
- **v0.8.0** (December 12, 2025) - RunMaestro.ai Leaderboard

---

## v0.7.x - Onboarding and Interface Tour

**Latest: v0.7.4** | Released December 12, 2025

Minor bugfixes on top of v0.7.3:

# Onboarding, Wizard, and Tours
- Implemented comprehensive onboarding wizard with integrated tour system 🚀
- Added project-understanding confidence display to wizard UI 🎨
- Enhanced keyboard navigation across all wizard screens ⌨️
- Added analytics tracking for wizard and tour completion 📈
- Added First Run Celebration modal with confetti animation 🎉

# UI / UX Enhancements
- Added expand-to-fullscreen button for Auto Run interface 🖥️
- Created dedicated modal component and improved modal priority constants for expanded Auto Run view 📐
- Enhanced user experience with fullscreen editing capabilities ✨
- Fixed tab name display to correctly show full name for active tabs 🏷️
- Added performance optimizations with throttling and caching for scrolling ⚡
- Implemented drag-and-drop reordering for execution queue items 🎯
- Enhanced toast context with agent name for OS notifications 📢

# Auto Run Workflow Improvements
- Created phase document generation for Auto Run workflow 📄
- Added real-time log streaming to the LogViewer component 📊

# Application Behavior / Core Fixes
- Added validation to prevent nested worktrees inside the main repository 🚫
- Fixed process manager to properly emit exit events on errors 🔧
- Fixed process exit handling to ensure proper cleanup 🧹

# Update System
- Implemented automatic update checking on application startup 🚀
- Added settings toggle for enabling/disabling startup update checks ⚙️

### Previous Releases in this Series

- **v0.7.3** (December 12, 2025) - Onboarding and Interface Tour
- **v0.7.2** (December 9, 2025)
- **v0.7.1** (December 8, 2025)
- **v0.7.0** (December 7, 2025) - Maestro CLI

---

## v0.6.x - Autorun Overhaul

**Latest: v0.6.1** | Released December 4, 2025

In this release...
- Added recursive subfolder support for Auto Run markdown files 🗂️
- Enhanced document tree display with expandable folder navigation 🌳
- Enabled creating documents in subfolders with path selection 📁
- Improved batch runner UI with inline progress bars and loop indicators 📊
- Fixed execution queue display bug for immediate command processing 🐛
- Added folder icons and better visual hierarchy for document browser 🎨
- Implemented dynamic task re-counting for batch run loop iterations 🔄
- Enhanced create document modal with location selector dropdown 📍
- Improved progress tracking with per-document completion visualization 📈
- Added support for nested folder structures in document management 🏗️

Plus the pre-release ALPHA...
- Template vars now set context in default autorun prompt 🚀
- Added Enter key support for queued message confirmation dialog ⌨️
- Kill process capability added to System Process Monitor 💀
- Toggle markdown rendering added to Cmd+K Quick Actions 📝
- Fixed cloudflared detection in packaged app environments 🔧
- Added debugging logs for process exit diagnostics 🐛
- Tab switcher shows last activity timestamps and filters by project 🕐
- Slash commands now fill text on Tab/Enter instead of executing ⚡
- Added GitHub Actions workflow for auto-assigning issues/PRs 🤖
- Graceful handling for playbooks with missing documents implemented ✨
- Added multi-document batch processing for Auto Run 🚀
- Introduced Git worktree support for parallel execution 🌳
- Created playbook system for saving run configurations 📚
- Implemented document reset-on-completion with loop mode 🔄
- Added drag-and-drop document reordering interface 🎯
- Built Auto Run folder selector with file management 📁
- Enhanced progress tracking with per-document metrics 📊
- Integrated PR creation after worktree completion 🔀
- Added undo/redo support in document editor ↩️
- Implemented auto-save with 5-second debounce 💾

### Previous Releases in this Series

- **v0.6.0** (December 4, 2025)

---

## v0.5.x

**Latest: v0.5.1** | Released December 2, 2025

### Changes

- Added "Made with Maestro" badge to README header 🎯
- Redesigned app icon with darker purple color scheme 🎨
- Created new SVG badge for project attribution 🏷️
- Added side-by-side image diff viewer for git changes 🖼️
- Enhanced confetti animation with realistic cannon-style bursts 🎊
- Fixed z-index layering for standing ovation overlay 📊
- Improved tab switcher to show all named sessions 🔍
- Enhanced batch synopsis prompts for cleaner summaries 📝
- Added binary file detection in git diff parser 🔧
- Implemented git file reading at specific refs 📁

### Previous Releases in this Series

- **v0.5.0** (December 2, 2025) - Tunnel Support

---

## v0.4.x

**Latest: v0.4.1** | Released December 2, 2025

### Changes

- Added Tab Switcher modal for quick navigation between AI tabs 🚀
- Implemented @ mention file completion for AI mode references 📁
- Added navigation history with back/forward through sessions and tabs ⏮️
- Introduced tab completion filters for branches, tags, and files 🌳
- Added unread tab indicators and filtering for better organization 📬
- Implemented token counting display with human-readable formatting 🔢
- Added markdown rendering toggle for AI responses in terminal 📝
- Removed built-in slash commands in favor of custom AI commands 🎯
- Added context menu for sessions with rename, bookmark, move options 🖱️
- Enhanced file preview with stats showing size, tokens, timestamps 📊
- Added token counting with js-tiktoken for file preview stats bar 🔢
- Implemented Tab Switcher modal for fuzzy-search navigation (Opt+Cmd+T) 🔍
- Added Save to History toggle (Cmd+S) for automatic work synopsis tracking 💾
- Enhanced tab completion with @ mentions for file references in AI prompts 📎
- Implemented navigation history with back/forward shortcuts (Cmd+Shift+,/.) 🔙
- Added git branches and tags to intelligent tab completion system 🌿
- Enhanced markdown rendering with syntax highlighting and toggle view 📝
- Added right-click context menus for session management and organization 🖱️
- Improved mobile app with better WebSocket reconnection and status badges 📱

### Previous Releases in this Series

- **v0.4.0** (December 1, 2025) - Achievements Unlocked

---

## v0.3.x

**Latest: v0.3.1** | Released November 30, 2025

### Changes

- Fixed tab handling requiring explicitly selected Claude session 🔧
- Added auto-scroll navigation for slash command list selection ⚡
- Implemented TTS audio feedback for toast notifications speak 🔊
- Fixed shortcut case sensitivity using lowercase key matching 🔤
- Added Cmd+Shift+J shortcut to jump to bottom instantly ⬇️
- Sorted shortcuts alphabetically in help modal for discovery 📑
- Display full commit message body in git log view 📝
- Added expand/collapse all buttons to process tree header 🌳
- Support synopsis process type in process tree parsing 🔍
- Renamed "No Group" to "UNGROUPED" for better clarity ✨

### Previous Releases in this Series

- **v0.3.0** (November 30, 2025) - Tab Support Release

---

## v0.2.x

**Latest: v0.2.3** | Released November 29, 2025

• Enhanced mobile web interface with session sync and history panel 📱
• Added ThinkingStatusPill showing real-time token counts and elapsed time ⏱️
• Implemented task count badges and session deduplication for batch runner 📊
• Added TTS stop control and improved voice synthesis compatibility 🔊
• Created image lightbox with navigation, clipboard, and delete features 🖼️
• Fixed UI bugs in search, auto-scroll, and sidebar interactions 🐛
• Added global Claude stats with streaming updates across projects 📈
• Improved markdown checkbox styling and collapsed palette hover UX ✨
• Enhanced scratchpad with search, image paste, and attachment support 🔍
• Added splash screen with logo and progress bar during startup 🎨

### Previous Releases in this Series

- **v0.2.2** (November 29, 2025)
- **v0.2.1** (November 28, 2025)
- **v0.2.0** (November 28, 2025) - Web Remote Release

---

## v0.1.x

**Latest: v0.1.6** | Released November 27, 2025

• Added template variables for dynamic AI command customization 🎯
• Implemented session bookmarking with star icons and dedicated section ⭐
• Enhanced Git Log Viewer with smarter date formatting 📅
• Improved GitHub release workflow to handle partial failures gracefully 🔧
• Added collapsible template documentation in AI Commands panel 📚
• Updated default commit command with session ID traceability 🔍
• Added tag indicators for custom-named sessions visually 🏷️
• Improved Git Log search UX with better focus handling 🎨
• Fixed input placeholder spacing for better readability 📝
• Updated documentation with new features and template references 📖

### Previous Releases in this Series

- **v0.1.5** (November 27, 2025)
- **v0.1.4** (November 27, 2025)
- **v0.1.3** (November 27, 2025)
- **v0.1.2** (November 27, 2025)

---

## Downloading Releases

All releases are available on the [GitHub Releases page](https://github.com/RunMaestro/Maestro/releases).

Maestro is available for:
- **macOS** - Apple Silicon (arm64) and Intel (x64)
- **Windows** - x64
- **Linux** - x64 and arm64, AppImage, deb, and rpm packages
