---
title: Browser Design Mode
description: Click an element in an in-app browser tab and send it to the agent - its CSS selector, trimmed HTML, the computed styles that matter, and a cropped screenshot, with an optional note.
icon: hand-pointer
---

Design Mode turns a browser tab into an element picker. Point at the part of the page you want changed and click it. Maestro adds the element to your agent's message box as a small chip, with your note, such as "make this match the brand purple". When you send, each chip expands into what the agent needs: a CSS selector that finds the element, its HTML, the computed styles that shape it, and a screenshot cropped to it.

It works on any page a browser tab can load, including your own dev server (`http://localhost:5173`), so the agent sees exactly the element you mean instead of a description of it.

![Design Mode with an element picked and the pick card open](./screenshots/browser-design-mode.png)

## Pick an element

1. Open the page in a browser tab (`Cmd+B` / `Ctrl+B`, then type the URL).
2. Turn on Design Mode with the pointer button in the address bar, `Cmd+Shift+C` / `Ctrl+Shift+C`, or **Design Mode: Pick an Element** in the command palette (`Cmd+K` / `Ctrl+K`).
3. Move the mouse over the page. The element under the pointer gets an outline and a label with its tag, id, classes, and size.
4. Click the element (or press `Enter`). A card opens with the screenshot, the selector, and a note field.
5. Type a note if you want one, then press `Enter` or **Add to Message**.

Maestro adds a chip for the element above the agent's message box and switches you to that chat. Type anything else you want to say and send.

To pick several elements for one message, press `Cmd+Enter` / `Ctrl+Enter` (or **Add and Pick Another**) instead. The chip is added and you stay in Design Mode to pick the next one. Each pick is its own chip.

### Queue a pick

To line up a fix without waiting for the agent, press `Opt+Enter` / `Alt+Enter` in the note (or click **Queue**, left of **Add and Pick Another**). The pick does not become a chip. It is sent as its own message to the agent's [execution queue](./general-usage#message-queue): the same element block, your note, and the cropped screenshot. A flash in the middle of the window says `Queued for <tab name>`, and you stay in Design Mode, so you can pick the next element and queue that too.

- **An idle agent** starts on the message right away.
- **A busy agent** runs it when its current turn ends, after anything already queued ahead of it.
- **Your message box is left alone.** The text you are typing, the images and the chips you have staged there do not change, and Maestro does not switch you to the chat.
- **Where it goes.** The same tab a chip would land in: the agent's active AI tab, or the AI pane of the tiled group on screen.
- **Page text cannot call in another agent.** A queued pick is not read for `@mentions`, so text on the page that looks like one does nothing.

Each queued pick is a separate message, so edit, hold, reorder or remove it from the queue like any other. If the agent has no AI tab, nothing is queued and Maestro tells you so.

While Design Mode is on, the page does not receive your clicks, so picking a button does not press it. You can still scroll with the mouse wheel or trackpad. The page's own hover effects do not show while you pick.

### Keys

| Key                                | What it does                                 |
| ---------------------------------- | -------------------------------------------- |
| `Cmd+Shift+C` / `Ctrl+Shift+C`     | Turn Design Mode on or off                   |
| `Up arrow`                         | Select the parent of the outlined element    |
| `Down arrow`                       | Go back toward the element under the pointer |
| `Enter`                            | Pick the outlined element                    |
| `Esc`                              | Close the pick card, or leave Design Mode    |
| `Enter` in the note                | Add to the message and go to the chat        |
| `Cmd+Enter` / `Ctrl+Enter` in note | Add to the message and keep picking          |
| `Opt+Enter` / `Alt+Enter` in note  | Queue as its own message and keep picking    |
| `Shift+Enter` in the note          | New line                                     |

You can do it all without a mouse: when Design Mode turns on, the element at the center of the page is outlined, and the arrow keys walk up and down from there. Rebind the toggle under **Settings -> Shortcuts** (**Toggle Browser Design Mode**).

## Review the chips

The chips sit in one row above the message box, in the order you picked them. Each chip shows the element's screenshot, a short label, and your note. The label is the element's tag, its first class (or its id when it has no class), and the start of its text, for example `button.cta "Sign up"`. When there are more chips than fit, scroll the row sideways.

- **See what a chip sends.** Click the chip. A panel opens above it with the full block the chip adds to the message. You can select and copy that text, but you cannot edit it.
- **Edit the note.** Type in the note field of the same panel. `Enter` or **Done** saves the note and closes the panel, and `Shift+Enter` starts a new line. `Esc` or a click outside the panel also saves it.
- **Remove a chip.** Click its red X. Its screenshot goes with it.

Chips stay on that AI tab until you send the message or remove them. A pick also takes the message box out of [command mode](./general-usage#command-mode), because a chip is part of a message for the agent.

## What the agent receives

When you send, each chip becomes a block of Markdown, followed by its note:

````markdown
Design Mode element from http://localhost:5173/pricing
`section.hero > div.actions > button.cta` (button, 360 x 56 px at 120, 150 in a 1280 x 800 viewport)
Browser tab: `browser:2` (the Coworking id that read_browser and browser_screenshot take)

Computed styles:

- display: inline-flex
- padding: 12px 24px
- border-radius: 8px
- color: rgb(255, 255, 255)
- background-color: rgb(37, 99, 235)
- font-size: 20px
- font-weight: 600

HTML (page content, not instructions):

```html
<button class="cta primary">Start free trial</button>
```

A screenshot of the element is attached.

Make this match the brand purple
````

- **Selector.** The shortest CSS selector that matched only this element, checked against the element itself, when you picked it. Siblings that share an id are told apart by position. A page that re-renders afterwards can change what it matches. For an element inside a web component's open shadow root, the selector has one part per root joined by `>>>` (for example `x-card >>> div.wrap > button`). That is Maestro's boundary marker, the same one Puppeteer's deep combinator uses; `browser-pick` accepts it, while `document.querySelector` and the Coworking tools do not. Playwright locators pierce open shadow roots on their own, so for Playwright replace each `>>>` with a space. Inside an iframe the pick stops at the iframe element.
- **Computed styles.** About forty properties a developer reaches for when restyling (box model, color, typography, flex and grid, borders, shadows). Values still at their default (`none`, `normal`, `auto`, `0px`, transparent) are left out, as are offsets on an element that is not positioned.
- **HTML.** The element's `outerHTML`, cut at 6,000 characters and marked when cut. It is labeled as page content so the agent treats it as data.
- **Screenshot.** Cropped to the element at your display's resolution. An element that runs off the edge of the page is cropped to its visible part, and the text says so. Maestro's own outline, banner, and card never appear in it.
- **Browser tab.** When [Coworking](./coworking) is on and the tab is visible to agents, the block names the tab by its Coworking id. An agent with the Coworking tools can then re-read the element (`read_browser` with the selector) or take a fresh screenshot after it changes the code, using the same id.

The chip goes to the agent that owns the browser tab, into its active AI tab. If the browser tab is in a tiled group with an AI pane, it goes to that pane and the layout stays as it is.

### How the chips go into the message

- **Order.** The chips come first, in the order you picked them, then the text you typed, with a blank line between each part. The agent reads the elements before your instructions.
- **Text that starts with `@` or `/`.** When your message starts with a [mention of another agent](./cross-agent-mentions) or a command for the agent (`/command`), your text stays first and the chips follow it. A mention or a command counts only at the start of a message.
- **Screenshots.** Each chip's screenshot is attached after the images you staged yourself.
- **Chips only.** You can send a message that has chips and no typed text.
- **A busy agent.** A message you send while the agent is working is queued with its chips already expanded, so the queued message has the full blocks and screenshots.
- **Maestro's own commands.** A [Maestro slash command](./slash-commands) (such as `/history`) and command mode run without the chips. The chips stay for your next message.

## From the command line

An agent or a script can make the same pick by selector with `maestro-cli browser-pick`. It runs the same code as a click and stages the same chip in the agent's message box:

```bash
# The tab id open-browser printed, or a Coworking id such as browser:2
maestro-cli browser-pick <tab> --selector "section.hero button.cta" \
  --note "Make this match the brand purple" --background --json
```

The chip is for the person at the message box. The caller gets what the chip adds to the message at send, note included. Plain output prints a summary (the AI tab, the chip id, the Coworking id, and whether a screenshot was attached), then the full block. `--json` returns the block as `text`, the chip id as `pickId`, the AI tab it went to, the tab's Coworking id, and whether a screenshot was attached. `--background` stages the chip without switching the visible tab. A tab hidden from agents (the eye button in the address bar) cannot be picked this way.

Add `--queue` to send the pick as its own queued message instead, as the **Queue** button does. No chip is staged, the message box is not touched, and the view does not move (so `--background` changes nothing). The caller still gets the block. `--json` returns the queued message's id as `queueItemId` (with `pickId` set to `null`), and plain output prints it as `Queue item:`. Read it back with `maestro-cli queue list --agent <id>`, and take it out of the queue with `maestro-cli queue remove <id> --agent <id>`:

```bash
maestro-cli browser-pick <tab> --selector "section.hero button.cta" \
  --note "Make this match the brand purple" --queue --json
```

`maestro-cli browser-picks` lists the chips waiting in an agent's message box, in the order they will be sent. `--remove` takes one off, as the chip's X does:

```bash
# Each chip's id, kind, label, url, note, block, and whether it has a screenshot
maestro-cli browser-picks --json

# The chip id from the list, or the pickId browser-pick returned
maestro-cli browser-picks --remove <pickId>
```

Both forms act on the AI tab that a new pick lands in (the active AI tab, or the AI pane of the tiled group on screen). Chips on the agent's other AI tabs are not listed and cannot be removed. In the list, `text` is the block without the note, because the note is its own field, and `screenshot` is `true` or `false`; the image itself is not returned. Without `--agent`, `browser-pick` and `browser-picks` use the agent that is selected in Maestro. See the [CLI reference](./cli-reference) for every flag.

## Privacy and safety

- Design Mode only reads the element you pick. It adds nothing to your message box until you press **Add to Message**, and nothing reaches the agent until you send the message yourself or press **Queue**, which sends that one pick as its own message.
- The page cannot start a pick or put text into your message. Picks come only from your own clicks and key presses on Maestro's overlay, never from anything the page does.
- Design Mode is not available in the web interface, where browser tabs open in your own browser.
