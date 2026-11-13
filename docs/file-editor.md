---
title: Editing Files
description: The File Preview has a built-in code editor - completion, auto-closing brackets and tags, multiple cursors, find and replace, editing shortcuts, optional Vim keybindings, and a way to hand a selection to an agent.
icon: code
---

Any text file you open in the File Preview can be edited in place. Press `Cmd+E` / `Ctrl+E` (or the edit button in the toolbar) to switch from the preview to the editor, and `Cmd+S` / `Ctrl+S` to save. `Esc` or `Cmd+E` takes you back to the preview. If you try to leave a file with unsaved changes, Maestro asks first.

The editor is built on CodeMirror 6. It edits source code, markdown, config files, and plain text, and it follows your theme and your **File Editor** font settings.

## What the editor does

| Feature                     | How it works                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Syntax highlighting**     | TypeScript, JavaScript, JSX/TSX, Python, Go, Rust, Java, C/C++, C#, PHP, Ruby, shell, SQL, HTML, CSS/SCSS, JSON, YAML, TOML, XML, and markdown.                   |
| **Autocomplete**            | Words from the open file in every language, plus the language's own completions where it has them (see below). `Tab` or `Enter` accepts.                          |
| **Auto-close**              | Brackets and quotes close as you type them. HTML, XML, and JSX tags close too.                                                                                    |
| **Multiple cursors**        | `Opt+Click` / `Alt+Click` adds a cursor, `Cmd+D` / `Ctrl+D` adds the next occurrence of the selection, `Shift+Opt+Drag` / `Shift+Alt+Drag` selects a column.      |
| **Find and replace**        | `Cmd+F` / `Ctrl+F` opens the find bar with a Replace field. Text or regex, replace one, or replace all in one undoable step.                                      |
| **Editing shortcuts**       | Toggle comment, move line, duplicate line, indent and outdent a selection.                                                                                        |
| **Code folding**            | Fold markers in the gutter collapse a block.                                                                                                                      |
| **Bracket matching**        | The bracket that pairs with the one at the caret is highlighted.                                                                                                  |
| **Auto-indent**             | New lines and closing brackets indent to match the code around them.                                                                                              |
| **Selection highlighting**  | Other occurrences of the selected word are highlighted.                                                                                                           |
| **Go to line**              | The find bar's **Line** mode jumps to a line number.                                                                                                              |
| **Line numbers, word wrap** | Both toggle from the toolbar and under **Settings -> Display -> File Edit & Preview**.                                                                            |
| **Vim keybindings**         | Optional, off by default. See [Vim mode](#vim-mode).                                                                                                              |
| **Send to an agent**        | Right-click a selection to quote it into your message or send it to another agent, with the file path and line range. See [below](#hand-a-selection-to-an-agent). |

## Autocomplete

In code files the completion list opens as you type. It always offers words already in the file, and adds the language's own suggestions where the language provides them:

- **JavaScript and TypeScript**: keywords, snippets (`for`, `if`, `function`, `class`), and names declared in the file.
- **CSS and SCSS**: property names and values.
- **HTML** (and HTML inside markdown): tag and attribute names.
- **Python**: keywords and names declared in the file.
- **SQL**: keywords.
- **JSON, YAML, and the rest**: words from the file.

Move through the list with `Up` and `Down`, accept with `Tab` or `Enter`, and close it with `Esc`. `Ctrl+Space` opens it on demand.

In markdown and plain-text files the list does not open by itself, so `Enter` after a word always starts a new line. Press `Ctrl+Space` when you want it. Very large files (the [Giant tier](./file-formats#very-large-files), over 8 MB) skip completion so typing stays fast.

## Multiple cursors

Everything you type goes to every cursor at once.

- `Opt+Click` / `Alt+Click` adds a cursor where you click. Your platform's usual `Cmd+Click` / `Ctrl+Click` works too.
- `Cmd+D` / `Ctrl+D` selects the next occurrence of the current selection, with its own cursor. Press it again for the one after that.
- `Shift+Opt+Drag` / `Shift+Alt+Drag` draws a rectangular (column) selection, one cursor per line.
- `Esc` goes back to a single cursor. A second `Esc` leaves the editor.

## Find and replace

`Cmd+F` / `Ctrl+F` opens the same find bar the preview uses. In the editor it has a second field, **Replace with**:

- Type the search in the first field, then `Tab` to the Replace field.
- `Enter` replaces the current match and moves to the next one.
- `Cmd+Enter` / `Ctrl+Enter`, or the **Replace All** button, replaces every match. One `Cmd+Z` / `Ctrl+Z` undoes the whole replacement.
- The chip on the left of the find field picks **Text** (plain, case-insensitive) or **Regex**. In regex mode the replacement can use `$1`, `$2`, ... for capture groups, `$<name>` for a named group, and `$&` for the whole match.

## Editing shortcuts

| Action                        | macOS                   | Windows/Linux           |
| ----------------------------- | ----------------------- | ----------------------- |
| Toggle comment                | `Cmd+/`                 | `Ctrl+/`                |
| Add cursor at next occurrence | `Cmd+D`                 | `Ctrl+D`                |
| Move line up / down           | `Opt+Up` / `Opt+Down`   | `Alt+Up` / `Alt+Down`   |
| Duplicate line up / down      | `Shift+Opt+Up` / `Down` | `Shift+Alt+Up` / `Down` |
| Indent / outdent selection    | `Tab` / `Shift+Tab`     | `Tab` / `Shift+Tab`     |
| Undo / redo                   | `Cmd+Z` / `Cmd+Shift+Z` | `Ctrl+Z` / `Ctrl+Y`     |
| Save                          | `Cmd+S`                 | `Ctrl+S`                |

`Cmd+/` is Show Shortcuts everywhere else in Maestro; while the editor has focus it toggles a comment. `Cmd+[` and `Cmd+]` keep switching agents, so indent with `Tab` and `Shift+Tab`. The full list is on the [Keyboard Shortcuts](./keyboard-shortcuts#file-editor) page.

## Hand a selection to an agent

Select some text in the editor and right-click it:

- **Quote in Message** puts the selection into the agent's message box as a quote, with the file path and line range on top, and moves you to the agent's chat with the caret below it. Type your question and send. Quote several passages in a row to ask about them together.
- **Send to Agent** opens the Send to Agent dialog with the same passage, so you can hand it to a different agent.
- **Copy to Clipboard** copies just the selected text.

The passage the agent receives looks like this:

````markdown
`src/renderer/App.tsx:120-134`

```tsx
...the selected lines...
```
````

The path is relative to the agent's working directory when the file sits inside it.

## Vim mode

Turn on **Vim keybindings in the editor** under **Settings -> Display -> File Edit & Preview**. It is off by default.

With Vim mode on, the editor starts in normal mode and supports insert and visual modes, motions, operators, registers, and `:` commands. A status line under the editor shows the mode and the command you are typing. `Esc` returns to normal mode instead of leaving the editor; use `Cmd+E` / `Ctrl+E` to go back to the preview, and `Cmd+S` / `Ctrl+S` to save.

## Very large files

Files over 8 MB, 500,000 lines, or with a line longer than 10,000 characters open in the read-only [Giant tier](./file-formats#very-large-files). You can still edit them: everything above works except autocomplete, which is skipped at that size.
