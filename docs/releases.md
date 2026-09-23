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

## v0.17.x - Maestro Cue

**Latest: v0.17.4** | Released September 21, 2026

# 0.17.4 Highlights

🔡 **A font for every place you read and work.** The interface, terminal, AI chat, file preview, file editor, and Document Graph each take their own face and size, or follow the interface or the terminal. Pick the Default (proportional to read, monospace to work) or Hacker (monospace everywhere) preset, save your own setup before you experiment, and zoom everything together with `Cmd+=` and `Cmd+-`. First run now walks you through typography, theme, and update channel in four short screens.

❗ **Your composer is also a command line.** Press `!` and it becomes one, with Tab completion for commands, paths, and branches. Press `!` again and plain English becomes the command. Output streams back into the conversation as a card with its exit code, its duration, and a Stop button.

🖍️ **Mark up a screenshot before you hand it over.** Draw, label, and now crop a pasted image inside Maestro, with the crop staying editable afterwards so you can widen it back out. Ask an agent to save the result and it lands in your project.

😴 **Snooze a tab you are not ready for.** Park a chat, a file, a terminal, or a browser page until "next friday 3pm" or "2 weeks", leave a note for your future self, and it comes back and taps you on the shoulder.

🕸️ **Graph a whole folder of documents, not one file at a time.** Right-click a folder to see how your notes really connect, flip through six layouts from the keyboard, and find the orphans: documents nothing links to get their own band at the bottom, which is the only way you ever see them.

📮 **The work you lined up stays lined up.** A queued message could be silently lost on its way out, and Resume Agent forgot the prompt it existed to replay the moment you quit and came back. Both are fixed, and when you do hit a plan limit Maestro now names the window you exhausted and says whether waiting is your only option.

🧭 **Steer an Auto Run without stopping it.** Type while a run is going and your message rides in front of the next task as a steering note, so a course correction costs you no extra turn and no lost momentum. It waits with an amber badge, turns green the moment a task picks it up, and you can click it back before any task sees it.

🧮 **Open a Parquet file and just look at it.** Data files far larger than your machine's memory open as a live, sortable, filterable table instead of a "binary file" card. Type `price > 100 and region in (us, eu)` and the filter runs across the whole file, not the rows on screen. Works over SSH too.


## Setting agents up

- 🧰 **A per-agent Setup Script runs inside every worktree Maestro creates**, so your `.env.local` and your installed dependencies are already there before you start work.
- 🔌 **Switch an environment variable off without deleting it.** An eye button parks any variable: it keeps its key and value and stays editable, but nothing Maestro runs can see it. Test without a proxy or an API key and put it back in one click, per agent, worktrees included.
- 🔤 **An environment variable name suggests itself.** Typing `CLAUDE_HOME` when the variable is really `CLAUDE_CONFIG_DIR` sets something the CLI ignores, and the agent then runs as if you had configured nothing at all. The name field completes as you type now, from a short per-provider list of the variables people actually reach for (account directory, credentials, gateway, model) plus every name you have already set anywhere in Maestro. Only names are remembered, never values, so a recalled `ANTHROPIC_API_KEY` is a spelling and nothing more, and anything outside the list can still be typed by hand.
- 🌿 **Every per-agent git action from three places.** Git log, diff, pull, push, branch switching, Create PR, and worktree setup from the branch pill, the Left Bar right-click menu, or the command palette. Pull and push badge how far ahead or behind you are and stream colored output you can close without killing the command. A push or fetch that fails now reads as plain text, instead of arriving with raw color codes in front of every word and every progress percentage mashed into one line.
- 🚀 **Opening a PR no longer holds the form hostage.** Send it to the background and keep working; the outcome arrives as a toast on the agent it came from, and a second attempt joins the first instead of racing it into a duplicate.
- 🔑 **Sign back in before anything is broken.** Re-authenticate Provider is in the command palette, so you can refresh expired credentials with nothing stopped. The dialog names the account you are signing into, since one provider can hold several logins and picking the wrong one is invisible until the login "succeeds" and the agent fails again.
- 🗂️ **Change an agent's provider and keep your tabs.** Moving an agent from one provider to another used to cost you the conversations open in it.
- 📁 **Move an agent to a different folder.** The working directory in Edit Agent was read-only, so a project that moved meant a new agent. It is editable now, and the Files panel, the Auto Run folder, git, and Cue all follow the agent to its new home.
- 🖥️ **`maestro-cli` runs the binary you pointed it at.** Every CLI spawn fell back to the bare command name, so a custom agent path was ignored and the desktop app and the CLI could run two different copies of the same agent. On Windows nothing ran at all. The CLI resolves the real binary now, you can pick which installation to run when several are found, and installing `maestro-cli` on Windows actually puts it on your PATH.
- 🪄 **First run stops asking for things it can work out on its own.** The agent name is optional and falls back to the folder you picked, and the agent name and the project name are finally separate, so calling an agent "Scout" no longer makes the assistant greet your project as Scout. If the folder already has files in it, the agent opens by reading the project and telling you what it found rather than asking you to describe what you are building; only an empty folder still asks. Both the discovery turns and the playbook write-up name the model they are running on, and if your repo already has its own planning there is a "skip that, just create the agent" way out before a single turn is spent. The opening turn also reliably sends now, where it used to be scheduled and then cancelled before it went anywhere, and starting an agent that generated no documents no longer swings the Right Bar over to an empty Auto Run panel.
- 🍎 **Let an agent reach your calendar, contacts, photos, and folders on macOS.** Anything an agent shelled out to was denied on the spot and in silence. Maestro now declares that whole surface, so the request reaches you as a normal macOS prompt and you decide service by service.
- 🔐 **A Group Chat participant you put on a remote host stays there.** If the SSH remote cannot be reached, Maestro says so and names it, rather than quietly running the work on your own machine against somebody else's paths.
- 🗃️ **Your groups survive a slow start.** When the group list could not be read at launch, Maestro saved the empty list over the real one and every launch after made the loss stick. One user lost 13 groups and the placement of 83 agents that way. A list Maestro never managed to read is never written now.

## Auto Run and automation

- 🔓 **A run paused at a gate can finally be answered.** A run parked on a pause gate kept the document read-only, which made the gate unanswerable: it asks you to tick the box it sits above, and the lock was exactly what stopped you. Editing and the checkboxes open back up while a run is paused, in the panel, the expanded view, and on the web.
- 🎚️ **Per-phase model and effort.** Drop a `MAESTRO:MODEL` marker above a group of tasks and cheap survey work runs small while the hard design work runs at your provider's ceiling. Markers carry a reason now, shown behind an info button, so a playbook you read back a week later can be audited instead of merely obeyed. `maestro-cli` speaks the same directives.
- 📁 **Stage a whole folder**, nested subfolders included, and the picker keeps the order you clicked rather than reordering your run into tree order.
- 📊 **A folder in the document picker shows how far along it is.** Folder rows carry a percentage and task count summed across everything beneath them, so answering "how far into this am I" no longer means expanding the folder and reading every row.
- 🛡️ **Cue can screen GitHub issues for prompt injection.** An issue body is the one Cue input a stranger can write, and it goes straight to an agent. Maestro can score that text, refuse anything that reads as an attempt to steer your agent, and show you what it blocked. Off until you supply a 0DIN token.
- 🏷️ **Cue can watch for a label.** Drop `needs-review` on a pull request or an issue and the subscription fires, filtered to the labels you name and to PRs, issues, or both.
- 🧭 **Cue pipelines lay themselves out** instead of opening as overlapping boxes, and nothing can draw on top of anything else afterwards. The Scheduled Tasks list stays readable past a hundred rows with day collapsing and an All / Once / At set times / Interval filter.
- 🗜️ **A trigger that fires a thousand times reads as one History row.** A busy heartbeat could bury everything else under hundreds of near-identical entries. Repeated runs collapse into one row with a tally ("1,382 runs - 3 failed"), a clean run that printed nothing leaves no row at all, and runs from before Maestro recorded output stop drawing twice. Choose how long Cue keeps its history, from 7 days to a year.
- 📂 **A playbooks folder on an SSH agent actually loads.** Scanning a remote Auto Run folder walked it one directory at a time, so a few hundred subfolders took minutes and the panel sat empty with no reason offered. A 528-folder remote now scans in under half a second instead of about four minutes.
- 🛑 **A playbook that merely describes halting no longer refuses to start.** An authoring agent writing "if the build breaks, halt" stopped the run before its first task, and since the marker renders as nothing you had no way to see what was blocking it. A styling task stops reading as a job for a human, too: "visually" on its own used to raise the human-step banner.
- ✍️ **The Auto Run editor is a real editor**, with syntax colors, a line gutter that follows wrapping, and search hits highlighted in place.
- 🧯 **Stopping an Auto Run leaves your chat alone.** A failing or killed task posted its error into whatever conversation happened to be open and could break that tab's ability to resume. Those errors stay on the Auto Run banner now, next to Resume, Skip, and Abort.
- 🧩 **Long prompts reach Claude whole on background runs.** Typing a long prompt in one go could silently lose kilobyte-sized pieces of it, so Cue runs went ahead on prompts with chunks missing and nothing said so. Maestro feeds the prompt in pieces, waits on Claude's reads rather than a fixed clock, and fails loudly if what arrived is not what was sent.
- 🍺 **Cue finds the tools you installed.** A Maestro opened from the Dock inherits a bare system PATH with no Homebrew on it, so anything in `/opt/homebrew/bin` came back "command not found". Cue shell commands, agent runs, and worktree setup scripts all get the full PATH now.
- 🎛️ **Cue and Director's Notes are on out of the box**, so new installs do not have to go find Encore Features first. Either one still switches off in Settings.
- ⏱️ **A run is not billed for time you were asleep**, a task only a human can do no longer stalls a playbook forever, and Auto Run commits one task per commit instead of leaving changes for a later task to pick up.

## The chat

- 📝 **Edit a queued message, and send it out of turn.** `Cmd+Shift+E` opens the last one, `Cmd+Enter` saves, and the dialog carries model and effort pickers, so a message queued against Opus can go out on Haiku without retyping it. Queued cards render markdown the way you wrote them instead of as a wall of `#` and backticks, and they only collapse when there is real text hidden behind the toggle, naming how many characters that is rather than counting newlines at you.
- ⌨️ **The Execution Queue is fully keyboard-driven.** Arrow through every queued message across every agent, press Enter for an action menu with Send Now, Edit, Delete, Hold, and Copy, titled by agent and tab.
- 🔖 **Turns show the model and effort they actually ran under**, including queued ones, which freeze their settings the moment you press Enter.
- ⏱️ **How long this took, and how long this has been.** Every agent reply carries its elapsed time in the gutter, from `<1m` up to `5d 6h 25m`, and Context Details now reports the message count and wall-clock duration of the tab, the two figures you previously had to export the whole conversation to read.
- 🔍 **`Opt+Cmd+F` searches every open tab in an agent**, grouped by tab, and hands off to that tab's find bar so next and previous carry on from there.
- 📜 **A tab opens exactly where you left it.** Coming back to a long chat used to land you above your old position, and the heavier the transcript the bigger the jump. A tab that was following live output comes back at the bottom, still following.
- 🖼️ **An agent can save a screenshot you pasted.** A pasted image reaches an agent as pixels with no path attached, so writing one into the repo was a right-click only you could do. `Cmd+Shift+Y` opens the staged-image organizer, and slot numbers stay visible so you can say "annotate screenshot 3".
- ⏳ **A quota wall stops eating your conversation.** Sends queue behind a pending retry instead of superseding it and throwing away the prompt it was holding, the countdown says how many are held, and the retry goes out under whatever model the agent carries at that moment, so switching model and retrying actually gets you past the wall. An exhausted agent is probed every 15 minutes rather than every minute, which turns a four hour outage from roughly 240 refused probes into about sixteen.
- 🛑 **An error no amount of retrying can fix stops being retried.** Codex rejecting a model outright was drawn as "Service overloaded, auto-retrying" and probed forever, with the one instruction that would have fixed it sitting behind the banner. A hard refusal now reads as the error it is, a recovered outage clears the error it recovered from, and a momentary Claude hiccup no longer flags a working agent as broken.
- 👻 **Resume Agent after signing back in looks like it resumed.** The replayed prompt ran with no pulsing dot and nothing in the transcript, so it read as doing nothing, and sending it again by hand ran the same ask twice with two sets of edits.
- 🫥 **A resumed conversation stops opening with Maestro's own system prompt at the top of it.** A tab hydrated from disk drew the whole system envelope as if you had typed it, burying your real prompt under the conductor profile and a couple of file paths.
- 🐚 **Codex feels like Codex.** Your own Codex commands appear in `/` autocomplete, read straight off disk and honouring `CODEX_HOME`, and Codex thinking shows up as thinking rather than being handed to you as the agent's actual answer.
- ⏹️ **Stop stops the whole agent**, not just the tab you are looking at, and Maestro no longer calls itself idle while a dozen messages are still queued behind a finished turn.
- 💸 Tab naming, history synopses, and participant summaries run on your provider's cheapest model, so a first message to an Opus agent no longer buys an Opus turn to write a three-word title.

## Files, previews, and media

- 🎧 **CSV, TSV, audio, and video get real support.** Tabular previews get a keyboard-driven row detail view, and media plays inside Maestro with a 0.25x to 4x speed control that survives a restart.
- ▶️ **A media player that follows you around.** Browse away and it detaches into a floating widget you can drag, resize, minimize to a play/pause pill, or double-click to re-dock. It holds a queue with each file's running time and what is left, and a media link in a chat plays in Maestro instead of launching your OS default app. `Opt+Cmd+M` opens it.
- #️⃣ **Jump to any heading in a markdown document.** Press `#` for a Cmd+K-style palette of every heading with a fuzzy filter: type three letters of a section name, press Enter, land there. The Table of Contents follows the scroll too, lighting up the section you are actually standing in.
- ⚡ **The Files panel stops sitting on "Loading files..."** A large project was built one directory at a time, hundreds of round trips deep, so the panel could spin for minutes over work that takes a tenth of a second. It is walked in one pass now, and a folder sitting right at the depth cap opens instead of drawing as empty.
- 🔖 **Narrow fuzzy file search by kind** with All, Code, Docs, Data, Media, and Other pills, and rows size themselves to the font you picked.
- ☑️ **Ticking a task checkbox in a rendered preview writes straight through to the file.**
- 🔗 **Publish a text file as a GitHub Gist from its tab menu**, without making it the active tab first. A conversation can be published the same way.
- 🗜️ **Compress a folder to a zip in place** from the Files tab, SSH remotes included.
- 🖼️ **Right-click any image** to copy it or save it into the project, whether it is a Mermaid chart, a diagram, a screenshot, or a thumbnail.
- 🔍 **Searching inside a file preview stops taking the window down with it.** Highlighting matches in a syntax-highlighted file could crash the whole app on the next redraw.

## Documents and memories

- ⌨️ **Drive the Document Graph from the keyboard.** `L` steps through Mind Map, Radial, Hierarchical, Force, and the two new layouts, Lobes (grouped by what they connect to) and Timeline (laid out by date). `D` widens neighbor depth, `F` fits everything back on screen, `S` decides whether the wheel zooms or pans, and you can screenshot the whole graph.
- 🧠 **Graph your memories** from the Memory Viewer, centered on `MEMORY.md`, and see which ones nothing points at. A memory nothing links to is never recalled, so it costs disk and returns nothing. Memories read as rendered markdown now, with the filter one keystroke away.
- 🎬 **Director's Notes bucket by group** instead of arriving as one flat list however many agents you run, file links in them actually open, and a run picks whichever provider is available rather than failing on a missing one. An AI Overview that fails says so.
- 📝 **Maestro Prompts is a real editor now**, riding the same stack the Memory Viewer uses.

## The terminal

- 🖱️ **Copy out of mouse-capturing TUIs** like the Claude Code login, tmux, and vim with Option+drag on macOS or Shift+drag elsewhere. Right-click always offers copy and falls back to the whole line, so a soft-wrapped URL comes out in one piece.
- 🖥️ **`vim`, `nano`, `less`, and `top` fill the whole terminal pane** instead of painting into a corner of it.
- 🔌 **A terminal tab has a live shell the moment it exists**, including tabs opened in the background and every terminal restored on restart, and a killed shell leaves its tab in place to restart instead of vanishing.
- 🔤 **Terminals always render in a fixed-pitch font**, so choosing a proportional interface font no longer spaces terminal text out as `Cl aude` everywhere at once.
- 🔗 **Copy Login URL from the re-authentication dialog**, and signing back in actually works on Windows. A sign-in URL runs hundreds of characters and cannot be selected while the login screen owns your mouse.

## Group chat

- 💬 **The moderator reads your intent.** "Have A draft it, then B review" sequences the room; "ask everyone" fans out in parallel.
- 🚦 **A group chat waits for a busy agent instead of dropping the work**, so delegating to an agent you are already talking to no longer means spotting a note and sending the whole thing again.
- ⏱️ **A group chat reports how long its agents actually worked**, not how long the room sat open. A chat left across a few nights used to read 481h 34m for about five hours of real work.
- 👓 **Read a room as the whole team, or as the moderator alone**, and your own prompts show up in the history where they belong.
- 🏷️ **A group chat header shows the room's full name whenever the row has space for it.** Fixing a phone layout had thrown the name away at every width, so a 2000px header with most of the row empty still hid it. The space left over is measured now, so the name renders in full or is dropped whole, never clipped to "Group Chat: Maes...".
- 👀 A collapsed Group Chats section tells you when a room is waiting on you, and a running room lights up in the agent jumper.

## Keyboard and interface

- ⌨️ **A shortcut you try to bind over an existing one is refused**, naming the action that holds it, instead of silently stealing the key and leaving the older action dead. Maestro also will not take the combinations the operating system owns, like `Cmd+Shift+Arrow` for extending a text selection.
- 🔦 **Find a shortcut by pressing it, or by the word you would use.** A By Key button listens for a combination and tells you what it does, and searching by a family keyword finds the whole family. You can clear a binding outright, and 100% keyboard mastery is reachable, because only shortcuts that actually have a key bound count toward the ring.
- ⎋ **Every modal, palette, and find bar has a real ESC button**, and closing one hands the caret back to whatever had it before.
- 🪟 **Modals are drag-to-resize and remember the size you left them at**, and full-window destinations close each other instead of stacking, so Settings, the Usage Dashboard, Director's Notes, Cue, and the rest go where you asked.
- 🎯 **Focus belongs to you.** An agent can open a terminal, file, browser tab, or a whole new agent in the background without yanking the app over to it.
- ✨ **Surface Gloss** adds a light source to Maestro's chrome so the title bar, sidebars, tab strip, and composer read as stacked layers instead of one flat sheet of paint. Four stops in Settings, off by default.
- 🎨 **More of Maestro follows your theme**, including the connecting orange, the context-window warning sash, and the pulse and glow effects that used to fall back to indigo on all twenty themes. A theme change from `maestro-cli` now shows up immediately instead of waiting for a relaunch.
- 🌿 **Bind a key to Git Pull, Push, Change Branch, or Create PR**, and filter the AI Commands list rather than scrolling it.
- 🔄 **`Opt+Cmd+R` reloads the file tree, git status, worktrees, and history** for the agent you are on, in one press, and re-reads the file you have open in a preview. A preview holds a snapshot read from disk, so after an agent rewrote that file the one pane you were watching kept showing the old bytes.
- ⬆️ **Unread navigation goes both ways.** A second `Opt+Cmd+Up` walks backwards through unread tabs, and Unread Only drives the agent and tab filters together in one press.
- 🗂️ **Tabs behave while you drag and close them.** The strip scrolls when a reorder drag reaches its edge so you can drop past the tabs off screen, and closing a tab lands you on one you can actually see.
- 🏷️ **The agent name gets the whole Left Bar row.** Names used to clip around fourteen characters while the provider label underneath held an uncontested line of its own. The worktree arrow also leaves when the last worktree does.
- 🏷️ **The Claude provider mode pill is opt-in.** Turn it on to see whether each Claude turn ran on the TUI or on `claude -p`.

## Dashboards, privacy, and performance

- 🛟 **See how much downtime Maestro absorbed for you.** A Resilience section keeps score of the outages your agents walked into and came back from, how much waiting Maestro sat through on your behalf, and how many retries it took.
- 🗂️ **The Usage Dashboard gains a Groups tab.** Bundle agents into a Left Bar group, a client, a project, and one tile tells you what it cost, with a sortable per-agent breakdown underneath. Tiles resize, an agent's full name is readable, and the distribution donuts have room for their center total instead of running a long figure like "831h 23m" underneath the ring.
- 🪪 **Filter the agent grid by provider account.** With three Claude logins in one install, "Claude Code" stops being an identity anyone cares about. Every account lists the agents behind it, and the "N agents" chip on a quota row opens the grid already narrowed to it.
- 💡 **The context window tooltip names whose quota it is spending.** The provider name alone does not tell you which bucket a turn came out of, so the tooltip now names the provider and the account, and it is the same account the Usage Dashboard files that agent under.
- 🧾 **Codex agents stop looking like they outspent every Claude agent you own.** Their reported cost was growing with the square of how long you talked to them, and GPT tokens were priced at Claude's rate.
- 📧 **Plan usage reads what your plan really says.** Accounts are named by login email, a maxed-out plan keeps its row while you wait for the reset instead of vanishing, windows are classified by how long they actually are, and a reading that comes back garbled is retried rather than written off.
- 🪄 **See what the Auto Run wizard cost you and what it produced**, with a per-day timeline split by whether a run shipped anything. The inline `/wizard` was recording nothing at all before this.
- ⏲️ **WakaTime credits the work your agents did without you**, counting Cue runs and `maestro-cli` time, and stops mislabeling work done over SSH.
- 🔒 **Support packages carry nothing that identifies you or your machine.** Usernames, hostnames, paths, and project names are stripped before the package is written, so you can attach one to a public issue without a second thought.
- 🛌 **Sleep prevention no longer freezes your Mac's housekeeping.** Maestro was asking macOS to keep the display awake, which is how the system decides someone is sitting there, so Photos clustering, Spotlight indexing, and Time Machine were all suppressed for as long as Maestro was open.
- 🚀 **Speed.** Switching to an agent with a long transcript no longer freezes the interface, expanding a folder no longer re-renders every other row, typing in Settings no longer drops characters, and pasted images draw from cached thumbnails instead of decoding the full picture every time.
- 🎨 **Diagram and math rendering.** Mermaid labels pick a color that stays readable against their fill, a flowchart direction the lexer rejected is repaired, inline math renders as math rather than a literal `$$N$$`, and an `@` inside a diagram label no longer takes the whole diagram down with it.

🌐 **There is also a new runmaestro.ai.** It is not part of this download and it did not ship with the app, it just went live. Go have a look, and tell us what you think.

### Previous Releases in this Series

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
- **v0.1.1** (November 27, 2025)
- **v0.1.0** (November 27, 2025)

---

## Downloading Releases

All releases are available on the [GitHub Releases page](https://github.com/RunMaestro/Maestro/releases).

Maestro is available for:
- **macOS** - Apple Silicon (arm64) and Intel (x64)
- **Windows** - x64
- **Linux** - x64 and arm64, AppImage, deb, and rpm packages
