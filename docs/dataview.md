---
title: Dataview
description: Render Obsidian Dataview queries as live tables, lists, and task lists in File Preview and the Auto Run preview, with DataviewJS in an isolated sandbox.
icon: database
---

Write a `dataview` code block in a note, as you would in Obsidian, and Maestro renders its result instead of the code. A People note that lists every meeting linking to it shows that list as a table in File Preview, and it stays current as you add meetings.

Dataview is an [Encore Feature](./encore-features), off by default. Maestro carries the query engine of the Obsidian Dataview plugin (version 0.5.68) itself, so queries mean the same thing they mean in Obsidian. You do not need Obsidian installed.

## What renders

| You write                           | What you see                                                                |
| ----------------------------------- | --------------------------------------------------------------------------- |
| A `dataview` block with `TABLE`     | A table, one row per page (or per group with `GROUP BY`)                    |
| A `dataview` block with `LIST`      | A bulleted list                                                             |
| A `dataview` block with `TASK`      | A task list whose checkboxes tick the task in its own note                  |
| Inline `` `= this.file.name` ``     | The value, in place of the code span                                        |
| A `dataviewjs` block                | Whatever the script draws with the `dv` API (see [DataviewJS](#dataviewjs)) |
| Inline `` `$= dv.pages().length` `` | The value of the JavaScript expression (DataviewJS)                         |

Queries support `FROM` (tags, folders, links, and `and` / `or` / `-` combinations), `WHERE`, `SORT`, `GROUP BY`, `FLATTEN`, `LIMIT`, and `WITHOUT ID`, plus Dataview's full function library. For example:

````markdown
```dataview
TABLE file.cday as Created, Summary
FROM #meeting or "meetings"
WHERE contains(file.outlinks, this.file.link)
SORT file.cday DESC
LIMIT 25
```
````

The index reads, for every note: frontmatter, inline fields (`Key:: value`, `[key:: value]`, `(key:: value)`), tags, wiki links and markdown links in both directions, aliases, tasks and list items, and the implicit `file.*` fields (`file.name`, `file.cday`, `file.outlinks`, `file.inlinks`, `file.tasks`, and the rest).

Results behave like the rest of the preview:

- **Links** open the note they name, the same as clicking a `[[wiki link]]`.
- **Task checkboxes** in a `TASK` result rewrite that task's line in the note it came from.
- **Live refresh.** Edit, add, or delete a note and every block whose result could change runs again.
- **Errors** show inside the block with Dataview's own message. A broken query never breaks the rest of the preview.

Dataview renders in File Preview (both the rich and the fast renderer) and in the Auto Run document preview. Agent chat messages never run queries: a query an agent shows you stays code.

## Turning it on

1. Open **Settings > Plugins**, select **Dataview**, and turn it on (or run `maestro-cli encore enable dataview`). `dataview` blocks and inline `=` spans render from now on.
2. To run DataviewJS too, turn on **Run DataviewJS** in the Dataview tile's settings. It is off by default.
3. Trust a vault before its scripts run. Open a note with a `dataviewjs` block: it shows the script and two buttons.
   - **Run once** runs that block for this app session. Editing the script asks again.
   - **Always trust this vault** adds the vault to **Trusted Vaults**, and every DataviewJS block in it runs from then on.

Remove a vault from **Trusted Vaults** in the same settings, or with `maestro-cli dataview untrust`. Turning the feature off stops every index and watcher, and Dataview blocks render as plain code again.

## How the vault is chosen

A query runs against the vault the note sits in:

- The vault root is the nearest folder above the note that holds an `.obsidian/` folder.
- With no `.obsidian/` folder above it, the root is the working directory of the agent that owns the note.

Maestro indexes every markdown file under the root, except files in dot folders (`.git`, `.obsidian`, and the like) and `node_modules`. Notes larger than 2 MB keep their `file.*` fields but are not read. The first index of a vault takes a moment; after that Maestro keeps a cache on disk, so reopening a vault shows results at once and catches up in the background.

Agents on an [SSH remote](./ssh-remote-execution) work too. Their vault is indexed over SSH and checked for changes every 30 seconds instead of being watched. An index nobody has used for 10 minutes closes.

## DataviewJS

DataviewJS blocks are JavaScript in your notes, with Dataview's `dv` object in scope. Maestro supports the documented `dv` API: page queries (`dv.pages`, `dv.page`, `dv.current`), rendering (`dv.table`, `dv.list`, `dv.taskList`, `dv.header`, `dv.paragraph`, `dv.el`, and the `markdown*` variants), DQL from a script (`dv.query`, `dv.execute`, `dv.evaluate`), file reads (`dv.io.load`, `dv.io.csv`), `dv.view` for a `view.js` (and optional `view.css`) stored in the vault, and the utilities (`dv.date`, `dv.duration`, `dv.luxon`, `dv.array`, and so on).

A script that takes longer than 5 seconds is stopped, and its block shows a timeout error. The other blocks in the note keep running.

## What is not supported

| Not supported                                                      | What happens                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `CALENDAR` queries                                                 | The block shows "CALENDAR queries are not supported in Maestro."                |
| Obsidian's `app` API (`app`, `this.app`, `dv.app`, plugin lookups) | The script stops with `Obsidian API not available in Maestro`.                  |
| Writing files from a script (`app.vault.modify` and the like)      | Not available. Scripts can read vault files, never write them.                  |
| DataviewJS in the browser build                                    | The block shows its source and "DataviewJS runs in the desktop app". DQL works. |
| Dataview's own settings (date formats, null text)                  | Dataview's defaults apply.                                                      |

## Security model

DQL queries only read your notes, so they run whenever the feature is on.

DataviewJS runs code someone wrote into a note, possibly a note you downloaded or cloned. Maestro treats it as untrusted:

- **Off until you say so.** The **Run DataviewJS** switch is off by default, and a vault must be trusted (or the block run once) before any script in it runs.
- **Isolated.** Each script runs in a separate sandboxed process with no Node.js, no access to Maestro, no network, and no way to open windows or navigate.
- **Read-only, inside the vault.** A script can read files inside its own vault and nothing outside it. It cannot write any file. The only actions it can ask for are opening a link and ticking a task, the same things you can click in the result.
- **Time-limited.** A script that runs longer than 5 seconds is killed.

Trust is per vault, so trusting your own vault does not let a cloned repository's notes run.

## CLI

Every result the preview shows is available from `maestro-cli`, with the app running. See the [CLI reference](./cli#dataview) for every flag.

```bash
# Run every dataview block in a note (one table per block)
maestro-cli dataview query "People/Ada Lovelace.md"

# Run an ad-hoc query, or an inline expression, with `this` bound to the note
maestro-cli dataview eval notes/today.md 'LIST FROM #meeting'
maestro-cli dataview eval notes/today.md '= this.file.name'

# Show the state of each open vault index, or rebuild one from scratch
maestro-cli dataview index status
maestro-cli dataview index rebuild ~/Vault

# Trust a vault, stop trusting it, and list the trusted vaults
maestro-cli dataview trust ~/Vault
maestro-cli dataview untrust ~/Vault
maestro-cli dataview trusted
```

The CLI never runs DataviewJS. `dataview query` on a `dataviewjs` block prints "DataviewJS renders in the desktop app only" and exits with code `2`.
