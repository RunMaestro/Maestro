---
title: File Formats
description: Every file type Maestro opens specially, and the filtering language each one gives you - jq for JSON, table filters for CSV, and a typed query language for Parquet.
icon: file-code
---

Maestro's File Preview is not one renderer. Opening a file picks a viewer based on what the file actually is, and several of those viewers come with a filtering language built for that format. This page is the map: what opens as what, and what you can type at it.

Open a file by clicking it in the Files pane (Right Panel), through Fuzzy File Search (`Cmd+P` / `Ctrl+P`), or by clicking a file path an agent mentions in chat.

## What opens as what

| Format              | Extensions                                                       | Opens as                                                                         | How you filter it                                       |
| ------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Parquet**         | `.parquet`, `.parq`, `.pq`                                       | Virtualized data grid with a schema rail                                         | [Typed query language](#parquet-a-typed-query-language) |
| **JSON**            | `.json`                                                          | Syntax-highlighted source, switching to a tree in jq mode                        | [jq](#json-and-jsonl-jq), or find in file               |
| **JSON Lines**      | `.jsonl`, `.ndjson`                                              | Per-record tree or table                                                         | [jq](#json-and-jsonl-jq), or text search                |
| **CSV / TSV**       | `.csv`, `.tsv`                                                   | Sortable table                                                                   | [Row filter](#csv-and-tsv-row-filtering)                |
| **Markdown**        | `.md`, `.mdx`                                                    | Rendered document with clickable task checkboxes                                 | Find in file                                            |
| **Mermaid**         | `.mmd`, `.mermaid`                                               | Rendered diagram                                                                 | Find in source (`Cmd+E` for source)                     |
| **HTML**            | `.html`, `.htm`                                                  | Source, with a toggle to render it                                               | Find in file                                            |
| **Images**          | `png`, `jpg`, `jpeg`, `gif`, `bmp`, `webp`, `svg`, `ico`         | Image viewer, with annotation                                                    | n/a                                                     |
| **Audio**           | `mp3`, `wav`, `m4a`, `aac`, `flac`, `ogg`, `oga`, `opus`, `weba` | [Floating player](/media-player)                                                 | n/a                                                     |
| **Video**           | `mp4`, `m4v`, `webm`, `mov`, `ogv`                               | [Floating player](/media-player)                                                 | n/a                                                     |
| **Code**            | `.ts`, `.py`, `.go`, `.rs`, and the usual suspects               | Syntax-highlighted source                                                        | Find in file (text, regex, or line)                     |
| **Plain text**      | `.txt`, `.rst`, `.adoc`, `README`, `LICENSE`, ...                | Readable prose                                                                   | Find in file                                            |
| **Everything else** | including `.sqlite`, `.db`, `.zip`, fonts, binaries              | ["Binary File" card](#sqlite-and-other-databases) with an Open Externally button | n/a                                                     |

Three of these give you a real query language rather than a search box. They are worth knowing individually.

## Parquet: a typed query language

Parquet gets the most powerful filter in Maestro, because Parquet is the only format that carries enough type and statistics information to make one work. Full detail is in [Parquet Preview](/parquet-preview); the short version:

```
status = active and price > 100
ts >= now-7d
region in (us, eu)
name ~ /^acme-\d+$/
notes is null
```

One box, no mode switch: a bare word searches every column, anything with an operator is a typed predicate. Comparisons use the column's declared type, so `ts >= now-7d` compares instants and `price > 9.99` compares numbers.

What makes it different from the others: **the filter runs against the whole file, in the main process, and skips data it can prove cannot match.** A Parquet file records each column's min and max per row group, so a one-day range over a year of data typically reads one row group and ignores the rest. The bar tells you how much it skipped. That is why a multi-gigabyte file filters instantly, and why this viewer can handle files far larger than memory while the others cannot.

<Tip>
`Cmd+F` / `Ctrl+F` in a Parquet file jumps to the filter box rather than opening a find bar. In a data grid, "find" means "find rows".
</Tip>

## JSON and JSONL: jq

Open a `.json`, `.jsonl`, or `.ndjson` file and press `Cmd+F` / `Ctrl+F`, then switch the search bar to **jq** mode using the toggle on its right. You get a real (if compact) jq engine over the file's records.

The two file types start differently. A `.jsonl` or `.ndjson` file opens straight into the record viewer, because one-record-per-line is unreadable as raw text. A `.json` file opens as ordinary syntax-highlighted source and **switches** to the tree viewer the moment you enter jq mode, so a small config file still looks like the file you wrote.

`.json` parses the whole document as one value. `.jsonl` and `.ndjson` parse one record per line, which is the common shape for logs and exports, and each record is filtered independently.

| Expression                         | What it does                    |
| ---------------------------------- | ------------------------------- |
| `.`                                | identity - show the full object |
| `.fieldName`                       | extract a field                 |
| `.foo.bar`                         | nested field access             |
| `.[0]`                             | array index                     |
| `.[]`                              | iterate all elements            |
| `select(.type == "error")`         | filter by field value           |
| `select(.msg \| contains("fail"))` | filter by substring             |
| `select(.status >= 400)`           | numeric comparison              |
| `select(.a and .b)`                | boolean AND                     |
| `.timestamp, .message`             | multiple fields                 |
| `keys`                             | show object keys                |
| `length`                           | object, array, or string length |
| `has("field")`                     | check field existence           |
| `.msg \| test("err.*")`            | regex match                     |
| `.items \| sort_by(.name)`         | sort an array by key            |
| `.tags \| unique`                  | deduplicate an array            |

Supported operators include the pipe, `,`, `==`, `!=`, `>`, `<`, `>=`, `<=`, `and`, `or`, `not`, plus `map()`, `group_by()`, `to_entries`, `startswith()`, `endswith()`, and `type`.

The syntax help is built into the bar - click any example to run it. Invalid expressions report the error rather than silently showing everything.

Records also render two ways: a **tree** view with collapsible nodes, and a **table** view when the records share enough of a schema for columns to make sense. Toggle between them in the viewer's header.

<Warning>
This is a lightweight jq implementation, not a binding to the real `jq` binary. It covers the filtering and extraction subset people actually type into a viewer. Exotic expressions (variables, `reduce`, user-defined functions, path expressions) are not supported and will report a parse error.
</Warning>

## CSV and TSV: row filtering

`.csv` and `.tsv` files open as a real table. `Cmd+F` / `Ctrl+F` filters the table down to rows where **any cell** contains what you typed, case-insensitive, with the hits highlighted in place. There is no expression syntax here - it is a substring match across the row, which is the right tool for a spreadsheet export.

Click any column header to sort (again to reverse, a third time to clear). Numeric-looking columns sort numerically and right-align automatically.

Full detail, including the row detail view, is in [General Usage](/general-usage#csv-and-tsv-tables).

<Note>
The CSV table renders up to 500 rows at a time and filters the rows already parsed in the renderer. For a file large enough that this matters, convert it to Parquet - the Parquet viewer filters the entire file in the main process and has no row ceiling.
</Note>

## The row detail view

Both the CSV table and the Parquet grid share one thing: **double-click any row** to flip it from horizontal to vertical. You get a modal listing every column as a field/value pair, one per line, with long and multi-line values wrapped in full instead of truncated at the edge of the screen.

Inside it:

- **Left / Right** step through rows, following whatever the table is currently showing (so it respects your sort and filter).
- **Up / Down** scroll the field list, with `PageUp` / `PageDown` and `Home` / `End`.
- `/` jumps to the field filter. `Enter` hands focus back to the list.
- Each value has a copy button on hover.
- `Esc` closes it and leaves the file open.

The field list takes focus the moment it opens, so every one of those keys works without clicking first.

## Find in file

For everything without a format-specific filter - code, markdown, plain text - `Cmd+F` / `Ctrl+F` opens the standard find bar with three modes you cycle through with the chip on its left:

- **Text** - plain substring, case-insensitive.
- **Regex** - JavaScript regular expressions. An invalid pattern is reported rather than silently matching nothing.
- **Line** - jump to a line number.

Regex and line modes are offered only where they mean something. Rendered markdown, CSV tables, and jq mode fall back to plain text.

## Very large files

Text, code, and markdown files pick one of three rendering tiers automatically, based on size and line shape:

| Tier      | When                                                         | What you get                                                    |
| --------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| **Rich**  | the default                                                  | Full rendering: markdown, syntax highlighting, images, diagrams |
| **Fast**  | over 256 KB or 5,000 lines                                   | Virtualized rendering, still formatted                          |
| **Giant** | over 8 MB, 500,000 lines, or any line over 10,000 characters | A CodeMirror source view built for enormous files               |

The tier is picked once when the file opens and shown as a chip in the toolbar - click it to override in either direction for that tab.

Parquet is not part of this system. It never loads the file at all, so its size does not affect how it renders.

## SQLite and other databases

**Maestro does not currently open SQLite databases.** A `.sqlite`, `.sqlite3`, or `.db` file gets the generic "Binary File" card with an **Open in Default App** button, which hands it to whatever your OS has registered - usually a dedicated database browser.

The same is true of any other database file, archive (`.zip`, `.tar`, `.gz`), font, or compiled binary.

If you want to query a SQLite database inside Maestro today, the practical path is your agent: ask it to run `sqlite3 yourfile.db "select ..."` in [command mode](/general-usage#command-mode) or as a tool call, which works now and needs no viewer.

## What no viewer does

Every preview in Maestro is **read-only for structured formats**. The CSV table, JSON tree, Parquet grid, and rendered Mermaid all display data; none of them write it back. Plain text, code, and markdown are the exception - those are editable with `Cmd+E` / `Ctrl+E`.

Exporting is available where it makes sense: the Parquet viewer writes its filtered rows out as CSV or JSON Lines.
