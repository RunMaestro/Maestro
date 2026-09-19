---
title: Codex Assistant Directives
description: Understanding Codex's structured annotations and Maestro's rendering of them
---

## What are Codex Assistant Directives?

Codex can embed structured annotations directly into its assistant responses. These annotations, called "assistant directives," are machine-readable spans that hint at the next action the user might take. For example:

```
:codex-followup[Design the schema]{prompt="Design the canonical schema for this data model."}
```

These directives come from OpenAI's bundled Codex plugin skills, defined in the skill files under `~/.codex/plugins/cache/openai-primary-runtime/`. The grammar is specified in Codex's own source code (`codex-rs/tui/src/assistant_directives.rs`), and Maestro reads and renders them.

## Directive Format

All directives follow this pattern:

```
::<name>[Label]{attr1="value1" attr2="value2"}
```

- `:`, `::`, or `:::` - One to three colons mark the start. Codex uses one for
  inline directives (`:codex-followup`) and two for block ones (`::git-push`);
  Maestro accepts either. Four or more is ordinary prose, not a directive.
- `<name>` - The directive type (e.g., `codex-followup`, `code-comment`)
- `[Label]` - Optional human-readable label. Whether it is shown depends on the
  directive: a followup chip uses it as its caption, a file citation ignores it
  in favor of the file name.
- `{...}` - Attributes. Values may be quoted or bare, and `\"` inside a quoted
  value is a literal quote.

## Which Directives Maestro Renders

Maestro currently renders these known directives:

| Directive              | Rendered As             | User Interaction                              |
| ---------------------- | ----------------------- | --------------------------------------------- |
| `:codex-followup`      | Action chip with prompt | Click to send, Alt+click to prefill           |
| `:codex-file-citation` | File link               | Click to open the file                        |
| `::git-create-pr`      | Git action card         | Click to open the PR form                     |
| `::git-push`           | Git action card         | Click to push the checked-out branch          |
| `::git-commit`         | Git action card         | Click to commit, after a confirmation         |
| `::git-stage`          | Git action card         | Read-only: the command, with nothing to press |
| `::git-create-branch`  | Git action card         | Read-only: the command, with nothing to press |
| `::code-comment`       | Review card             | Shows inline feedback                         |

Every git card shows the command before anything runs, and it only offers a
button when pressing it runs exactly that command. Maestro's git surfaces take
no target of their own - the runner pushes the checked-out branch, and the
branch switcher switches without creating - so a directive naming a different
remote or branch renders as the command plus the reason there is nothing to
press. A `::git-create-pr` opens the same form the branch pill opens, which
owns the title, so a suggested title is shown on the control rather than passed
as a flag.

Maestro deliberately strips these directives (they're not rendered):

- `:codex-inline-vis` - Inline visualization syntax (not yet supported)

## Understanding Followup Chips

When Codex suggests a followup action using `:codex-followup`, Maestro renders it as a clickable chip in the response. The chip shows:

- **Label** - What the user sees (e.g., "Design the schema")
- **Prompt** - The full prompt on hover and accessible via keyboard
- **Mode** - Click to send, Alt+click to prefill

Example response from Codex:

```
Here's my analysis. You might want to:
- :codex-followup[Refactor for performance]{prompt="Refactor this function to be more performant"}
- :codex-followup[Add error handling]{prompt="Add comprehensive error handling"}
```

Maestro renders each suggestion as a clickable pill. Hovering shows the full prompt. Clicking sends it as a turn; Alt+clicking fills it into the composer so you can edit first.

## About File Citations

When Codex references a file using `:codex-file-citation`, Maestro renders it as a clickable link:

```
:codex-file-citation{path="/src/services/auth.ts" purpose="source"}
```

The link text is the **file name** (`auth.ts`), not the full path and not the
directive's label - a cited path is routinely sixty characters of directory
nobody is reading, and it lands mid-sentence. The full path is on hover and on
the accessible name, so a keyboard or screen-reader user gets it too.

Clicking the link opens the file in Maestro's file preview, by the same path as
any other file link in a message (so it also works for a file on an SSH remote,
and right-clicking offers the usual Copy / Save menu).

`purpose="output"` marks a file the agent **wrote** during the turn; anything
else is read as a file it only read. An output carries the theme's success color
and says so on hover, because a changed file is the one thing in a citation you
may need to act on.

## About Code Comments

`::code-comment` is by far the most common directive: it is how Codex attaches
review feedback to specific lines. Maestro draws it as a card rather than a chip,
because the body is a paragraph rather than an inline token:

```
::code-comment{title="Unbounded loop" body="This retries forever when the socket never opens." file="src/net/dial.ts" start="42" end="48" priority="1"}
```

The card stacks three things: a severity badge and the title, the body, then the
location. Only the location is pressable - it opens the file - because the
comment itself does nothing.

Severity follows P-numbering, where **P0 is the most severe**: `0` and `1` take
the error color, `2` the warning color, and `3` goes dim. A value outside that
range keeps the neutral accent, since inventing a severity for an attribute
Maestro does not recognize is how a cosmetic note gets painted as a bug. A
comment with no `body` renders as its label instead, because a title with no
explanation says less than the plain text did.

## Safety and Design

Codex's followup chips follow these safety principles:

- **Explicit user action** - Chips never auto-fire; they require a click or Alt+click
- **Full prompt visibility** - Hovering the chip shows the complete prompt on screen
- **Reversible** - Prefill mode lets you review and edit before sending
- **Clear attribution** - The prompt is visibly agent-authored in both label and detail

The chips are rendered directly from Codex's own markdown output. The parser ensures that only known directives are rendered, preventing ordinary prose (like CSS selectors `::before{...}`) from being misinterpreted.

## Which Directives You Will Actually See

Counting the directives in one developer's local Codex transcripts, the mix was
roughly:

- `::code-comment` - ~120 occurrences, by a wide margin the most common
- `:codex-file-citation` - a handful
- `:codex-followup` - occasional

Treat those as a rough shape rather than a measurement: what Codex emits depends
on the work you give it. Code comments dominate because reviewing code is when
Codex has something to say about a specific line.

## Where Directives Render

Two conditions both have to hold before a directive becomes a chip or a card,
and they answer different questions:

- **The agent is a Codex agent.** The syntax is Codex's own emitting convention,
  so the same text from any other provider is a message that happens to quote
  the format.
- **The text is the agent's own output.** A directive you typed, pasted, or
  quoted stays the text you wrote - it never becomes a live button that acts on
  your repository. The same holds for tool output, thinking blocks, error
  messages, and generated shell commands.

Directives are also left as plain text wherever the syntax is being discussed
rather than offered: inside a code fence, inside backticks, and under any
unknown directive name.

The browser interface renders them exactly as the desktop app does - it runs the
same renderer - so chips and cards work on a phone or tablet too.

## Current Limitations

- Directives render in the live conversation only. The History panel, the Agent
  Sessions browser, and HTML exports still show the raw directive text.
- The Codex CLI itself does not yet render `:codex-followup` directives, so
  Maestro ships this feature first
- Inline visualization syntax (`:codex-inline-vis`) is recognized but not
  rendered. It carries a whole HTML document, including `<script>` tags pointing
  at third-party CDNs, so Maestro leaves a short "Inline visualization not
  shown" note in its place rather than running someone else's markup and
  fetching scripts while you read.
- A directive inside a heading or a table cell stays plain text. Codex emits
  them in paragraphs and list items, which is what Maestro rewrites.
