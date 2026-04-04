---
title: Release Notes
description: Version history and changelog for Maestro releases
---

# Release Notes

This page documents the version history of Maestro, including new features, improvements, and bug fixes for each release.

<Tip>
Maestro can update itself automatically! This feature was introduced in **v0.8.7** (December 16, 2025). Enable auto-updates in Settings to stay current.
</Tip>

---

## v0.15.x - Maestro Symphony

**Latest: v0.15.3** | Released January 1, 1

# Major 0.15.x Additions

🎶 **Maestro Symphony** — Contribute to open source with AI assistance! Browse curated issues from projects with the `runmaestro.ai` label, clone repos with one click, and automatically process the relevant Auto Run playbooks. Track your contributions, streaks, and stats. You're contributing CPU and tokens towards your favorite open source projects and features.

🎬 **Director's Notes** — Aggregates history across all agents into a unified timeline with search, filters, and an activity graph. Includes an AI Overview tab that generates a structured synopsis of recent work. Off by default, gated behind a new "Encore Features" panel under settings. This is a precursor to an eventual plugin system, allowing for extensions and customizations without bloating the core app.

🏷️ **Conductor Profile** — Available under Settings > General. Provide a short description on how Maestro agents should interface with you.

🧠 **Three-State Thinking Toggle** — The thinking toggle now cycles through three modes: off, on, and sticky. Sticky mode keeps thinking content visible after the response completes. Cycle with CMD/CTRL+SHIFT+K.

🤖 **Factory.ai Droid Support** — Added support for the [Factory.ai](https://factory.ai/product/cli) droid agent. Full session management and output parsing integration.

## Changes in v0.15.3

Patch release with new features, SSH remote hardening, markdown unification, and cross-platform fixes.

### New Features

- **Files pane icon theme:** Choose between default and rich icon themes in the files pane — rich theme adds colorful, language-specific icons for 70+ file types and folder categories. Toggle under Settings > Display
- **Persistent web link:** The web/mobile interface link now persists across app restarts — no need to re-enable it each session
- **OpenCode v1.2+ session support:** Automatically reads OpenCode's new SQLite session storage format alongside the legacy JSONL format
- **Group chat @mentions:** Use `@agent-name` syntax in the prompt composer to direct messages to specific agents in group chat
- **Batch resume/abort:** New controls in the right panel for resuming or aborting batch operations
- **Default worktree directory:** Worktree configuration now defaults to the parent of the agent's working directory instead of blank
- **Drawfinity in Symphony:** Added Drawfinity to the Symphony project registry

### Bug Fixes

- **Windows quit handler:** Safety timeout prevents the app from lingering indefinitely on Windows when quit cleanup stalls
- **Windows stop button:** Stop/cancel button now correctly terminates Claude Code agents on Windows
- **Lightbox copy-to-clipboard:** Image copy in lightbox now uses Electron's native clipboard API for reliable cross-platform behavior
- **openExternal URL validation:** Guards against relative paths and hardens URL validation before opening external links
- **PTY spawn failures:** Graceful error handling when terminal process spawn fails instead of silent failure
- **Toast notification z-index:** Toast notifications now render above modal backdrops via React portal
- **SSH remote wizard support:** Full SSH remote ID threading through wizard file operations — documents read, write, and save correctly on remote hosts
- **Auto Run subfolder path:** Fixed disk fallback path for Auto Run document retrieval when using subfolders
- **Git push PATH:** Resolved PATH issues that could cause git push to fail in certain environments
- **Execution queue drag-and-drop:** Fixed drag-and-drop reordering failing when the execution queue contains only 2 items
- **Sentry-reported crash guards:** Defensive null checks in error pattern matching, session storage readers, and CLI activity monitoring to prevent crashes reported via Sentry
- **Version manager PATH:** Agent spawning now includes version manager binary directories (nvm, fnm, mise, etc.) in the expanded PATH
- **WebContents crash handler:** Restored the renderer crash handler that was accidentally removed during a prior refactor
- **Icon theme defaults:** Invalid icon theme values now fall back gracefully; restored rich JSON and YAML icons
- **Sidebar empty group spacer:** Removed unnecessary spacer for collapsed empty groups in the left bar
- **Group chat idempotent participants:** `addParticipant` is now idempotent, preventing duplicate entries

### Mobile

- **Remote session stability:** Stabilized mobile remote session UI with improved composer, scoped drafts, and connection handling

### Internal

- **Markdown rendering unification:** Centralized markdown presets and plugins across renderer, wizard, release notes, and mobile into shared configuration
- **RC branch CI:** CI pipelines, Sentry source maps, and CodeRabbit reviews now work on release candidate branches
- **Cross-platform test suite:** 57 tests converted to run correctly on Windows, Linux, and macOS
- **Shared utilities:** Extracted `getParentDir` helper to `shared/formatters` for reuse across main and renderer

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
- The tab menu has a new "Publish as GitHub Gist" option 📝
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
- **v0.1.1** (November 27, 2025)
- **v0.1.0** (November 27, 2025)

---

## Downloading Releases

All releases are available on the [GitHub Releases page](https://github.com/RunMaestro/Maestro/releases).

Maestro is available for:

- **macOS** - Apple Silicon (arm64) and Intel (x64)
- **Windows** - x64
- **Linux** - x64 and arm64, AppImage, deb, and rpm packages
