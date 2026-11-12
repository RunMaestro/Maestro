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
2. Optionally edit the **Import to folder** field (defaults to `category/title` slug, e.g., `development/code-review`)
3. Click **Import Playbook** (on a playbook that supports Launch, the button is **Download**)

The import creates:

- A subfolder in your Auto Run folder with the playbook name
- All markdown task documents copied to that folder
- An `assets/` subfolder with any supporting files (configs, scripts, templates) if the playbook includes them. References to `{{AUTORUN_FOLDER}}/assets/` in the documents and prompt are rewritten to point at this subfolder, so each playbook keeps its own assets
- A saved playbook configuration with loop settings, document order, the prompt, and the **Fresh Context Per** setting (per task unless the manifest says `"taskSelectionMode": "document"`)

After import, the playbook is immediately available in your **Load Playbook** dropdown in the Auto Run panel.

### Use One as Reference

A playbook does not have to be run as-is. Importing one pulls it down locally, so you can also treat it as reference material: tell your agent what you actually want, point it at the imported document, and let it adapt the structure to your project. Customize it to your desire.

<Note>
For SSH remote sessions, playbooks can be imported directly to the remote host. The folder browse button is disabled for remote sessions - enter the target path manually instead.
</Note>

## Launching a playbook

A playbook that supports Launch shows a **Launch** button on its tile and in the detail view, next to **Download**. Playbooks without launch support show Download only.

| Action       | What it does                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Download** | Imports the playbook exactly as described in [Importing a Playbook](#importing-a-playbook). You configure and run it yourself.              |
| **Launch**   | Asks the playbook's questions, imports it with your answers filled in, starts the Auto Run, cleans up when it finishes, and shows an outro. |

### The launch dialog

1. **Questions** - The playbook's own inputs (text, paths, numbers, yes/no, choices). Required fields are checked before Launch turns on. Rarely changed inputs sit in a collapsed **Advanced** section.
2. **Requirements** - Anything the playbook needs, such as a platform or a logged-in tool. A playbook that asks for confirmation shows a checkbox you must tick first. If the playbook calls `maestro-cli`, the dialog shows whether it is installed and offers to install it. A remote agent cannot use `maestro-cli`, so a playbook that requires it cannot launch on one.
3. **Run on** - The current agent (the default), another existing agent, or a new agent. A new agent is set up with the same form as **New Agent** (provider, folder, model) and is created only when you press Launch. Existing agents are shown read-only; the dialog never edits them.
4. **Save as a reusable playbook** - Keeps the saved playbook and its documents after the run. Off by default.

### Cleanup and outro

Launch imports the playbook into its own folder inside the agent's Auto Run folder, named `<playbook>-launch-<timestamp>`, so repeated launches never collide. When the run finishes, Maestro removes that folder and the saved playbook it created, unless you chose to keep them or the playbook asks to keep its documents. Files the playbook wrote elsewhere (reports, vaults, code) are never touched. If you stop the run, the folder stays so you can resume.

When the run ends, an outro explains what was done and what to do next. It lists the tasks completed, the time and cost, a verdict from the playbook's report file when it has one, and buttons to open the files the playbook produced. If you are working in another agent when the run ends, a toast opens the outro.

### From the CLI

Everything the dialog does is available in `maestro-cli`:

```bash
# See the questions a playbook asks
maestro-cli marketplace show <playbook-id>

# Launch it on an agent, answering the questions
maestro-cli marketplace launch <playbook-id> --agent <agent-id> \
  --input PR_URL=https://github.com/acme/app/pull/12 \
  --input AUTO_FIX_SEVERITY=CRITICAL,HIGH --wait

# Launch on a new agent
maestro-cli marketplace launch <playbook-id> --new-agent --provider claude-code --cwd ~/Projects/app

# Read back what happened
maestro-cli marketplace launches --agent <agent-id>
maestro-cli marketplace launch-status <launch-id>
```

`--agent` defaults to the agent running the command. Use `--input-file <json>` to pass answers as a JSON object, `--confirm` for a playbook that asks for confirmation, `--keep-playbook` to keep the saved playbook, and `--wait` to block until the run ends and print the outro. See the [CLI reference](./cli-reference#maestro-cli-marketplace-launch-playbook-id).

## Authoring launch support

A playbook opts in with an optional `launch` block in its manifest entry. Maestro versions without the launch flow ignore the block, so Download keeps working everywhere.

The block holds:

- `intro` - Markdown shown at the top of the dialog.
- `preconditions` - `platforms`, a `requires` list, a `confirm` checkbox text, and `maestroCli` (`required` or `optional`).
- `inputs` - The typed questions: `text`, `textarea`, `url`, `path`, `number`, `boolean`, `select` and `multiselect`, each with a `name`, `label`, optional `default`, `required`, `help`, `options`, and limits.
- `maxLoops` and `cleanup` (`remove-docs` or `keep`).
- `outro` - A `summary`, `nextSteps`, and optional `files` and `reportFile`.

**How answers are applied.** Each input's `name` matches a line in the manifest `prompt` written as `**NAME:** `value``. Launch rewrites only the value between the backticks on that line. The task documents are never changed, and keep reading `[NAME]`from the prompt. An optional input you leave empty keeps the value the playbook shipped with. Launching with every default writes the same prompt that Download ships. Built-in variables such as`{{AUTORUN_FOLDER}}`inside a value are expanded at run time.`{{INPUT_NAME}}`tokens work only in the`outro` text and paths.

The full schema, the serialization rules for each input type, and the validator are documented under [Launch Support](https://github.com/RunMaestro/Maestro-Playbooks/blob/main/CONTRIBUTING.md#launch-support) in the Maestro-Playbooks `CONTRIBUTING.md`. To try a launch block before you publish, add it to a [local manifest](./local-manifest#testing-a-launch-block).

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
