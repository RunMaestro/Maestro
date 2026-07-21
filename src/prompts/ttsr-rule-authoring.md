# Authoring a Time-Traveling Stream Rule

You are being asked to write or edit a TTSR rule for this project.

TTSR watches your own output stream while you work. When a rule matches, Maestro
interrupts the turn, feeds the rule's text back to you as a `<system-interrupt>`,
and restarts the turn so you can correct course. Rules are how the user tells
future agents (including you) what not to do in this repo.

## What to do

Write one markdown file per rule under `{{TTSR_RULES_DIR}}/`, named after the
rule in kebab-case (for example `{{TTSR_RULES_DIR}}/no-force-push.md`). Use your
normal file-writing tools. Do not create any other files, and do not modify
source code as part of this task.

When you are done, state in one sentence what the rule catches and what it will
not catch.

## File format

YAML frontmatter, then a markdown body. The **body is the message injected back
into the agent**, so write it as an instruction to the agent, not as a
description of the rule.

```markdown
---
name: no-force-push
description: Stop force-pushes to shared branches
condition:
  - 'git push .*--force'
  - 'git push .*\s-f\b'
scope: [tool:bash]
interruptMode: always
repeatMode: after-gap
repeatGap: 3
---

Do not force-push. It rewrites history other people have already pulled.
Push to your own branch and open a pull request instead.
```

## Fields

| Field           | Meaning                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `name`          | Optional. Defaults to the filename. Must be unique in the project; the first file wins and later ones are shadowed.    |
| `description`   | One line, shown in the rules list.                                                                                     |
| `condition`     | Regex strings, OR'd. JavaScript regex syntax. Matched against whichever streams `scope` names.                         |
| `astCondition`  | ast-grep patterns, OR'd. Structural matching over written file content. Only for `.ts/.tsx/.js/.jsx/.css/.html` files. |
| `scope`         | Which streams to match. See below. Defaults to `[text, thinking]`.                                                     |
| `globs`         | Narrows `tool:edit`/`tool:write` matches by file path. Ignored by every other scope, including `tool:bash`.            |
| `interruptMode` | `always` (default), `never`, `prose-only`, `tool-only`. `never` defers to a reminder on the next prompt instead.       |
| `repeatMode`    | `after-gap` (default) re-fires after `repeatGap` turns; `once` fires a single time per conversation.                   |
| `repeatGap`     | Integer >= 1, default 3. Only meaningful with `after-gap`.                                                             |
| `agents`        | Optional allowlist. Leave it out - it defaults to exactly the agents whose control surface can evaluate the rule.      |

## Scopes: pick the one that matches the actual behaviour

| Scope        | Matches                                  | Use it for                                      |
| ------------ | ---------------------------------------- | ----------------------------------------------- |
| `text`       | The agent's prose as it writes it        | Stated intent, claims, tone                     |
| `thinking`   | The agent's reasoning stream             | Reasoning the user wants steered                |
| `tool:write` | The full content of a file being created | Content rules: banned APIs, secrets, patterns   |
| `tool:edit`  | The replacement text of an edit          | Same, for partial edits                         |
| `tool:bash`  | The shell command about to run           | Forbidden commands: force-push, publish, rm -rf |

**Choosing the scope is the most important decision.** A rule aimed at an action
(`npm publish`, `git push --force`, `rm -rf`) must use `tool:bash`. If you put it
on `text`/`thinking` it will fire when the agent merely _mentions_ the command -
including when it says it is avoiding it - and will miss the command entirely
when the agent runs it without narrating.

Likewise a rule about code content (`console.log`, `any`, `@ts-ignore`) belongs
on `tool:write`/`tool:edit`, optionally narrowed with `globs`.

## Limits to respect - do not write a rule that cannot work

- **`tool:bash` and `tool:edit`/`tool:write` are corrective, not preventive.**
  Maestro sees the tool call as it streams, so a fast command may already have
  run. The rule makes the agent answer for it; it does not block it. Never write
  a rule body that claims the action was prevented.
- **factory-droid and grok report no tool calls at all.** Any `tool:*` rule
  simply excludes them. That is expected, not a bug.
- **`astCondition` needs a supported language.** Non-JS/TS files are skipped.
- **TTSR never matches its own config**, so rule files themselves are exempt.
- Regexes are matched against a rolling buffer. Anchors like `^`/`$` rarely do
  what you want; prefer a distinctive substring.

## Quality bar

- Prefer one precise rule over a broad one. A rule that fires constantly costs a
  full turn each time and gets disabled by the user.
- Escape regex metacharacters in YAML: `console\.log\(`, not `console.log(`.
  Quote any pattern containing `:`; single quotes avoid double-escaping.
- The body should say what to do instead, not just what is forbidden.
- If the user's request cannot be expressed with these scopes, say so plainly
  and propose the closest rule that does work, rather than writing one that will
  silently never fire.

## The request

{{USER_REQUEST}}
