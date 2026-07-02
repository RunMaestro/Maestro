---
title: Cross-Agent Mentions
description: Consult another agent inline by typing @name in any chat. Maestro forwards your conversation and streams the reply straight back.
icon: at
---

<Note>
  Cross-Agent Mentions is an [Encore Feature](./encore-features). Enable it under **Settings → Encore Features → Cross-Agent Mentions** before the Agents section appears in the `@` picker.
</Note>

Cross-Agent Mentions let you pull another agent into your current conversation without leaving it. Type `@` in any AI input, pick an agent, and Maestro forwards the relevant slice of your chat to that agent, runs it in the background, and streams its answer back inline - stamped with who replied.

It is the lightweight cousin of [Group Chat](./group-chat): no moderator, no shared room, no ceremony. Just a quick "what does the backend agent think about this?" from wherever you already are.

## When to Use It

- **Second opinion** - "@Reviewer does this migration look safe?" without copy-pasting your thread into another agent.
- **Cross-project context** - Ask the agent that owns the backend repo a question while you work in the frontend one.
- **Specialist consult** - Route a security or performance question to the agent that has that codebase loaded.
- **Quick fan-out** - Mention several agents (or a whole group) in one message and let them answer in parallel.

## Mentioning an Agent

1. In the AI input, type `@`. The mention picker opens with two categories: **Files** and **Agents** (agents and groups you can reach from this agent).
2. Keep typing to filter, or use the arrow keys. Pick an agent to insert an `@name` token, which renders as a chip.
3. Write your question as usual and send. The `@name` stays in your message so the consulted agent knows it was addressed.

The picker uses a **single `@` for everything**. Maestro tells files and agents apart by shape: a path-like body such as `@src/app.ts` or `@notes.md` is a file reference, while a bare word like `@codex` is matched against your live roster of agents and groups. A `@word` that names nothing stays plain text.

<Tip>
  You can also type the whole token by hand. `@Review-Bot` and `@review-bot` resolve to the same agent - matching is case-insensitive. If an agent's name has spaces, use hyphens (`@My-Project` for "My Project").
</Tip>

## What Happens When You Send

The consultation is **non-blocking and isolated**:

- Maestro forwards a window of your current tab's transcript plus your prompt to the target agent.
- The target runs as a **fresh, ephemeral process** - it is not injected into that agent's own live chat, so the consultation never pollutes the other agent's conversation and it will not remember the exchange afterward.
- Your chat is never blocked. A small pill at the top of the input shows in-flight consultations (each agent's name and elapsed seconds); click it to expand the list. Keep typing while you wait.
- When the target finishes, its reply streams back **inline into the chat you are already in**, attributed to the agent that answered.

Mention several agents in one message and each runs independently and concurrently, so a fan-out returns as fast as the slowest agent, not the sum of them.

<Note>
  Consulted agents run wherever they are configured, including [SSH remotes](./ssh-remote-execution) and their own model or token-mode settings. Terminal-only agents cannot be mentioned, and an agent cannot mention itself.
</Note>

## Controlling How Much Context You Share

By default Maestro forwards your **entire current transcript** so the other agent has the full picture. When that is more than you want to share, add a natural-language hint to your message and Maestro narrows the slice automatically:

| You write...                                          | Maestro forwards...                            |
| ----------------------------------------------------- | ---------------------------------------------- |
| _(nothing)_                                           | The full transcript (default)                  |
| "the **last 5 messages**"                             | The last 5 conversational messages             |
| "the **last 3 turns**" / "the **last 2 exchanges**"   | The last 3 user + assistant turns              |
| "**share the last 10**"                               | The last 10 messages                           |
| "look at **this thread**", "the **most recent** part" | A small recent window (about the last 5 turns) |

An explicit count always wins over a softer hint, and the hint is read from your prose only - the `@name` token itself is ignored when Maestro decides the window.

<Tip>
  Example: `@Backend given the last 3 messages, is our retry logic still correct?` sends only the tail of the conversation, not the whole thing.
</Tip>

## Mentioning a Group

Mention a [group](./general-usage) by name (`@Backend-Team`) to consult every agent in it at once. Group mentions expand to each non-terminal member and run as independent consultations. If you mention both a group and an agent that belongs to it, that agent is still consulted only once.

Groups sort above individual agents in the picker, so a name that matches both surfaces the group first.

## Cross-Agent Mentions vs Group Chat

Both let agents talk to each other, but they solve different problems:

|                      | Cross-Agent Mentions            | [Group Chat](./group-chat)            |
| -------------------- | ------------------------------- | ------------------------------------- |
| **Where it happens** | Inline, in your existing chat   | A dedicated group conversation        |
| **Coordination**     | None - a direct one-off consult | A moderator AI routes and synthesizes |
| **Best for**         | Quick questions and fan-out     | Multi-round discussions and synthesis |
| **The other agent**  | Answers once, statelessly       | Is a persistent participant           |

Reach for a mention when you just need an answer; open Group Chat when you need agents to deliberate together over several rounds.
