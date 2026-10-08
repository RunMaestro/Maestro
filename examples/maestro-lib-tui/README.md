# maestro-lib terminal example

A small terminal chat with an AI coding agent, built on maestro-lib's public entry and nothing else. It picks a provider, sends prompts, streams each reply as it arrives, resumes the conversation on the next prompt, and stops a running turn with the library's stop ladder.

It is one file, `tui.mjs`. Its only imports are Node's own modules and the built library at `../../dist/maestro-lib/index.js`. It is not part of the desktop app or `maestro-cli`.

## Run it

From the repository root:

```bash
npm run build:maestro-lib
node examples/maestro-lib-tui/tui.mjs
```

Options:

| Option             | Meaning                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `--agent <id>`     | The provider to start with, for example `claude-code` or `opencode`.              |
| `--cwd <dir>`      | The folder the agent works in. Defaults to the current folder.                    |
| `--model <model>`  | A model id the provider accepts. Defaults to the provider's own choice.           |
| `--command <path>` | The provider's binary, when it is not on `PATH` or in its usual install location. |

With no `--agent`, it lists every provider with whether it can run here (or why not, for example "not found on this machine") and starts with the first one that can.

## Use it

- Type a prompt and press Enter. The reply streams in; when the turn ends you see its outcome (`completed`, `interrupted`, `crashed`), the token usage and the provider's session id.
- The next prompt continues the same conversation: the session id the last turn returned is passed back as `resumeSessionId`.
- Ctrl+C while a turn runs stops it through `handle.interrupt()`: an interrupt first, then terminate, then kill, two seconds apart. The turn ends as `interrupted`.
- A second Ctrl+C, or `/quit`, exits. A turn still running is ended with `handle.terminateNow()` first, so no agent process is left behind.

Commands:

| Command         | What it does                                              |
| --------------- | --------------------------------------------------------- |
| `/agent`        | List the providers and whether each can run here.         |
| `/agent <id>`   | Switch provider. Starts a new conversation.               |
| `/cwd <dir>`    | Set the working folder. Starts a new conversation.        |
| `/model [name]` | Set the model, or clear it to use the provider's default. |
| `/new`          | Start a new conversation with the same provider.          |
| `/help`         | List the commands.                                        |
| `/quit`         | Exit.                                                     |

Lines can also be piped in. They run one after another, and the program exits after the last one.

## How it uses the library

The whole path is four calls from the entry:

1. `getVisibleAgentDefinitions()` lists the providers, and `planSessionTurn({ agentId, cwd, prompt: '' })` says whether each can run, with the reason when it cannot. Planning starts nothing.
2. `planSessionTurn({ agentId, cwd, prompt, model, command, resumeSessionId })` plans the turn.
3. `runTurn(planned.spec, { agentId, sessionId, stopGraceMs: INTERACTIVE_STOP_GRACE_MS }, { onStarted, onEvent })` starts it and streams parsed events.
4. `await completed` gives the outcome, usage, answer and the session id for the next turn.

See [docs/maestro-lib.md](../../docs/maestro-lib.md) for the library itself.

## Tests

`src/shared/maestro-lib/__tests__/tui-example.test.ts` builds the library into a scratch folder, copies this file beside it, and drives it with a fake agent replaying a recorded turn: a turn streams, the next prompt resumes it, Ctrl+C stops a running turn, and exiting leaves no agent process. `no-desktop-framework.smoke.test.ts` checks that this file imports nothing but Node's modules and the built entry.
