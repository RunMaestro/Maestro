---
title: Quick Chat
description: Press a system-wide hotkey from any app to open a small floating chat with one of your agents.
icon: comment-dots
---

Quick Chat is a small floating window for a fast conversation with one agent. Press the hotkey from any app, type, read the answer, and press the hotkey again to put it away. You never switch to the main Maestro window.

Quick Chat is an [Encore Feature](/encore-features), on by default. It ships as the first-party **Quick Chat** plugin.

## Opening and closing it

| Action                           | How                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------- |
| Open, focus, or close the window | `Opt+Space` (macOS) / `Alt+Space` (Windows, Linux), from any app                  |
| Close it                         | `Esc`, or the **X** in the window                                                 |
| Start a new chat                 | `Cmd+N` / `Ctrl+N`, or the pencil in the window                                   |
| Send                             | `Enter` (`Shift+Enter` for a new line)                                            |
| Open the chat in Maestro         | The arrow in the window. The chat becomes a visible tab and Maestro comes forward |

The hotkey toggles: when the window is closed it opens; when it is open but behind another window it comes to the front; when it is in front it closes. Closing the window keeps the conversation, so the next press brings you back where you were.

The window floats above other apps and on every desktop, including over full-screen apps. Drag it by its header to move it; it remembers the spot until you quit.

## Where the conversation lives

Every Quick Chat is a real AI tab on the agent you choose. It uses that agent's provider, model, working directory, SSH remote, and permissions, exactly like a tab you open yourself. The agent can be busy in another tab: your quick chat does not wait for it.

A chat has one of two modes, and you can flip between them at any time with the pin in the window:

| Mode                | What happens                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ephemeral (default) | The tab is hidden: no chip in the tab bar. When you start a new chat, the tab is deleted. Whether its turns write [History](/history) entries is a setting. |
| Kept (pin on)       | The tab is visible on the agent like any other and stays there after you start the next chat.                                                               |

A reply never raises a completion toast in the main window: you are reading it in Quick Chat. The audio or spoken notification you configured still plays.

## Settings

Open **Settings -> Plugins**, select **Quick Chat**, and open its **Settings** tab.

- **Hotkey.** Click the button and press a new combo. Leave it blank to turn the hotkey off. If another app or Maestro hotkey already holds the combo, Maestro shows a warning and the hotkey stays off until you pick another one.
- **Agent.** The agent every new chat talks to. "The agent active in the main window" follows whatever agent you last selected. You can also switch agents from the dropdown in the window, which starts a new chat on that agent and saves the choice. A chat in progress stays on its agent even if you change this setting.
- **Keep new chats as tabs.** The default mode for a new chat.
- **Record ephemeral chats in History.** On by default, so an ephemeral chat still leaves a History entry after its tab is gone. Kept chats follow your normal history setting.

<Note>
On Windows, `Alt+Space` normally opens a window's system menu. While Quick Chat holds the combo, it opens Quick Chat instead. Pick a different hotkey if you rely on that menu.
</Note>

## From the command line

Every button in the window has a `maestro-cli quick-chat` verb that takes the same path:

```bash
maestro-cli quick-chat toggle              # exactly what the hotkey does
maestro-cli quick-chat show
maestro-cli quick-chat hide
maestro-cli quick-chat send "what does this error mean?"
maestro-cli quick-chat status              # window, agent, mode, and the conversation (--json for scripts)
maestro-cli quick-chat new
maestro-cli quick-chat keep                # keep the current chat as a tab ("keep off" makes it ephemeral)
maestro-cli quick-chat agent <agent-id>    # switch agents and start a new chat
maestro-cli quick-chat reveal              # open the chat as a tab in Maestro
maestro-cli quick-chat stop                # stop the reply
```

The settings live in `quickChatSettings` (`hotkey`, `agentId`, `persistent`, `ephemeralHistory`), readable and writable with `maestro-cli settings get` / `settings set`. Turn the feature off or on with `maestro-cli encore disable quickChat` / `encore enable quickChat`.

## Turning it off

Disabling Quick Chat releases the hotkey and closes the window. Chats you kept as tabs stay on their agents.
