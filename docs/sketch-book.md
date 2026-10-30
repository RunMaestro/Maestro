---
title: Sketch Book
description: A collaborative Excalidraw whiteboard your agent can read and draw on, shared end-to-end encrypted through RunMaestro.ai, with @bot requests screened before the agent sees them.
icon: pen-ruler
---

Sketch Book gives an agent a whiteboard.

A sketch is an [Excalidraw](https://excalidraw.com) canvas that opens in its own tab on an agent. You draw on it, and the agent that owns it reads and draws on it too, with its own tools: shapes, arrows, text, and Mermaid diagrams converted to shapes. When you want other people on the board, share it through RunMaestro.ai. Guests open a web link, edit the board live, and can ask the agent for help with `@bot` in the room chat.

Sketch Book is an [Encore Feature](./encore-features), off by default. Turn it on in **Settings -> Plugins -> Sketch Book**. It runs in the desktop app only, and only on local agents: an agent that runs over SSH cannot open a Sketch Book.

## Opening a Sketch Book

A sketch belongs to the agent you open it on. Only that agent can read or draw on it.

| Way in          | How                                                                      |
| --------------- | ------------------------------------------------------------------------ |
| Keyboard        | `Opt+Cmd+K` (macOS) or `Alt+Ctrl+K` (Windows and Linux)                  |
| Command palette | **New Sketch Book**                                                      |
| Menu            | **New Sketch Book** in the hamburger menu of the Left Bar                |
| Tab bar         | The `+` button, then **Sketch Book**                                     |
| Agent           | The agent creates one with its `sketch_create` tool, in a background tab |

A Sketch tab behaves like any other tab: you can rename, tile, snooze, or move it to another window. Closing the tab does not stop a shared room.

## Finding a sketch again

Closing a Sketch tab never deletes the drawing. **Reopen Closed Tab** (`Cmd+Shift+T`) brings back a recent one. For any sketch, open the **Sketch Books** list:

| Way in          | How                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------- |
| Keyboard        | `Opt+Cmd+Shift+K` (macOS) or `Alt+Ctrl+Shift+K` (Windows and Linux)                       |
| Command palette | **Sketch Books**                                                                          |
| Menu            | **Sketch Books** in the hamburger menu of the Left Bar, or **File** > **Sketch Books...** |
| Tab bar         | The search (magnifier) menu, then **See All Sketch Books**                                |

Every way in lists every sketch on this computer across all agents, newest first, both the ones open in tabs and the closed ones. Type to search by sketch name, agent name, or id. Each row shows the owning agent, when the sketch was made, and whether it is **Open** in a tab or **Shared**.

| Action | How                                       | Notes                                                                                      |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| Open   | `Enter`, double-click, or the open button | Opens the sketch in a tab on the agent that owns it. Not possible when that agent is gone. |
| Rename | `F2` or the pencil button                 | Renames the sketch. Tab labels are the tabs' own and do not change.                        |
| Delete | The trash button, then **Delete**         | Removes the drawing and closes its tabs. Stop sharing a shared sketch first.               |

From a terminal:

```bash
maestro-cli sketch new --agent <agent-id> --name "Architecture"   # opens in a background tab
maestro-cli sketch list
maestro-cli sketch open <sketchId>
maestro-cli sketch rename <sketchId> "Release plan"
maestro-cli sketch delete <sketchId>                               # asks first; --yes skips it
maestro-cli sketch read <sketchId>                                 # a summary of shapes and connections
maestro-cli sketch export <sketchId> --format png --output board.png
```

Sketches are saved on this computer, in Maestro's data folder under `sketches/<agentId>/`. Use **Save to project** in the Sketch tab to put a copy in the agent's working directory. Deleting an agent does not delete its sketches.

On the canvas, Excalidraw's shortcuts win over Maestro's, except tab switching, Quick Actions (`Cmd+K`) and Switch Agent (`Cmd+O`), which always leave the sketch. Excalidraw's Add link is `Cmd+Opt+B` there, Open is `Cmd+Opt+O`, and Reset zoom is `Shift+0`. See [Keyboard Shortcuts](./keyboard-shortcuts#sketch-book) for the full list.

### What the agent can do

When Sketch Book is on, Maestro adds a `maestro-sketch` MCP server to the providers set up on this computer (Claude Code, Codex, OpenCode, and Factory Droid). Through it the agent can list its sketches, read the board, see what changed since it last looked, add, change, or delete elements, convert a Mermaid diagram, take a screenshot, export, scroll your view to an element, and post in the room chat. It sees only the sketches it owns. Turning Sketch Book off removes the server again.

An agent can create a sketch. It can never share one: sharing is always your action.

## Sharing

Sharing puts the sketch in a room on RunMaestro.ai and gives you a link. The board is encrypted on your computer with a key that only travels in the part of the link after `#`, so RunMaestro.ai stores and relays ciphertext it cannot read.

Open the **Collaborate** panel with the **Collaborate** button at the top right of the canvas, **Collaborate...** in the canvas menu, or `Cmd+Shift+C` (`Ctrl+Shift+C` on Windows and Linux) while the Sketch tab has focus. The button turns green while the room is live, and a **Room** button appears beside it once the sketch has a room. Excalidraw's **Library** sits at the bottom right, beside **Help**.

The first time you share, the Collaborate panel asks for your email address and sends a confirmation link. Any address works. Click the link and the panel turns to **Share and copy link** on its own, also if you closed it and opened it again meanwhile. Confirming also subscribes the address to occasional Maestro news, with an unsubscribe link in every issue. After you confirm, this computer holds the sign-in. No browser can act as the room owner: the owner is this desktop.

| Link role         | A guest with this link can       | Default expiry |
| ----------------- | -------------------------------- | -------------- |
| Read-write (`rw`) | View, edit, chat, and ask `@bot` | 7 days         |
| Read-only (`ro`)  | View and chat                    | 30 days        |

Each share mints a new link. Give each person or group their own link, so you can revoke one without the others. The link is copied to the clipboard; it is not shown in a notification. Every live link is listed under **Links** in the panel:

- **Copy** copies that link again, for example into a meeting chat.
- **Reset** replaces that link with a new one with the same access, and copies it. Guests on the old link are disconnected.
- **Revoke** ends that link for good.

Maestro keeps each link's secret encrypted on this computer, beside the room key, so it can copy the link again later. A link made before this change cannot be copied; reset it to get one that can.

```bash
maestro-cli sketch owner register --email you@example.com --wait
maestro-cli sketch share <sketchId> --role rw --expires-days 3 --label "Design review"
maestro-cli sketch link <sketchId> <capId>        # print a live link again
maestro-cli sketch reset-link <sketchId> <capId>  # replace one link
maestro-cli sketch unshare <sketchId>             # delete the room; the sketch stays
```

When an agent runs `share`, `unshare`, `link`, `reset-link`, `revoke-link`, or `rotate`, Maestro shows a confirmation on the desktop instead of running it.

## Asking the agent: @bot

Type `@bot` (or `@` and the agent's name) in the room chat to ask the agent for something. The agent answers in the chat and draws on the board.

You chat from the **Chat** tab of the Collaborate panel. The panel opens on it when the sketch has a room or the agent has posted, and again whenever a guest request or a held reply waits on you; messages that arrive while another tab shows are counted on the **Chat** tab. It ends in a message box: **Enter** sends, **Shift+Enter** starts a new line. A message that starts with `@bot` asks the agent; anything else goes to the room for everyone to read. On a sketch you have not shared, every message asks the agent. Messages render as Markdown, like the rest of Maestro's chats. Images in a guest's message do not load: a placeholder shows where each one would be, so a guest cannot learn your address or point Maestro at a file on your computer.

```bash
maestro-cli sketch chat <sketchId> --last 10            # read the chat
maestro-cli sketch chat <sketchId> "Looks good to me"   # post to the room as you
maestro-cli sketch chat <sketchId> "@bot label every box"
```

When an agent posts with `sketch chat`, Maestro asks you on the desktop first, since the message goes out under your name. An agent that reads the chat never sees a guest's message: nothing screened it, so the text is withheld.

**Your own requests** run as soon as you send them, in a separate conversation that belongs to the sketch, never the agent's other tabs. Until a guest has edited the board, they run with the agent's normal permissions. After a guest edit, your requests run **restricted** (read-only, plus the sketch tools), because the board now holds text you did not write. Under a restricted reply, **Run with full access** runs that one message again with full access. It never carries over to the next message.

**Guest requests** are off by default. To allow them, turn on **Let collaborators ask the agent** in the Collaborate panel. Maestro shows what that means before it takes effect: anyone with an edit link can ask, each request is screened and then waits for you, a run uses your model quota, and everything the agent posts is visible to the room. The switch is greyed out, with the reason, while it cannot be safe:

- the safety screen is off (see below), or
- the agent's provider cannot run a restricted turn that still lets it draw. Claude Code and Codex can; OpenCode cannot.

A guest request on Claude Code runs with read and search tools in the agent's own folder plus the sketch tools, and nothing else: no shell, no file edits, no other MCP servers, no hooks, and no sketch export. It ignores the agent's custom arguments and Additional Directories. It needs a Claude Code that knows `--restricted` (2.1.312 does); an older one refuses the turn, and the request fails rather than running with more access. An agent whose Path points at `maestro-p` cannot run these turns.

### The approval chip

A guest request that passes the screen shows an approval chip in the Sketch tab chat and a notification you can click. The chip shows:

- who asked, as the server recorded it (for example `"Sam" · guest, read-write link #3, not verified`), never only the name the guest typed,
- the request itself,
- the screen's verdict, for example `Screened: clean, Prompt Guard 2, 0.04`.

Press **Run** to start the turn, or **Deny**. Guest turns always run restricted. At most three chips show at a time; newer requests wait behind them. A request nobody answers expires after 15 minutes.

If the agent's reply contains something that looks like a secret, Maestro holds it with **Publish anyway** and **Discard** instead of posting it.

```bash
maestro-cli sketch requests             # open requests and held replies
maestro-cli sketch approve <replyTo>
maestro-cli sketch deny <replyTo>
maestro-cli sketch escalate <replyTo>   # Run with full access
maestro-cli sketch bot-policy <sketchId> writers
```

## The safety screen

Anything a guest writes, in chat or on the board, is screened for prompt injection on your computer before the agent can read it. The screen fails closed: text that is flagged, or that could not be screened, is **withheld** from the agent. It is not deleted from the board.

Turn the screen on in **Settings -> Models -> System One**, on the **Prompt-injection screen** row. The quickest path is the **Download Prompt Guard 2 (77 MB)** button beside the greyed-out switch in the Collaborate panel, which downloads the model and assigns it in one step. The model runs on this computer, and a short message takes a few milliseconds to screen.

| Screen result | What happens                                                                         |
| ------------- | ------------------------------------------------------------------------------------ |
| Clean         | The text reaches the agent, marked as untrusted                                      |
| Flagged       | Withheld. A guest's `@bot` request is rejected; three rejections lock that guest out |
| Could not run | Withheld. The guest's request is rejected, but it never counts toward their lockout  |

With the screen off, guests cannot ask `@bot`. Your own restricted requests can still read guest text on the board, labelled as unscreened; full-access requests cannot. Images that guests upload are always withheld from the agent unless you approve each one.

### Cloud screening

If your System One engine is a cloud service (Jev, or an OpenJev server), the screen would send decrypted guest text there. Maestro does not do that silently:

1. The first time, a confirmation names the service and its address, and what leaves your computer: guest chat and board text, and the agent's replies before they are posted. **Keep local** sends nothing.
2. If you switch to a cloud engine while a room is live, Maestro asks again before the next guest text goes out.
3. Guests are told first. Their page shows a notice and a lasting **Screened by a cloud service** badge before any of their text is sent, and only text written after that point goes to the cloud.

To allow an engine before you share, use **Allow...** in **Settings -> Plugins -> Sketch Book**. It opens the same confirmation. OpenJev consent is bound to its server, so OpenJev must be your System One engine before you can allow it. Revoke consent in the same place, or with `maestro-cli sketch screening-consent revoke --engine jev`.

## What guests see

A guest opens the link in any modern browser, picks a display name, and sees the board and the room chat. There is no account.

- **Edit links** can draw. **View links** can only look and chat.
- `@bot` shows the request's progress: screening, waiting for approval, running, then the reply. A rejected or expired request says so.
- When your computer is asleep, offline, or Maestro is closed, the agent shows as offline and `@bot` is refused at once. Requests are never queued for later.
- The room's screening badge reads **Local screening** or **Screened by a cloud service**, marked "reported by the room owner", since the server cannot check it.

The same screening badge shows at the bottom center of the canvas. If your screen failed any guest requests, a banner above the board says how many.

## Running the room: Kick vs Revoke

Once the sketch is shared, the Collaborate panel has four tabs. **Chat** is the room chat (above). **Share** makes new links and lists the live ones, each with Copy, Reset, and Revoke. **People** lists who is in the room, with Kick and Unlock. **Safety** holds **Let collaborators ask the agent**, how guest text is screened, the elements the screen flagged (with a one-click delete for each), and **Reset all access**. **Stop sharing** sits at the bottom of the panel, on every tab but Chat. Drag the panel's left edge to make it wider or narrower; double-click the edge to restore the default. The width is remembered.

| Action               | What it does                                                                                     | Use it when                                  |
| -------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| **Kick**             | Disconnects one guest for a while (60 minutes from the panel). Their link still works afterwards | Someone needs a time-out                     |
| **Revoke**           | Kills one link for good. Everyone on it is disconnected                                          | A link went somewhere it should not have     |
| **Reset all access** | Revokes every link and re-keys the room. You share again to let anyone back in                   | You do not know who has a link any more      |
| **Unlock**           | Clears a guest's lockout after three rejected requests                                           | A false positive locked out the wrong person |
| **Unsuspend**        | Lets a link ask `@bot` again after five rejections on it                                         | The same, for a whole link                   |

Kick is temporary. Revoke is the real fix.

```bash
maestro-cli sketch stats <sketchId>
maestro-cli sketch kick <sketchId> <actorId> --minutes 30
maestro-cli sketch revoke-link <sketchId> <capId>
maestro-cli sketch rotate <sketchId>           # Reset all access
maestro-cli sketch unlock <sketchId> <actorId>
maestro-cli sketch audit <sketchId> --flagged  # why something was withheld
```

The audit log records each screening decision (who, when, the verdict) and never the text.

## Offline use

Sketch Book is local-first: the file on your computer is the source of truth. Everything except sharing works with no connection to RunMaestro.ai: creating and drawing, the agent's tools, your own `@bot` requests, export, and Save to project. The safety screen runs on your computer, so it works offline too.

Edits you make while a shared room is offline are sent when the connection comes back, after the board catches up with what guests did in the meantime. When your computer sleeps or Maestro quits, the room shows the agent as offline until you are back.
