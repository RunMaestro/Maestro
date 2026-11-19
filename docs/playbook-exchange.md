---
title: Playbook Exchange
description: Browse, preview, and import community playbooks from the Maestro Playbook Exchange.
icon: store
---

The Playbook Exchange is a curated collection of community-contributed playbooks that you can browse and import directly into your Auto Run folder. Each playbook is a pre-configured set of markdown documents designed for specific workflows.

## Opening the Exchange

Open the Playbook Exchange using:

- **Keyboard** - `Opt+Cmd+Shift+E` / `Alt+Ctrl+Shift+E` (the active agent needs an Auto Run folder)
- **Quick Actions** - `Cmd+K` / `Ctrl+K` → search "Playbook Exchange"
- **Auto Run panel** - Click the **Exchange** button (grid icon)

## Browsing Playbooks

The exchange displays playbooks in a searchable grid organized by category:

- **Category tabs** - Filter playbooks by type (Development, Security, DevOps, etc.)
- **Search** - Filters by title, description, and tags
- **Arrow keys** - Navigate between tiles
- **Enter** - Open the detail view for the selected playbook
- **`Cmd+F` / `Ctrl+F`** - Focus the search input
- **Featured / Most popular** - Sort the grid in the Exchange's own order or by installs in the last 30 days

Tiles can carry two badges from the Exchange's usage figures. **Most popular** marks the three most installed playbooks of the last 30 days (each with at least 10 installs). **Recently broken** marks a playbook with at least 3 recent failed runs and fewer than 75% of its runs succeeding. Hover a badge for the numbers. The figures come from people who chose to [share anonymous usage](#anonymous-usage); until there are any, the grid shows no badges and no sort control.

From the command line, `maestro-cli marketplace list --sort popular` lists the same order and prints the same badges after each line; `--json` adds each playbook's `health` figures and `badges`.

Use `Cmd+Shift+[` / `Cmd+Shift+]` (`Ctrl+Shift+[/]` on Windows/Linux) to quickly switch between category tabs.

<Frame>
  <img src="./screenshots/playbook-exchange-list.png" alt="Playbook Exchange browsing view" />
</Frame>

## Playbook Details

Clicking a playbook tile (or pressing `Enter`) opens the detail view where you can:

- **Read the README** - Full documentation for the playbook
- **Preview documents** - Browse individual task documents before importing; use the dropdown or click document names in the sidebar
- **View metadata** - Author (with link if available), tags, loop settings, fresh-context setting (per task or per document), last updated date, and document list
- **Set import folder** - Customize the target folder name (relative to Auto Run folder or absolute path)
- **Browse for folder** - Click the folder icon to select a custom location (local sessions only)

### Detail View Navigation

- **`Cmd+Shift+[/]`** - Navigate to previous/next document (wraps around, includes README)
- **`Opt+Up/Down`** - Page up/down in the document preview
- **`Cmd+Up/Down`** - Scroll to top/bottom of document preview
- **`Esc`** - Return to the playbook grid

<Frame>
  <img src="./screenshots/playbook-exchange-details.png" alt="Playbook Exchange detail view" />
</Frame>

## Importing a Playbook

1. Open the detail view for a playbook
2. Optionally edit the **Install to folder** field (defaults to `category/title` slug, e.g., `development/code-review`)
3. Click **Install and Run** to install and go straight on to configuring the run, or **Install only** to install and close the Exchange

The import creates:

- A subfolder in your Auto Run folder with the playbook name
- All markdown task documents copied to that folder
- An `assets/` subfolder with any supporting files (configs, scripts, templates) if the playbook includes them. References to `{{AUTORUN_FOLDER}}/assets/` in the documents and prompt are rewritten to point at this subfolder, so each playbook keeps its own assets
- A saved playbook configuration with loop settings, document order, the prompt, and the **Fresh Context Per** setting (per task unless the manifest says `"taskSelectionMode": "document"`)

After import, the playbook is immediately available in your **Load Playbook** dropdown in the Auto Run panel, even if the panel was already open.

From the command line, `maestro-cli marketplace import <id> -a <agent>` does the same import and prints the saved playbook's id (`playbookId` with `--json`). Run it with `maestro-cli playbook <playbook-id>`, which applies its parameters and ends with its report.

### Updating an Installed Playbook

Each agent holds one copy of a given Exchange playbook. Open a playbook that is already installed and the detail view names its folder and offers **Update and Run** and **Update only** in place of the install buttons, so a second install never lands on top of the first.

Maestro checks for updates each time the Exchange opens, and once per agent per app start when the Auto Run playbook dropdown appears. Each installed playbook is one of:

- **Up to date** - the Exchange has the version you installed.
- **Update available** - the Exchange has a different version. An **Update available** pill shows on the detail view and beside the playbook in the **Load Playbook** dropdown; click the pill in the dropdown to update.
- **Edited** - the pristine copy Maestro keeps under `.maestro-playbook/source/` no longer matches what was installed, so someone changed it by hand. The pill's tooltip names the documents; an update replaces them. Your working documents are not compared, because a run is expected to check their boxes.

An update re-fetches the documents into the same folder, which resets their tasks, refreshes the pristine copies, and keeps the saved playbook's id, your parameter answers, and its worktree settings. It is refused while that agent's Auto Run is running. Documents the new version dropped stay on disk but leave the playbook's run list.

From the command line, `maestro-cli marketplace updates -a <agent>` lists each installed playbook and its state (`--json` for the full status), and `maestro-cli marketplace import <id> --update -a <agent>` updates one. A plain `marketplace import` of a playbook the agent already has is refused with the folder it lives in.

### Answering a Playbook's Parameters

Many playbooks ask a few questions before they run, such as a pull request URL or how many items to process. After **Install and Run**, the Exchange shows a form with one row per parameter: its type, whether it is required, its help text, and where the current value comes from:

- **You** - your own answer
- **Detected** - a value Maestro found on this machine (hover the badge to see where)
- **Default** - the playbook author's default
- **Unresolved** - no value yet. A required parameter in this state blocks the run

Maestro detects a few values without asking an agent: the open pull request for your branch (only when the playbook asks for one pull request, so a comparison of two is never filled with the same one twice), the current branch, the agent's working directory, and, for a parameter about an Obsidian vault (one named like `VAULT_PATH`), the vault. It proposes a vault only when one fits: the agent's working directory when it is a vault, the only vault Obsidian knows, or the one vault Obsidian has open. With several candidates it leaves the value for you or the guided chat, which can name the vaults it found.

Some playbooks are **guided**: instead of the form, they open on a short chat where your agent reads the project, proposes what it can find, and asks only for the rest. It asks at most one question per open parameter, plus one. When it has what it needs, or when you click **Skip to form** (always visible), you land on the form with what it found marked **Detected** and what you told it marked **You**, so you confirm every value before anything runs. The first time you configure a guided playbook, the chat also checks the values the playbook suggests against your machine, so an installer whose every parameter has a default still asks. After that first time, a guided playbook skips the chat when every parameter has a value, and always when the agent cannot run (no agent, or offline).

On a form playbook, **Help me fill this in** starts the same chat. It shows only when a parameter is still empty and is the kind of thing the project can answer (a test command, a path, a repository detail). For a question only you can answer, such as a research topic, the form is faster, so the button does not show. The chat runs read-only and its prompt is editable in **Settings > Maestro Prompts > Playbooks**.

Answers are saved to the playbook as you type, so you can close the form and come back. To change them later, open **Configure Playbook** (`Opt+Cmd+Shift+P`, the command palette, or the Left Bar menu), or click the sliders icon next to a playbook in the **Load Playbook** dropdown. When a run pauses because a required parameter has no value, the pause banner offers **Configure** too: answer the parameters, then click **Resume**.

From the command line, `maestro-cli playbook configure <id> --set NAME=VALUE` saves an answer, and `maestro-cli playbook configure <id>` reads the answers back.

### Running It

Above **Run**, one row says what the click starts: how many documents, how many loops, and which agent it runs on with that agent's model. When the Exchange has usage figures for the playbook, the row also says what a typical run takes and costs ("Typically 12m, about $0.40", the 30 day medians across everyone's runs). The run always goes to the agent you opened the Exchange from. A playbook marked as machine-wide adds one line: "This playbook configures your machine, not just this project."

A looping playbook whose manifest asks for unlimited loops is capped at 10 when you install it, so one click cannot start a run that never ends. The row says so and has a slider to raise the cap before you run.

**Run** saves your answers (including the **Detected** ones) and the loop cap to the playbook, then starts it exactly as **Go** in the Auto Run panel would. The Exchange closes once the run has started, and the Auto Run panel opens on its running state. **Run** is disabled while another Auto Run is going on the same agent, or when Auto Run is turned off in Settings.

### The Run Report

When a playbook run finishes, Maestro writes a report: what the run did, how to use the result, what to do next, which files changed, and the parameter values it used. The report leads the run's final entry in History, and it is saved in the Auto Run folder as `.maestro-reports/<playbook>-<date>-<time>.md`, with a `.json` copy beside it.

The "what was done" part comes from one of two places:

- A playbook with a `report` document runs that document once, after every other document is done. It writes the narrative plus a **How to use it** and a **Next steps** section.
- A playbook without one gets a short summary of its task synopses, written on the agent's cheapest model.

A run that failed or was stopped gets no narrative, only the facts. A run that failed or stalled on some documents says what went wrong in **What did not happen**, above the narrative: the agent's last error or the halt that ended the run, and each document that stopped making progress, each with the document and the task number.

When the run finishes, the report opens in a window on top of whatever you are doing. **Copy report** puts the markdown on the clipboard, **Save to project** writes it into the agent's working directory as `<playbook>-REPORT-<date>-<time>.md`, and file paths in the report open in the File Preview. If several runs finish together, their reports wait in line: the header shows "1 of 3", and **Done** (or <kbd>Esc</kbd>) moves to the next one. Closing a report loses nothing. To see the last one again, run **Open Last Playbook Report** from the command palette, or `maestro-cli open playbook-report`. Opening the run's entry in History shows the same report, with the classic Auto Run summary folded below it, and the entry's **Open report** button opens it in the report window again.

#### Report a problem

When a playbook from the Exchange fails or finishes with stalled documents, the report window offers **Report a problem**. It first shows the exact GitHub issue it would file, so you see every word before anything is sent. The issue names the playbook, its version, the document and task number, the task as it shipped (never your filled-in copy), the kind of failure, your agent's provider, and your Maestro version. Parameters appear by shape only, such as `PR_URL: set (url)` or `MAX_ITEMS: default`. Parameter values, paths, branch names, and repository names are never sent, and a parameter whose name looks like a secret is left out entirely.

A failure in the playbook itself (a task that stalled, errored, or halted) goes to the playbook repository, `RunMaestro/Maestro-Playbooks`. A failure of Maestro or your provider (a turn the watchdog ended, a login failure, an agent that would not start) goes to `RunMaestro/Maestro`. If someone already reported the same failure, your report adds a +1 and a "also hit on" comment with your Maestro version and provider to their issue instead of opening a second one. **Attach a support package** is off unless you tick it.

Reporting uses the GitHub CLI (`gh`), signed in to your account. Without it, Maestro opens a prefilled issue in your browser instead. When the report is too long for a link, the rest goes to your clipboard and a notice tells you to paste it at the end of the issue.

A run from the command line (`maestro-cli playbook <id>`) writes the same two files and the same History entry, and prints the report when it ends. With `--json` the report arrives as a `report` event just before `complete`. The command line runs a `report` document the same way, but it writes no synopsis summary, so a playbook without a `report` document gets a report with the facts and no narrative. `maestro-cli run-doc` runs loose documents, not a playbook, so it writes no report.

### Use One as Reference

A playbook does not have to be run as-is. Importing one pulls it down locally, so you can also treat it as reference material: tell your agent what you actually want, point it at the imported document, and let it adapt the structure to your project. Customize it to your desire.

<Note>
For SSH remote sessions, playbooks can be imported directly to the remote host. The folder browse button is disabled for remote sessions - enter the target path manually instead.
</Note>

## Exchange Data

Playbooks are fetched from the [Maestro-Playbooks](https://github.com/RunMaestro/Maestro-Playbooks) GitHub repository. The manifest is cached locally for 6 hours to minimize API calls.

- **Cache indicator** - Shows whether data is from cache and how old it is (e.g., "Cached 2h ago" or "Live")
- **Refresh button** - Forces a fresh fetch from GitHub, bypassing the cache

The popularity and reliability figures behind the badges come from `runmaestro.ai` on their own request, cached for the same 6 hours. The manifest never waits for them, and when the server has none (or is unreachable) the Exchange looks as it would without them.

### Anonymous Usage

**Settings > General > Privacy > Share anonymous playbook usage** is off unless you turn it on. When it is on, Maestro sends a few events about playbooks from the official Exchange to `runmaestro.ai`, so the Exchange can show which playbooks are popular and which are broken:

| Event           | Fields                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `install`       | playbook id, playbook version                                                                    |
| `run_started`   | playbook id, version, where the run was launched from, `form` or `guided`                        |
| `run_completed` | playbook id, version, status, duration, document count, stalled document count                   |
| `run_failed`    | playbook id, version, document name, task number, failure kind, fingerprint (at most five a run) |

Playbook ids are public, so they are sent as they are. Paths, parameter values, agent names, and your identity are not fields at all; the only identifier is Maestro's anonymous installation id. A stopped run sends no `run_failed` events. Playbooks from a local manifest send nothing. Events wait in a file in Maestro's data folder and go out after an Auto Run ends or when Maestro quits. Set `MAESTRO_DISABLE_PLAYBOOK_TELEMETRY=1` to turn the channel off regardless of the setting.

Maestro asks once. The first time a run of an official Exchange playbook finishes while the setting is off, the completion report opens with a short step that shows the exact `run_completed` event that run would have sent, with **Share anonymous usage** and **No thanks**. Either answer sets the setting. Escape or the close button skips to the report and leaves the setting off. The question never returns; change your answer in Settings later.

## Contributing Playbooks

Want to share your playbooks with the community? You can contribute in two ways:

1. **From the Exchange** - Click the "Submit Playbook via GitHub" link in the header
2. **Directly on GitHub** - Submit a pull request to the [Maestro-Playbooks repository](https://github.com/RunMaestro/Maestro-Playbooks)

Click the **?** help button in the Exchange header for more information about contributing.

### Manifest Run Settings

These manifest fields decide how an imported playbook runs:

| Field               | Values                  | Default  | Effect                                                                                                                                                                                                                 |
| ------------------- | ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loopEnabled`       | `true` / `false`        | -        | Loop back to the first document after the last one.                                                                                                                                                                    |
| `maxLoops`          | number or `null`        | `null`   | Most loops to run. `null` is unlimited.                                                                                                                                                                                |
| `prompt`            | string or `null`        | -        | Prompt for each task session. `null` uses Maestro's default Auto Run prompt.                                                                                                                                           |
| `taskSelectionMode` | `"task"` / `"document"` | `"task"` | One fresh agent session per unchecked task, or one per document that works every task in it. Use `"document"` for many small tasks that share context.                                                                 |
| `report`            | document name           | -        | A document run once, after the others, to write the run report's narrative, **How to use it**, and **Next steps**. It is never run as a task document. The import fetches it whether or not `documents` also lists it. |

A custom `prompt` adds to the default prompt's task plumbing. It does not replace it. If the prompt never names `{{DOCUMENT_PATH}}`, Maestro appends the task-selection instructions (unless the prompt has its own `{{TASK_SELECTION_BLOCK}}`) and the block that names the task document and asks the agent to check tasks off. Name `{{DOCUMENT_PATH}}` yourself only when the prompt takes full control of how the agent finds and checks off its tasks.

## Keyboard Shortcuts

### List View

| Action              | macOS           | Windows/Linux    |
| ------------------- | --------------- | ---------------- |
| Navigate tiles      | Arrow keys      | Arrow keys       |
| Open detail view    | `Enter`         | `Enter`          |
| Focus search        | `Cmd+F`         | `Ctrl+F`         |
| Switch category tab | `Cmd+Shift+[/]` | `Ctrl+Shift+[/]` |
| Close modal         | `Esc`           | `Esc`            |

### Detail View

| Action                 | macOS           | Windows/Linux    |
| ---------------------- | --------------- | ---------------- |
| Previous/next document | `Cmd+Shift+[/]` | `Ctrl+Shift+[/]` |
| Page up/down           | `Opt+Up/Down`   | `Alt+Up/Down`    |
| Scroll to top/bottom   | `Cmd+Up/Down`   | `Ctrl+Up/Down`   |
| Back to list           | `Esc`           | `Esc`            |
