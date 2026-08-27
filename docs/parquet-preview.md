---
title: Parquet Preview
description: Open a Parquet file as a live, filterable table. Maestro reads only the columns and row groups your filter actually needs, so a multi-gigabyte file opens instantly.
icon: table
---

Double-click a `.parquet` file and Maestro opens it as a table you can filter, sort, and read, not as a "binary file" card.

Parquet files are routinely larger than memory, so Maestro never loads one. It reads the file's footer to learn the schema, then fetches only the rows on screen and only the columns you are looking at. Opening a 20 GB file costs the same few kilobytes as opening a 2 MB one.

`.parquet`, `.parq`, and `.pq` are all recognized. Files on an [SSH remote](/ssh-remote-execution) work too: Maestro caches a local copy the first time you open one, because there is no way to read scattered byte ranges over an SSH shell.

## The filter box

One box, no mode switch. Type whatever you know:

| You type                   | What it means                                    |
| -------------------------- | ------------------------------------------------ |
| `acme`                     | any column contains "acme"                       |
| `status = active`          | exact match, using the column's real type        |
| `price > 100 and qty <= 5` | combine with `and`, `or`, `not`, and parentheses |
| `price > 100 qty <= 5`     | terms side by side are combined with `and`       |
| `region in (us, eu)`       | set membership                                   |
| `id between 100 and 200`   | inclusive range                                  |
| `ts >= now-7d`             | relative time: `s`, `m`, `h`, `d`, `w`           |
| `ts >= 2024-01-15 10:30`   | absolute date or date and time                   |
| `name ~ smith`             | contains, case-insensitive                       |
| `name ~ /^acme-\d+$/`      | regular expression                               |
| `path ^= /var/log`         | starts with (`$=` is ends with)                  |
| `notes is null`            | null tests (`is not null` too)                   |
| `[order id] = 42`          | square brackets for names with spaces            |

Comparisons use the column's declared type, so `ts > now-1h` compares instants, `price > 9.99` compares numbers, and `id = 9007199254740993` stays exact on a 64-bit integer column rather than rounding.

Misspell a column and Maestro tells you which one you meant, with a button to fix it. Click the `?` beside the box for the same list of examples, and click any of them to try it.

<Tip>
The filter runs against the whole file, not the rows currently on screen. A search box that only searched the first page would be worse than no search box.
</Tip>

## Why it is fast

Under the filter box, Maestro shows what the query actually did:

```
skipped 18 of 20 row groups (90%)   read 543 KB   2,880 rows examined   fully pushed down
```

A Parquet file is written in row groups, and each one records the minimum and maximum value of every column. When your filter is a comparison Maestro can check against those recorded ranges, it skips whole row groups without decompressing them. A one-day time range over a year of data typically touches a single row group.

- **skipped N row groups** is the work avoided. The higher, the better.
- **read** is the bytes actually pulled off disk for this query.
- **fully pushed down** means the whole filter was answered by the file's own index. **Partial pushdown** means part of it (a substring match, a null test, a bare search term) needed Maestro to look at rows directly, which still works and is just slower.

A bare search term has to look at every column of every row, so it is the slowest kind of filter. If you know which column you want, naming it is dramatically faster.

## The schema rail

The left rail lists every column with its type, how nullable it actually is, its recorded value range, and how many bytes it costs. It answers the questions people usually open a Parquet file to ask: which column is enormous, which is mostly empty, what range does this cover.

- Click a column name to start a filter on it.
- Click the eye to hide a column. Hidden columns are dropped from the query, so Maestro stops reading them entirely - on a wide table this makes everything faster, not just tidier.
- Toggle the whole rail with the **Schema** button.

## Reading rows

- **Click a column header** to sort. Click again to reverse, a third time to clear. Sorting orders the entire filtered result, not just the loaded page.
- **Drag a header's right edge** to resize the column.
- **Double-click a row** to open it as a record: one field per line, values wrapped in full. Arrow left and right to step through rows, `/` to filter the fields.
- **Scroll** to load more. Rows stream in as you go.
- The number gutter shows each row's position in the file, so it stays meaningful under a filter or a sort.

## Row counts

While a filter is still scanning, the count reads `1,204+ of 8,412,004 rows match`. The `+` means "at least" - Maestro shows you rows as soon as it finds them rather than making you wait for a full pass. The exact total fills in behind you.

On a very large file the exact count is not started automatically; click **Count all matches** in the footer when you want it.

If a filter matches an enormous number of rows, Maestro stops collecting at its internal cap and says so. Narrow the filter to see the rest.

## Export

**Export** writes the currently matching rows to a file, honoring your filter, your sort, and your hidden columns. Choose `.csv` or `.jsonl` by the extension you give it.

## What is not supported

- **Editing.** The preview is read-only.
- **Encrypted Parquet files.** Maestro will report that it could not open the file rather than showing partial data.
- **Nested columns** (lists, maps, structs) render as JSON and can be searched as text, but cannot be sorted or compared with `>` and `<`.
- **Remote files above 512 MB.** Fetching one over SSH means transferring the whole file, so Maestro refuses and suggests copying it locally first.
