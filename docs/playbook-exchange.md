---
title: Playbook Exchange
description: Browse, preview, and import community playbooks from the Maestro Playbook Exchange.
icon: store
---

The Playbook Exchange is a curated collection of community-contributed playbooks that you can browse and import directly into your Auto Run folder. Each playbook is a pre-configured set of markdown documents designed for specific workflows.

## Opening the Exchange

Open the Playbook Exchange using:

- **Quick Actions** - `Cmd+K` / `Ctrl+K` → search "Playbook Exchange"
- **Auto Run panel** - Click the **Exchange** button (grid icon)

## Browsing Playbooks

The exchange displays playbooks in a searchable grid organized by category:

- **Category tabs** - Filter playbooks by type (Development, Security, DevOps, etc.)
- **Search** - Filters by title, description, and tags
- **Arrow keys** - Navigate between tiles
- **Enter** - Open the detail view for the selected playbook
- **`Cmd+F` / `Ctrl+F`** - Focus the search input

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

### Answering a Playbook's Parameters

Many playbooks ask a few questions before they run, such as a pull request URL or how many items to process. After **Install and Run**, the Exchange shows a form with one row per parameter: its type, whether it is required, its help text, and where the current value comes from:

- **You** - your own answer
- **Detected** - a value Maestro found on this machine (hover the badge to see where)
- **Default** - the playbook author's default
- **Unresolved** - no value yet. A required parameter in this state blocks the run

Some playbooks are **guided**: instead of the form, they open on a short chat where your agent reads the project, proposes what it can find, and asks only for the rest. It asks at most one question per open parameter, plus one. When it has what it needs, or when you click **Skip to form** (always visible), you land on the form with its values marked **Detected**, so you confirm every value before anything runs. A guided playbook skips the chat when every parameter already has a value, or when the agent cannot run (no agent, or offline).

On a form playbook, **Help me fill this in** starts the same chat. It shows only when a parameter is still empty and is the kind of thing the project can answer (a test command, a path, a repository detail). For a question only you can answer, such as a research topic, the form is faster, so the button does not show. The chat runs read-only and its prompt is editable in **Settings > Maestro Prompts > Playbooks**.

Answers are saved to the playbook as you type, so you can close the form and come back. To change them later, open **Configure Playbook** (`Opt+Cmd+Shift+P`, the command palette, or the Left Bar menu), or click the sliders icon next to a playbook in the **Load Playbook** dropdown. When a run pauses because a required parameter has no value, the pause banner offers **Configure** too: answer the parameters, then click **Resume**.

From the command line, `maestro-cli playbook configure <id> --set NAME=VALUE` saves an answer, and `maestro-cli playbook configure <id>` reads the answers back.

### Running It

Above **Run**, one row says what the click starts: how many documents, how many loops, and which agent it runs on with that agent's model. The run always goes to the agent you opened the Exchange from. A playbook marked as machine-wide adds one line: "This playbook configures your machine, not just this project."

A looping playbook whose manifest asks for unlimited loops is capped at 10 when you install it, so one click cannot start a run that never ends. The row says so and has a slider to raise the cap before you run.

**Run** saves your answers (including the **Detected** ones) and the loop cap to the playbook, then starts it exactly as **Go** in the Auto Run panel would. The Exchange closes once the run has started, and the Auto Run panel opens on its running state. **Run** is disabled while another Auto Run is going on the same agent, or when Auto Run is turned off in Settings.

### Use One as Reference

A playbook does not have to be run as-is. Importing one pulls it down locally, so you can also treat it as reference material: tell your agent what you actually want, point it at the imported document, and let it adapt the structure to your project. Customize it to your desire.

<Note>
For SSH remote sessions, playbooks can be imported directly to the remote host. The folder browse button is disabled for remote sessions - enter the target path manually instead.
</Note>

## Exchange Data

Playbooks are fetched from the [Maestro-Playbooks](https://github.com/RunMaestro/Maestro-Playbooks) GitHub repository. The manifest is cached locally for 6 hours to minimize API calls.

- **Cache indicator** - Shows whether data is from cache and how old it is (e.g., "Cached 2h ago" or "Live")
- **Refresh button** - Forces a fresh fetch from GitHub, bypassing the cache

## Contributing Playbooks

Want to share your playbooks with the community? You can contribute in two ways:

1. **From the Exchange** - Click the "Submit Playbook via GitHub" link in the header
2. **Directly on GitHub** - Submit a pull request to the [Maestro-Playbooks repository](https://github.com/RunMaestro/Maestro-Playbooks)

Click the **?** help button in the Exchange header for more information about contributing.

### Manifest Run Settings

These manifest fields decide how an imported playbook runs:

| Field               | Values                  | Default  | Effect                                                                                                                                                 |
| ------------------- | ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `loopEnabled`       | `true` / `false`        | -        | Loop back to the first document after the last one.                                                                                                    |
| `maxLoops`          | number or `null`        | `null`   | Most loops to run. `null` is unlimited.                                                                                                                |
| `prompt`            | string or `null`        | -        | Prompt for each task session. `null` uses Maestro's default Auto Run prompt.                                                                           |
| `taskSelectionMode` | `"task"` / `"document"` | `"task"` | One fresh agent session per unchecked task, or one per document that works every task in it. Use `"document"` for many small tasks that share context. |

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
