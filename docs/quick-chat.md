---
title: Quick Chat
description: Press a system-wide hotkey from any app to open a small floating chat with one of your agents.
icon: comment-dots
---

Quick Chat is a small floating window for a fast conversation with one agent. Press the hotkey from any app, type, read the answer, and press the hotkey again to put it away. You never switch to the main Maestro window.

The first message of a chat finds its tab. A message about something an open tab is already discussing goes to that tab, a message that picks up a conversation you closed last week reopens it, and a new subject starts a new tab. Every message after that stays in the same tab, so a follow-up always continues the conversation it follows. To change the subject, start a new chat. See [How a chat finds its tab](#how-a-chat-finds-its-tab).

![Quick Chat](./screenshots/quick-chat.png)

Quick Chat is an [Encore Feature](/encore-features), on by default. It ships as the first-party **Quick Chat** plugin.

## Opening and closing it

| Action                                       | How                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open, focus, or close the window             | `Opt+Space` (macOS) / `Alt+Space` (Windows, Linux), from any app                                                                                                                                                                                                                                                              |
| Open it from inside Maestro                  | **Open Quick Chat** in the command palette, **Quick Chat** in the Left Bar hamburger menu, or `maestro-cli open quick-chat`                                                                                                                                                                                                   |
| Close it                                     | `Esc`, `Cmd+W` / `Ctrl+W`, or the **X** in the window                                                                                                                                                                                                                                                                         |
| Go back to Maestro                           | ``Cmd+` `` (macOS), or the hotkey that summons Maestro. Both close Quick Chat and bring the Maestro window forward                                                                                                                                                                                                            |
| Start a new chat                             | `Cmd+N` / `Ctrl+N`, or the pencil in the window                                                                                                                                                                                                                                                                               |
| Bring back an earlier chat                   | `Cmd+Y` / `Ctrl+Y`, or the clock beside the brain. Type to filter (any word you sent matches), then `Enter`. The window switches to that chat's agent, its tab, and its messages. See [Recent chats](#recent-chats)                                                                                                           |
| Switch agent                                 | Click the agent name at the top left, or `Cmd+O` / `Ctrl+O`. Type to filter, then `Enter`                                                                                                                                                                                                                                     |
| Choose the tab                               | Click the tab name beside the agent, or `Cmd+T` / `Ctrl+T`. Pick a tab, **New tab**, or **Any tab** (Maestro finds one). The chat continues where you send it                                                                                                                                                                 |
| Send                                         | `Enter` (`Shift+Enter` for a new line). You do not have to wait for a reply: the next message can go out while the last is still being answered                                                                                                                                                                               |
| Attach images                                | Paste them (`Cmd+V` / `Ctrl+V`), drop image files on the window, or click the image button beside the brain. Thumbnails sit above the draft: click one to view it, drag to reorder, **x** to remove. They go to the tab with the message, like images pasted into the main window. A message of images alone starts a new tab |
| Stop                                         | The square button, shown beside Send while anything is in motion. It stops the replies in progress and withdraws messages still waiting                                                                                                                                                                                       |
| Open the tab a message went to               | Click the pill under the message                                                                                                                                                                                                                                                                                              |
| Stop waiting on a busy tab                   | **Send to a new tab**, or **Steer** it into the running reply, shown under a message that is queued                                                                                                                                                                                                                           |
| Disagree with the tab Maestro chose          | The thumbs-down beside the pill. The message is sent to a new tab instead, and the chat continues there                                                                                                                                                                                                                       |
| Open the chat in Maestro                     | `Cmd+Shift+T` / `Ctrl+Shift+T`, or the arrow in the window. The chat becomes a visible tab and Maestro comes forward                                                                                                                                                                                                          |
| View a diagram full screen                   | The expand button on a diagram or image. The window fills its screen until you press `Esc`                                                                                                                                                                                                                                    |
| Make the conversation text bigger or smaller | `Cmd+=` / `Cmd+-` (`Ctrl` on Windows and Linux), or the A buttons at the bottom left. `Cmd+0` resets. Maestro remembers the size across restarts, and `maestro-cli quick-chat font` sets it                                                                                                                                   |
| Keep the chat as a tab                       | `Cmd+S` / `Ctrl+S`, or the bookmark in the window. Press again to make it temporary                                                                                                                                                                                                                                           |
| Pin the window on top                        | `Cmd+P` / `Ctrl+P`, or the pin in the window. Press again to unpin                                                                                                                                                                                                                                                            |
| Show the agent's thinking                    | `Cmd+Shift+K` / `Ctrl+Shift+K`, or the brain in the window. It steps through hidden, shown while the agent works (gone once the answer arrives), and kept above each answer. Remembered across restarts                                                                                                                       |
| Talk instead of typing                       | The microphone beside Send, when [A Cappella](./voice-mode) is on. Click to start or end, hold to talk                                                                                                                                                                                                                        |

The hotkey toggles: when the window is closed it opens; when it is open but behind another window it comes to the front; when it is in front it closes. Closing the window keeps the conversation, so the next press brings you back where you were.

The window shows on every desktop, including over full-screen apps. While the pin in the window is on (the default, toggled with `Cmd+P` / `Ctrl+P`), it floats above other apps. Turn the pin off and it behaves like an ordinary window: it falls behind whatever you click next, and the hotkey still brings it to the front. Maestro remembers the pin across restarts.

Drag the grip at the top of the window (or the header, once a conversation is showing) to move it, and drag an edge or corner to resize it. Maestro remembers the size and the spot across restarts. Until you move the window yourself, it opens centered on the screen under your pointer.

Before your first message the window is just the composer: it grows taller as your draft gets longer (up to a limit, then the draft scrolls), and you can drag only its width. Once a conversation is showing, you can make it taller or shorter too, and that height is kept for the next conversation. If the screen the window was on is no longer connected, it opens on your main screen instead.

## How a chat finds its tab

Every message you send from Quick Chat runs in a real AI tab on the agent you chose. It uses that agent's provider, model, working directory, SSH remote, and permissions, exactly like a tab you type into yourself. Which tab is decided once, for the chat's first message. Every later message goes to that same tab, even one whose words would fit another tab better, because a follow-up belongs to the conversation it follows. A new chat (`Cmd+N` / `Ctrl+N`, or the pencil) is how you start a new subject; its first message finds a tab again. If you close the chat's tab, the next message finds one again too.

The tab name beside the agent at the top of the window shows where your next message goes. Until the chat has a tab it reads **Choose tab**, and Maestro finds one for the first message. Set **Default Tab** to **New tab** in the settings and it reads **New tab** instead: every chat starts in a new tab and nothing is searched. To move the chat, click it (or press `Cmd+T` / `Ctrl+T`) and pick another of the agent's tabs, **New tab** to start fresh in a new one, or **Any tab** to let Maestro find the one that fits the next message. The chat continues in whatever tab that message lands in. The picker opens on the row in effect, with **New tab** at the top: from **Any tab**, `Cmd+T`, `Up`, `Enter` is the fast way to a new tab. From the command line, `maestro-cli quick-chat tab` does the same (`status` lists the tab ids).

While a tab is being chosen, the message shows **Searching tabs**. Then a pill under it names the tab it went to:

| Pill                  | What happened                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| An open tab's name    | The message continued a conversation one of the agent's open tabs already holds                                        |
| A reopened tab's name | The message continued a conversation you closed in the last two weeks. Maestro reopened it as a tab, in the background |
| A new tab's name      | Nothing fit, so the message started a new tab. The tab is named from the message                                       |

Click a pill to open that tab in the main Maestro window.

For that first message, Maestro chooses in two steps. First it compares the words of your message with each candidate: the agent's open tabs, and the conversations in its [History](/history) from the last two weeks. A tab that clearly matches wins at once. A message that resembles nothing starts a new tab at once, as long as the chat has no conversation in progress. Everything else is a close call, and goes to a small, fast model that reads a short list of candidates and picks one, for example when two tabs are about the same thing. Expect **Searching tabs** to show for a few seconds then. When that model is unavailable or too slow, the message starts a new tab.

The choice leans toward a new tab. A message sent into the wrong conversation becomes part of that conversation, and that cannot be undone. To start over with no conversation in progress, start a new chat (`Cmd+N` / `Ctrl+N`).

When Maestro picks the wrong tab, click the thumbs-down beside the pill. A reply still being written there stops, the message is sent again in a new tab, and the chat continues in that new tab. What already reached the old tab stays in it. From the command line, `maestro-cli quick-chat new-tab <message-id>` does the same.

### When the tab is busy

A tab answers one message at a time. When Maestro finds a tab for a message, it skips the agent's tabs that are in the middle of a reply, so a message that matches a busy tab starts a new tab instead of waiting behind it. The chat's own tab is the exception. A follow-up sent before the last answer finished, or a message you sent to a busy tab yourself, waits in the agent's queue and shows **Queued** under it. It runs when that tab is free.

If you would rather not wait, click **Send to a new tab** next to **Queued**. The message leaves the queue and runs in a new tab now, and the chat moves with it: your next message goes to that new tab. The same thing from the command line is `maestro-cli quick-chat new-tab`.

When the running reply can take input, a **Steer** button shows beside **Queued** too. It hands the message to the reply in progress, so the agent can change course now instead of answering it afterwards. It is the same steer as the queue card's [Steer](./general-usage#steer) button in the main window, offered under the same conditions, and the message never sends twice: if the agent does not take it, it goes back to **Queued**. From the command line, `maestro-cli quick-chat steer [message-id]` does the same, and `status` marks a queued message that can be steered.

A message waits only for its own tab, never for the agent's other tabs. This is true whatever **Forced Parallel Execution** is set to: that setting governs **Force Send** in the main window, and Quick Chat has always run beside whatever else the agent is doing.

<Warning>
Two replies running at once on one agent share its working directory. If both edit files, they can step on each other. Quick questions are safe. For two tasks that both change code, let the first finish, or use agents in separate worktrees.
</Warning>

### Tabs Quick Chat creates

A chat has one of two modes, and you can flip between them at any time with the bookmark in the window or `Cmd+S` / `Ctrl+S`. The mode applies only to the tabs the chat **creates**. A tab the agent already had, and a tab reopened for a message, are yours: Quick Chat never hides or deletes them.

| Mode                | What happens to a tab the chat creates                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ephemeral (default) | The tab is hidden: no chip in the tab bar. When you start a new chat, the tab is deleted once any reply in progress has finished. Whether its turns write [History](/history) entries is a setting. |
| Kept (bookmark on)  | The tab is visible on the agent like any other and stays there after you start the next chat.                                                                                                       |

Only Stop stops a reply. Closing the window, starting a new chat, switching agents, or bringing back a recent chat never cuts off a message already sent: it goes through out of sight, and its reply lands in the recent chats (`Cmd+Y` / `Ctrl+Y`), where bringing the chat back shows it, live if it is still running.

An ephemeral chat that wrote History entries is still a conversation from the last two weeks, so a later message about the same subject can reopen it.

### Recent chats

Maestro remembers your last 30 chats on this computer. Click the clock beside the brain (or press `Cmd+Y` / `Ctrl+Y`) to list them, newest first, with each chat's agent, its number of messages, and when it was last active. Type to filter: the agent's name, the tab's name, and every message you sent in a chat all match. Pick a chat to bring it back:

- The window switches to the chat's agent, and that agent becomes Quick Chat's agent, as switching agents does.
- The chat continues in its tab. When that tab is closed (an ephemeral chat's tab is deleted when you start the next chat), Maestro reopens the conversation. A tab the chat created comes back hidden again unless the chat was kept.
- The messages come back with their replies. A reply shows what its tab holds now, or what it held when you last saw it if the tab is gone. Images are not kept in the list; they are in the tab with their message.

The chat in the window is saved to the list before the other one comes back, so nothing is lost by switching. If a chat's conversation cannot be reopened (its transcript is gone), the chat still comes back and your next message finds a tab the usual way. From the command line, `maestro-cli quick-chat history` lists the chats and `maestro-cli quick-chat recall <n>` brings one back.

A reply in a tab Quick Chat created never raises a completion toast in the main window: you are reading it in Quick Chat. The audio or spoken notification you configured still plays. A reply in one of your own tabs notifies the way that tab always does.

## Talking to it

With [A Cappella](./voice-mode) turned on, the composer has a microphone beside Send. It opens a voice session that is locked to this chat: what you say is sent as your message, word for word, and the reply is spoken as well as shown.

| Gesture | What it does                                                                            |
| ------- | --------------------------------------------------------------------------------------- |
| Click   | Starts the session with the microphone open. Click again to end it                      |
| Hold    | Push-to-talk: the microphone is open while you hold, and letting go sends what you said |

While a session is running, the microphone shows what it is doing (listening, working, speaking), and what it hears appears in the window before it is sent. Spoken and typed messages land in the same conversation, so you can mix them.

A spoken message is routed like a typed one: it continues the conversation it belongs to, or starts a new tab. When that tab is still answering an earlier message, the spoken one waits in the queue, and its reply is spoken once the tab answers it.

Three things differ from the voice session you start in the main window:

- **It stays here.** There is no Tab / Agent / Conductor switch, and the session does not follow the agent or tab you click in the main window. To talk somewhere else, end it and start a session there.
- **Nothing is routed.** Naming another agent is part of the message, not an instruction to send it elsewhere.
- **Closing the window ends it.** `Esc`, the **X**, the hotkey, and **Open as a tab** all put the window away, and the microphone closes with it. Switching agents or starting a new chat keeps the session: it follows the chat.

Starting a voice session from the main window while this one is running replaces it, since there is one microphone.

## Settings

Open **Settings -> Plugins**, select **Quick Chat**, and open its **Settings** tab.

- **Hotkey.** Click the button and press a new combo. Leave it blank to turn the hotkey off. If another app or Maestro hotkey already holds the combo, Maestro shows a warning and the hotkey stays off until you pick another one.
- **Agent.** The agent every new chat talks to. "The agent active in the main window" follows whatever agent you last selected. You can also switch agents from the window itself: click the agent name at the top left (or press `Cmd+O` / `Ctrl+O`), type a few letters of the agent's name, group, or provider, and press `Enter`. Switching starts a new chat on that agent and saves the choice; picking the agent you are already on keeps the chat. A chat in progress stays on its agent even if you change this setting.
- **Default Tab.** Where a new chat's first message goes, and the next message after you close the chat's tab. **Choose tab** (the default) lets Maestro find the tab: an open tab already on the subject, a conversation you closed in the last two weeks, or a new tab when nothing fits. **New tab** always starts a new tab and skips the search, so the first message sends at once. Either way, later messages stay in the chat's tab, and you can still pick a tab, **New tab**, or **Any tab** for any one message from the window.
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
maestro-cli quick-chat return            # close the window and bring Maestro forward (Cmd+` in the window)
maestro-cli quick-chat send "what does this error mean?"
maestro-cli quick-chat send "what is this?" --image ~/Desktop/shot.png   # attach images (PNG, JPG, GIF, WebP); put the message first
maestro-cli quick-chat status              # window, agent, mode, and each message with the tab it went to (--json for scripts)
maestro-cli quick-chat new
maestro-cli quick-chat keep                # keep the current chat as a tab ("keep off" makes it ephemeral)
maestro-cli quick-chat pin                 # float the window above other windows ("pin off" lets it fall behind)
maestro-cli quick-chat font in             # bigger conversation text: in, out, reset, or a size such as 120%
maestro-cli quick-chat thinking sticky     # show the agent's reasoning and keep it: off, on, sticky, or cycle
maestro-cli quick-chat tab new             # send the next message to a new tab (or a tab id, or auto); the chat stays there
maestro-cli quick-chat agent <agent-id>    # switch agents and start a new chat
maestro-cli quick-chat reveal              # open the latest message's tab in Maestro
maestro-cli quick-chat reveal <message-id> # open the tab that message went to
maestro-cli quick-chat new-tab             # send the latest queued message to a new tab instead of waiting
maestro-cli quick-chat new-tab <message-id> # send that message to a new tab: queued, or routed to the wrong tab
maestro-cli quick-chat stop                # stop replies in progress and withdraw queued messages
maestro-cli quick-chat history             # the recent chats, numbered, newest first (--json for scripts)
maestro-cli quick-chat recall 2            # bring back a recent chat: its number in history, its id, or an id prefix
maestro-cli quick-chat bounds --x 200 --y 120 --width 640 --height 520   # move or resize, as dragging does
```

`send` returns as soon as the message is accepted, while a tab is still being found for it. `status` shows each message you sent with its id and where it went, for example `You [m7] (queued for open tab "CI Build")`. That id is what `reveal` and `new-tab` take.

The microphone has no `quick-chat` verb of its own because it is a voice session: `maestro-cli voice start --quick-chat` opens the window and starts one locked to the chat, `voice stop` ends it, and `voice status` reads it. `voice scope` is refused for it.

`bounds` takes any of the four flags (`--x` and `--y` together). `--height` is the conversation height, so before the first message it is remembered rather than applied. `quick-chat status` reports the current size and spot.

The settings live in `quickChatSettings` (`hotkey`, `agentId`, `defaultTab` (`auto` or `new`), `persistent`, `ephemeralHistory`), readable and writable with `maestro-cli settings get` / `settings set`. Turn the feature off or on with `maestro-cli encore disable quickChat` / `encore enable quickChat`.

## Turning it off

Disabling Quick Chat releases the hotkey and closes the window. Chats you kept as tabs stay on their agents.
