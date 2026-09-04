---
title: Agent Collaboration
description: Two ways to put your agents on the same problem - a single-turn @mention you moderate, or a group chat an agent moderates for you.
icon: users
---

Maestro runs a roster of agents, each with its own project, provider, and machine. Agent Collaboration is how you get them working on the same question instead of side by side in separate windows.

There are two ways to do it, and the difference between them is not syntax. It is **who moderates the conversation, and for how many turns**.

- **[Cross-Agent Mentions](./cross-agent-mentions)** - type `@another-agent` in any chat and that agent answers once, inline, without blocking you. You are the moderator: if the reply opens a new question, you write the next message.
- **[Group Chat](./group-chat)** - appoint one agent as moderator, hand it the question, and it wrangles the others across as many rounds as the question needs before coming back to you with a synthesis.

## Picking One

|                        | [Cross-Agent Mentions](./cross-agent-mentions)      | [Group Chat](./group-chat)                           |
| ---------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| **Who moderates**      | You                                                 | An agent you appoint                                 |
| **Rounds per message** | Exactly one                                         | As many as the moderator decides it needs            |
| **Where it happens**   | Inline, in the chat you are already in              | A dedicated group conversation in the Left Bar       |
| **The other agents**   | Answer in their own consult tab, resumed per thread | Persistent participants the moderator can re-consult |
| **Best for**           | A quick answer or a parallel fan-out                | Work that takes several rounds of back and forth     |

The short version: reach for a **mention** when you just need an answer and you are happy to drive. Open a **Group Chat** when you want somebody other than you to keep the agents pushing on each other.

<Tip>
  You are not locked in. Start with a mention, and if the answer turns into a discussion, open a Group Chat and let a moderator take over from there.
</Tip>

## What Both Share

- **Any provider.** Claude Code, Codex, OpenCode, and the rest can all be reached, in either direction. An agent on one provider can consult an agent on another.
- **Local or remote.** Agents running on another machine over [SSH Remote Execution](./ssh-remote-execution) participate exactly like local ones.
- **Each agent keeps its own context.** A consulted agent answers from inside its own project, with its own files and its own conversation loaded. That is the entire point of asking it rather than asking yours.
- **Nothing is lost.** Consults land in a durable tab on the agent that answered, and both surfaces write [History](./history) entries, so you can go back and read what was asked and by whom.
- **You stay in control of the context you share.** Mentions forward a window of your current transcript, and both surfaces honor read-only mode.

## Cross-Agent Mentions

Type `@` in any AI input, pick an agent, and send. Maestro forwards the relevant slice of your chat to that agent, runs it as a fresh background process, and streams the reply back into your conversation with an attribution header showing who answered.

It never blocks you: keep typing while the consult runs. Mention several agents in one message and they run in parallel, so a fan-out takes as long as the slowest one rather than the sum.

[Read the full Cross-Agent Mentions guide](./cross-agent-mentions) for the mention picker, context controls, mentioning a whole group, queued mentions, and how to stop a consult in flight.

## Group Chat

Create a chat with `Opt+Cmd+G` / `Alt+Ctrl+G`, pick a moderator, and `@mention` the agents you want in the room. The moderator receives your question first, routes it to the agents that can answer, pushes back when an answer is thin, and synthesizes the result.

Participants are added automatically the moment they are mentioned, and they persist, so the moderator can go back to the same agent later in the conversation.

[Read the full Group Chat guide](./group-chat) for the moderator's role, worked examples, remote participants, and managing chats.

## Related

- [Symphony](./symphony) - run a scripted multi-agent pipeline rather than a conversation
- [Maestro Cue](./maestro-cue) - trigger agents automatically on events instead of by hand
- [SSH Remote Execution](./ssh-remote-execution) - put agents on other machines into the mix
