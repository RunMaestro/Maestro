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

- `::` - Two colons mark the start
- `<name>` - The directive type (e.g., `codex-followup`, `code-comment`)
- `[Label]` - Optional human-readable label shown to the user
- `{...}` - Attributes with quoted values (optional)

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
:codex-file-citation[See the implementation]{path="/src/services/auth.ts"}
```

Clicking the link opens the file in Maestro's file preview.

## Safety and Design

Codex's followup chips follow these safety principles:

- **Explicit user action** - Chips never auto-fire; they require a click or Alt+click
- **Full prompt visibility** - Hovering the chip shows the complete prompt on screen
- **Reversible** - Prefill mode lets you review and edit before sending
- **Clear attribution** - The prompt is visibly agent-authored in both label and detail

The chips are rendered directly from Codex's own markdown output. The parser ensures that only known directives are rendered, preventing ordinary prose (like CSS selectors `::before{...}`) from being misinterpreted.

## Measured Directive Frequency

Local transcript analysis shows:

- `::code-comment` - ~120 occurrences (most frequent)
- `:codex-file-citation` - ~3 occurrences
- `:codex-followup` - Occasional (user-dependent)

The high frequency of code comments reflects Codex's typical use of inline feedback when reviewing code.

## Current Limitations

- Web and mobile renderings (`src/web-desktop`) are not yet updated to support these directives
- The Codex CLI itself does not yet render `:codex-followup` directives, so Maestro ships this feature first
- Inline visualization syntax (`:codex-inline-vis`) is recognized but not rendered
