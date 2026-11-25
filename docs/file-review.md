---
title: Reviewing Files
description: Comment on lines of any file open in the File Preview or the file editor, collect the comments into one review, and send them to the agent as one message with each comment tied to its file, lines, and the text it quotes.
icon: message-square-plus
---

You can review any file an agent can work on, not only its git diff: a plan, a spec, a README, or code the agent has not touched yet. Right-click a line to comment on it, leave as many comments as you like, then send them all to the agent as one review. It works like inline comments on a GitHub pull request, and it is the same review as [Reviewing Diffs](./diff-review): the same comment box, the same **Review** tray, and the same way of sending.

## Leave a comment

Right-click and pick **Comment on Line** (or **Comment on Lines** for a span):

| Where you right-click                                            | What the comment covers               |
| ---------------------------------------------------------------- | ------------------------------------- |
| A line in the file editor                                        | That line                             |
| Selected text in the file editor                                 | Every selected line                   |
| A line number in the file editor's gutter                        | That line                             |
| A paragraph, heading, list item, or table in a rendered document | The source lines that block came from |
| A line of highlighted code or plain text in the preview          | That line                             |
| Selected text in the preview                                     | Every line the selection touches      |

A comment box opens under the last line it covers. Type your comment (Markdown is fine) and press `Cmd+Enter` / `Ctrl+Enter`, or click **Add Comment**. `Esc` closes the box without saving.

Comments are pinned to source lines, so commenting from the rendered preview switches the tab to the editor with the box open on those lines, the way GitHub comments on a document's source. Press `Cmd+E` / `Ctrl+E` to go back to the preview; your comments stay.

Saved comments are drawn under their lines in the editor, and the lines they cover are tinted. Click the pencil on a comment to edit it, or the trash icon to remove it.

The large-file views (the Fast and Giant tiers), tables (CSV, JSONL, Parquet), rendered HTML, and diagrams have no line mapping in the preview; open the file in the editor (`Cmd+E` / `Ctrl+E`) and comment there. Images and binary files take no comments.

While spell check is on in the file editor, right-clicking a word keeps the spelling menu; comment from a selection or the line-number gutter instead.

## Collect the review

Every pending comment on the file is listed in the **Review** tray at the bottom of the tab. Click one to jump to it and edit it.

Each file has its own review, for the agent whose file tab it is. Comments stay until you send or discard them: switching between the preview and the editor keeps them, and so does closing the tab, including a comment you were still typing. Open the same file in the same agent again and they are back. Quitting Maestro clears them.

### Outdated comments

If the lines a comment covers change after you wrote it (you edit the file, the agent rewrites it, or a line is added above), the comment is marked **Outdated** in the tray and is no longer drawn on a line. An outdated comment is never sent, because its line numbers would point the agent at the wrong text. It stays in the tray so you can read it, remove it, or write it again on the new lines.

## Send the review

The tray has the same three actions as the [diff review](./diff-review#send-the-review): **Send Review to (agent)** queues the review for the agent (a busy agent picks it up when its turn ends) and takes you to its tab, **Edit in Composer** puts it in the agent's message box instead, and **Discard** throws it away (click twice to confirm). If you were still typing a comment, it is saved and sent with the rest.

## What the agent receives

The review arrives as one message. Comments are in file order, and each one quotes the lines as they read when you commented:

````markdown
I reviewed `docs/plan.md` and left 2 comments pinned to specific lines. Please address each one.

Each comment names the file and lines it is about, then quotes those lines as they read when I commented.

## Comment 1 of 2

`docs/plan.md:3`

```markdown
Ship the parser.
```

Say which parser: the YAML one or the TOML one.

## Comment 2 of 2

`docs/plan.md:4-5`

```markdown
Then the CLI.
Done.
```

Merge these into one step.
````

The path is relative to the agent's working directory when the file is inside it, and absolute when it is not.

## For agents and scripts

Every action in the tray has a `maestro-cli` verb, working on the same pending comments the tab shows. Lines are quoted from the file on disk.

```bash
maestro-cli file-review add docs/plan.md 3 "Say which parser" -a <agent-id>
maestro-cli file-review add docs/plan.md 4-5 "Merge these into one step" -a <agent-id>
maestro-cli file-review list docs/plan.md -a <agent-id>
maestro-cli file-review edit docs/plan.md <comment-id> "Name the YAML parser" -a <agent-id>
maestro-cli file-review remove docs/plan.md <comment-id> -a <agent-id>
maestro-cli file-review clear docs/plan.md -a <agent-id>
maestro-cli file-review send docs/plan.md -a <agent-id> [--compose] [--focus]
```

`send` delivers without moving your view unless you pass `--focus`. See [CLI: Reviewing a File](cli.md#reviewing-a-file).
