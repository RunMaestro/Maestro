# Dataview fixture vault

The shared test vault for the Dataview feature. Every Dataview phase tests against it; see `docs/agent-guides/DATAVIEW.md` for the requirement IDs (DV-n) and decisions (Dn).

This README is not a note in the vault: the index tests must skip it (or count it as a page with no fields) and must not assert on it.

## Rules for changing the vault

- The bytes matter. Line numbers, inline field syntax, list indentation (tabs), and YAML quoting are what the tests check, so the folder is in `.prettierignore` and lint-staged never rewrites it.
- **Creation time.** File creation time on disk is not stable (a clone, a checkout, or a copy resets it). Every note sets a frontmatter `created` date, and the tests stub `file.ctime` (and so `file.cday`) from that value instead of reading `birthtimeMs`. A new note that takes part in a `file.cday` or `file.ctime` sort must set `created` too.
- If you add a note that a query below picks up, update the expected results in this file and in the tests in the same change.

## Files and the requirements they cover

| File                              | Covers                                                                                                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.obsidian/app.json`              | DV-4: marks this folder as the vault root. Also a dot folder the index must skip.                                                                                                                                            |
| `People/Pedram Amini.md`          | The spec's two motivating blocks, exactly. DV-1, DV-2 (`this` binding, `or` sources, link equality, `SORT`, `LIMIT`). Also `aliases` and a frontmatter tag.                                                                   |
| `People/Rami Example.md`          | DV-3: frontmatter `Company`, `Role`, a quoted single link `Connection: "[[Pedram Amini]]"` (a frontmatter link, so it is also an outlink), two `aliases`, a frontmatter tag.                                                   |
| `People/Dana Sample.md`           | DV-3: a list-valued frontmatter field (`Connection`) holding several links, one with a path and display text. `contains()` over a list.                                                                                       |
| `People/Lee Outsider.md`          | Negative case: in `"People"` but connected to Rami only, so the People query leaves it out.                                                                                                                                 |
| `meetings/2026-09-01 Kickoff.md`  | DV-3: `#meeting` in frontmatter `tags`, a wiki link and an aliased wiki link to people, a `Summary::` inline field. Matches both sources of the first query.                                                                 |
| `meetings/2026-09-15 Review.md`   | Folder source without the tag (the `#meeting` in it sits in a code span, so it is not a tag). Aliased link `[[Pedram Amini\|Pedram]]`.                                                                                       |
| `meetings/2026-09-20 Unrelated.md` | Negative case: tag and folder match, no link to Pedram, so `WHERE` drops it.                                                                                                                                                 |
| `Notes/Standup.md`                | DV-3: inline `#meeting` tag, a `[[Pedram Amini]]` link, `(mood:: upbeat)` and `[focus:: indexing]` inline fields, tasks with inline fields (`[due:: 2026-10-05]`, `[priority:: high]`, `(owner:: [[Rami Example]])`), a completed task, a nested list with a field on a child item and a task under a list item. DV-1 `TASK`, DV-8 task toggles. |
| `Notes/Header Fields.md`          | DV-3: `Key:: value` lines right after the frontmatter (text, link, date, number). DV-1 inline DQL `` `= this.Status` `` and `` `= this.Owner` ``.                                                                             |
| `Notes/Markdown Link.md`          | DV-3: a markdown link `[x](Other.md)` as an outlink, and an external `https://` link that is NOT an outlink.                                                                                                                |
| `Notes/Other.md`                  | Target of the markdown link, so it has an inlink from `Markdown Link`. Also the shorter of the two `Other` notes, so `Projects/Links` links here too.                                                                        |
| `Notes/Broken Frontmatter.md`     | DV-3: invalid YAML frontmatter (`tags: [unclosed`). Parsing yields one warning and an empty frontmatter, never a throw; the `State::` body field still indexes. Its `created` is read from the raw text.                     |
| `Projects/Links.md`               | DV-3: a heading link, an aliased block link, a self link `[[#Links]]`, an embed, a bare `[[Other]]` (shortest path wins) and `[[Alpha/Other]]`, an unresolved `[[Missing Note]]`, a multi-word `Review Date::` key (`review-date`), and a tag and a link inside a code fence (both ignored). |
| `Projects/Alpha/Other.md`         | DV-3: a second note named `Other`, one folder deeper than `Notes/Other.md`, for the shortest-unique-path rule.                                                                                                              |
| `Projects/Alpha/Design/Spec.md`   | DV-3: a note three folders deep (`file.folder`), a nested tag `project/alpha` (`file.tags` expands it, `file.etags` does not), a link target with a path from Dana's frontmatter.                                            |
| `.trash/Deleted.md`               | Negative case: a dot folder. It has `#meeting` and links to Pedram, so if it shows up in a result, the index did not skip dot folders.                                                                                      |
| `Queries/Query Gallery.md`        | DV-1: `LIST`, `TABLE WITHOUT ID`, `TASK`, `GROUP BY`, `FLATTEN`, and `CALENDAR` (the "not supported" pill). DV-9: a block with a parse error.                                                                              |
| `Scripts/JS Demo.md`              | DV-11, DV-12: `dataviewjs` blocks for `dv.table` over `dv.pages('#meeting')`, `app.vault` (must fail with `Obsidian API not available in Maestro`), `dv.view`, and `dv.io.csv`; an inline `` `$= dv.current().file.name` ``. |
| `views/sample/view.js`, `view.css` | D5 `dv.view('views/sample', { title })`: `view.js` renders a header, a `div.sample-view`, and the People names; `view.css` styles it.                                                                                       |
| `data/people.csv`                 | D5 `dv.io.csv` (a vault-local CSV).                                                                                                                                                                                          |

## Expected results for the motivating blocks

Evaluated on `People/Pedram Amini.md`, with `created` as the creation time.

First block (`FROM #meeting or "meetings"`, linked to Pedram, `file.cday` descending):

| File                | Created    | Summary                         |
| ------------------- | ---------- | ------------------------------- |
| `2026-09-15 Review` | 2026-09-15 | Reviewed the vendoring map.     |
| `Standup`           | 2026-09-10 | (null)                          |
| `2026-09-01 Kickoff` | 2026-09-01 | Kicked off the Dataview work.   |

`2026-09-20 Unrelated` (no link) and `.trash/Deleted` (dot folder) are not in the result.

Second block (`FROM "People"`, `Connection` contains Pedram, `file.cday` descending):

| File          | Company      | Role              |
| ------------- | ------------ | ----------------- |
| `Dana Sample` | Sample Labs  | Researcher        |
| `Rami Example` | Example Corp | Security Engineer |

`Lee Outsider` (connected to Rami) and `Pedram Amini` (no `Connection`) are not in the result.
