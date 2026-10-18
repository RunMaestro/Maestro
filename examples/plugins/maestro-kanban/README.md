# Kanban Board

A live Kanban board plugin for Maestro. Every open AI tab is a card, cards drag between columns, a switcher moves between one project's board and a Global board of every project, and clicking a card jumps Maestro to that tab. Open a card and you get a description, a comment thread, a recent-History excerpt, and a message box that sends straight into that card's tab.

The board is not a to-do list you maintain alongside your work. It is a view of the work: the cards are the AI tabs you already have open, so a board with nothing on it means you have nothing open, and a card you cannot find means its tab is closed.

Three ways in, all of them the same `open` command:

- the keybinding **Alt+Shift+K**,
- the command palette entry **Kanban: Open Board**,
- the **Kanban Board** button in the Left Bar's action row.

Escape backs out one surface at a time rather than closing everything at once: a live drag first (cancelling the drag, not the panel), then the Clear Done confirmation, then a plan row's editor, then the aging, conductor and plan surfaces, then a card's detail pane, then the archive or activity view. Only when none of those is up does Escape close the panel.

## A card is one AI tab

A card's identity is the pair `sessionId::tabId`: the agent the tab belongs to, and the tab. That has consequences worth knowing before you use the board:

- **One agent with three AI tabs is three cards**, each with its own column, description, comments and message box. The board is tab-granular because that is the unit you actually work in.
- **Terminal tabs are never cards.** Only AI tabs become cards.
- **A hidden tab is never a card.** Maestro's cross-agent consult tabs are hidden from the tab strip, and the host drops them from the tab list a plugin can see, so they cannot become cards either.
- **Closing a tab removes its card** on the next refresh. The card's description and comments stay in the plugin's storage, keyed by the card key, so re-opening a tab with the same id brings them back; a genuinely new tab is a new card with an empty thread.
- **A card with no project folder cannot be moved.** There is nothing to key a placement under, so the move would survive until the next refresh and then snap back. The board refuses it and says so, rather than pretending.
- A card's title is its tab's name, falling back to a generated label. Its status dot is the tab's live status: green ready, yellow busy, red error, orange connecting.

Where a card sits is remembered per board in the plugin's own storage, not re-derived from tab status on every refresh. Live status only decides where a card lands the very first time it appears: `error` to Blocked, `busy` or `connecting` to In Progress, everything else to Backlog. After that, the card is wherever you put it. **Kanban: Clear Card Placements** throws all of that away and starts over.

## Columns and the board files

Columns are yours. They live in two plain YAML files under `~/.maestro/`, and the plugin reads and writes nothing else on the filesystem.

| File                                   | What it defines                                                          |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `~/.maestro/kanban.yaml`               | The Global board's columns.                                              |
| `~/.maestro/kanban-boards/<slug>.yaml` | One project's columns, where `<slug>` is `<folder-name>-<8 hex digits>`. |

The slug hashes the project's full absolute path, so two checkouts that share a folder name still get different files. Both files are safe to hand-edit; the plugin writes a header comment saying so. When a project has no board file, the board falls back to the built-in ladder: Backlog, In Progress, Review, Blocked, Done (terminal). The panel offers to write that default out as a real file for the project you are looking at, and refuses if anything is already at the path.

### A project board

```yaml
# ~/.maestro/kanban-boards/maestro-79ad7dab.yaml (the slug for the project below)
# Maestro-managed kanban board. Safe to hand-edit; keep the shape above.
version: 1

# Required on a project board, and it has to be the project's absolute path.
# A file whose `project` does not match the path it was read from is reported
# as an error rather than used, so a copied board file cannot silently take
# over another project.
project: /Users/you/Projects/maestro

columns:
  # `id` is what placements are stored against: renaming an id moves every
  # card that was sitting on it. `title` is only what you read.
  - id: backlog
    title: Inbox
    # `maps_to` names a column in ~/.maestro/kanban.yaml. It is the ONLY way
    # this column reaches the Global board (see below).
    maps_to: waiting
  - id: in-progress
    title: Doing
    maps_to: active
    # Advisory only. The column header shows the count against the limit and
    # marks itself over limit; no drop is ever refused for it.
    wip_limit: 3
  - id: review
    title: Review
    maps_to: active
  - id: done
    title: Done
    maps_to: shipped
    # The terminal column: the one Done aging measures, Clear Done empties,
    # and retirement retires from. Exactly one per board. With no `terminal`
    # flag anywhere, a column with the id `done` is used, and failing that
    # the last column in the file.
    terminal: true
```

### The Global board

```yaml
# ~/.maestro/kanban.yaml
# Maestro-managed kanban board. Safe to hand-edit; keep the shape above.
version: 1

# No `project` key here. The global board belongs to no project, and a
# `project` key in this file is an error rather than an ignored extra.
columns:
  - id: waiting
    title: Waiting
  - id: active
    title: Active
    wip_limit: 8
  - id: shipped
    title: Shipped
    terminal: true
```

The parser is a deliberately strict subset, hand-written because the plugin sandbox has no `require` and therefore no YAML library. It accepts `version` (required integer), `project` (required on a project board, forbidden on the global one), and `columns` (required, non-empty). A column accepts `id`, `title` (both required), `maps_to`, `terminal`, and `wip_limit`, and nothing else. Unknown keys, duplicate keys, duplicate column ids, nested maps, anchors and aliases are all errors that name the offending line. A file that does not parse is reported in a banner on the board, never silently replaced with defaults, and the plugin refuses to write over a file it could not read.

### Column mapping and drop legality

On a **project board**, a card may be dropped on any column that project's board declares. That is the whole rule. A card whose stored column no longer exists (you renamed an id by hand) renders in the first column rather than disappearing.

On the **Global board**, a card belongs to its home project and the only thing stored is still its home-project placement, so a global move has to be translated back. Three rules hold that together:

1. **A project column reaches a global column through `maps_to` and nothing else.** A matching id is not a mapping. That is deliberate: the built-in default columns carry no `maps_to`, so honoring id matches would quietly aggregate every project that has no board file.
2. **A card may only be dropped on a global column its own project can reach.** Every other column is dimmed while you drag, and a post that arrives anyway is refused by name.
3. **A card the projection cannot place sits in a read-only `Unmapped` lane** and can be dragged nowhere. That covers all three ways it happens: the card's project has no board file, its column has no (or an orphaned) `maps_to`, or its stored column is no longer one its project declares. The lane only appears when something is in it.

When a project points several columns at one global column, a drop keeps the card where it already is if its current column maps to the target (dropping a card on the global column it is already in is a reorder, not a relocation), and otherwise takes the project's first mapping. The forced choice is written to the plugin log.

Within a column, cards you have positioned stay in that position, as a block. Cards nobody has dragged sort above them by last activity, newest first, so a tab that just appeared is at the top rather than buried.

## The access model

The board shows you everything and can act on almost nothing until you say so.

- **The board can message, and read History of, only the agents Maestro has granted to it:** the conductor it created, and any agent you approved in Maestro's one-time confirmation.
- **Every other card is still shown, moved, described, and commented on**, but carries a "Not connected" marker until you choose **Allow Access** or send it a first message.
- **Grants are stored by Maestro, not the plugin.** They persist across restarts, and they are revoked per agent in Settings under the plugin's permissions, after which the card returns to "Not connected".
- **Fully auto mode never asks for access on your behalf.** A planned message to an agent you have not approved is kept and waits for you.
- **The plugin reads and writes files only under `~/.maestro/kanban*`, never inside a project.**

In practice: open a card you have not approved and the History excerpt and message box are replaced by one line saying Kanban Board needs your OK before it can message this agent or read its History, plus an Allow Access button. Clicking it, or just typing a message and pressing Send, raises Maestro's own confirmation naming the plugin, the agent and its project. Approve it and the pane switches to the normal excerpt and composer, and a message that was waiting is sent. Decline and the message stays where you typed it, marked as access not granted, with a Retry that asks again. Revoke the grant later and the next send or History read is denied by the host; the board recognizes that specific denial, drops the agent, and the card goes back to "Not connected" rather than showing an error.

Nothing in this plugin can skip, redraw or pre-answer that confirmation. The ladder of host gates behind it is spelled out under [Trust: everything that has to be true](#trust-everything-that-has-to-be-true) below.

## The History excerpt, and why it is agent-level

Open a card's detail pane and it shows **Recent History**: at most 8 entries, each with a summary, a timestamp, a type and whether it succeeded. It is read once per open pane, cached for 20 seconds, and re-read when that agent finishes a turn (`agent.completed` / `run.completed`), never on a timer. The plugin reads it for the one card whose pane is open, never for every card on the board, because the host rate-limits and audits every transcript read.

**The excerpt is per agent, not per tab, and that is a property of Maestro rather than a shortcut here.** History is recorded and stored per agent, one file per agent, and `transcripts.read` takes a session id with no way to filter by tab. The host will not even project a `tabId` field onto what it returns. So two cards that are two tabs of the same agent show the same excerpt, and an excerpt line may describe a turn that ran in the other tab. The pane labels it "Recent History" rather than "this tab's transcript" for exactly that reason.

It is also History, not a live transcript: finished turns as Maestro recorded them, not the streaming output of the turn running right now. For that, click the card and read the tab.

## The conductor

A board can have one conductor: an agent the plugin creates, for that board, whose job is to read the board and propose a plan. It is created only when you ask for one, from the board's Conductor settings, and never for any other reason.

- It runs in its own scratch folder, `~/.maestro/kanban-conductor/<slug>` (or `.../global` for the Global board), with a README in it saying what the folder is for. That folder is its working directory, so it is not sitting in any project of yours.
- It is titled `Conductor: <board name>` and appears in the Left Bar like any other agent.
- Because the plugin created it, Maestro grants the plugin access to it without asking you: the one-time confirmation exists for agents you already had, and this agent exists only because you pressed the button.
- One conductor per board. Asking again when the board already has one does nothing.

### Its reach

A conductor can only see the projects you have already approved. The plugin hands the conductor its board's granted project roots as **read-only added directories**, through Maestro's own agent update, and keeps that in sync: a card appearing or disappearing, a grant approved, a grant found revoked, or a board switch all recompute it (debounced, so a burst of events is one update and one log line).

A project needs only one approved card to be reachable, because an added directory is authorized against the path, not the card. The Conductor settings surface shows both halves explicitly: what this board's conductor would read right now, and which projects are not granted yet, each with an Allow Access button. The displayed lists are capped at 64 entries per side with a hidden count; the reach itself is not capped.

If the provider you picked has no native support for added directories, the surface says so: the conductor still gets the board snapshot in its prompt, but not the files.

### What you own on the conductor agent

The plugin owns three things, per board, in its own settings: the **provider** (only providers you already run an agent for are offered, because a plugin cannot install one for you), an optional **model**, and an optional **effort**.

Everything else belongs to Maestro's own agent settings for that agent, and the plugin deliberately does not touch it: **binary path, CLI args, environment variables, SSH remote, and Claude token mode.** Open the conductor from the board (there is a button) and configure it the way you configure any agent.

## Plans

With a conductor in place, **Ask Conductor** sends it the board as a prompt and waits. The prompt names the board, the clock, every column with its flags, and every card with its key, title, agent, project, current column, status, last activity, description, up to three recent comments, up to four History lines (granted cards only, at most eight cards read per plan), the exact columns that card may move to, and whether messaging it is granted yet. It is budgeted: cards that do not fit are dropped with a line telling the conductor it is looking at part of the board, because a model planning confidently around cards it was never shown is worse than a model told it cannot see them.

The rules the prompt states, which the plugin then re-derives rather than trusting:

- A plan can do exactly two things to a card: move it to another column, and send its agent one message.
- At most one move and one message per card. A second entry for the same card is rejected.
- A card may only move to a column that card may move to. Every other column is rejected, including a column that exists on another project's board.
- No creating cards and no creating agents. A card exists because a person opened an AI tab.
- A message to an agent whose access is not granted is kept, not discarded, and waits for a person.
- At most `wipCap` cards may be acted on in one execution. Anything past the cap is held as pending rather than run, so a plan longer than the cap is not an error.
- A halted board executes nothing, so an empty plan is the only useful answer.

### The plan file contract

The conductor's reply is not the plan. **The plan is a file**, and it is the only thing the board reads:

```
<conductor working directory>/plans/<planId>.json
```

`planId` is generated by the plugin for that one request (`plan-<base36 time>-<base36 random>`) and is matched against `^[a-z0-9][a-z0-9-]{0,63}$` before any path is built from it, so a plan id can never be a way to reach a file outside the plans folder.

The file is one JSON object, either bare or in exactly one fenced code block (several blocks is a rejection, not a guess):

```json
{
	"version": 1,
	"planId": "plan-m1n2o3-4p5q6r",
	"rationale": "one short paragraph, for the person reading this plan",
	"moves": [
		{
			"cardKey": "<a key from the prompt>",
			"toColumnId": "<a column that card may move to>",
			"why": "one sentence"
		}
	],
	"messages": [
		{
			"cardKey": "<a key from the prompt>",
			"prompt": "<what to send that agent>",
			"why": "one sentence"
		}
	]
}
```

- `version` must be `1`. `planId` must be exactly the id that was asked for; any other id is read as the answer to a different request and discarded.
- **No other top-level keys.** A key the contract does not list makes the whole plan unreadable, which is what makes `rationale` and `why` safe: they are shown to a person and never executed.
- `moves` and `messages` may both be empty. An empty plan is a valid answer.
- A `cardKey` must be one of the keys from the prompt, copied exactly. An invented key is rejected with the key quoted back.
- Limits, all of them refusals rather than silent truncations of meaning: 256 KiB of file, 100 entries per list, 4000 characters per message prompt. `rationale` (2000) and `why` (400) are display text and are clipped rather than rejected.
- Every message prompt is sent verbatim to that agent, in that card's own tab, as if you had typed it.

A plan that does not parse is shown to you with the reason and the first 2000 characters of what the conductor actually wrote, so you can see the thing that failed. Entries that parse but cannot be accepted are listed individually with their reason, beside the entries that can.

A run settles when the conductor's turn finishes, or after 15 minutes, whichever comes first. A conductor that finishes without writing a file says exactly that. One plan in flight per board.

### Plan and approve, versus fully auto

**Plan and approve** is the default and the safe one. The plan arrives as a diff: one row per move and per message, each with its reason, each with a checkbox. You can edit a message's text before approving it, reject the lot, or approve a subset. Nothing happens to a card until you do.

**Fully auto** is the identical pipeline with the person removed from the middle: a plan that parses is decided and executed immediately. It is not a different code path, and it is not unguarded. What still holds in fully auto:

- **The WIP cap.** Default 3, range 1 to 25, per board. The cap is how many distinct cards one execution may act on, so the blast radius of one misread plan is three cards, not the whole board. A card both moved and messaged counts once. Which rows ride past the cap is decided when the plan is read, against the cap in force then, so the rows that execute are exactly the rows you were shown and never a different set derived later.
- **Column legality**, re-derived from the board files at execution time, not read off the plan.
- **The halt.** Halt is a per-board switch that stops every move and every message until you clear it. It is checked before the execution loop and again immediately before each row's own side effect, so a halt flipped mid-execution stops everything from that point on. A row not yet reached is left approved and unexecuted; there is no half-applied move.
- **Access.** A planned message to an agent you have not approved is skipped, recorded as waiting for access, and never sent. Fully auto does not raise the access confirmation for you.
- **One execution per plan id.** Every row already attempted is recorded, so no row is ever executed twice no matter how the run is re-entered.
- **The host's own ceilings** on every message: the risk classifier, the rate cap and the concurrency cap described under Trust below.

A move executes through the same placement path a drag goes through, and a message through the same dispatch path the card composer uses. Nothing in plan execution is a second way to cause either effect.

Everything a plan does, and everything you decided about it, lands in the board's **Activity** feed: plan requests, approvals and rejections, executed moves and messages, access requests, conductor reach changes, retirements, and halts.

## Done aging and the archive

A Done column that only grows stops being information. Aging fades a card that has sat in the terminal column and eventually retires it to an archive file. It is **off by default**, and three rules keep it from ever being a surprise:

1. **It is opt-in, per board.** With it off, every card renders fully opaque and nothing ever expires, however long it has been sitting there. The settings surface still shows you how old your Done cards already are, before you turn anything on.
2. **Only the terminal column ages.** Dragging a card out of Done discards its clock in the same write that moves it; dragging it back in starts a fresh one rather than resuming the old.
3. **Any message or comment on the card restarts the clock.** "Done but still being talked about" is not stale, so the newest of those two timestamps wins over the moment the card entered Done. A failed send does not count.

### The opacity math

With a horizon of `H` days and `E` days elapsed on the clock:

```
progress = clamp(E / H, 0, 1)
```

The model's opacity is `1 - progress * (1 - 0.1)`, a linear ramp from 1.0 down to a floor of **0.1**, rounded to three decimals so the same elapsed time always renders the same value. That number describes how far along the decay a card is; it is not a drawing instruction. A card still on the board is still clickable, still draggable and still has a composer behind it, so the panel re-maps the same ramp onto a readable range:

```
rendered opacity = 1 - progress * (1 - 0.4)
```

from 1.0 down to a floor of **0.4**, which is the faintest the panel's 13px title stays legible at. The ramp still runs across the whole horizon and still ends at its faintest on the last day. A card disappears by being retired, never by fading past legibility. In the last day before the horizon (and for a card already past it that the sweep has not reached yet) the card also gets a distinct marker, because faintness alone is not a warning.

The horizon is in days, between 1 and 365, default 14. A hand-edited stored value outside that range is clamped rather than refused.

### Retirement and the archive file

The retirement sweep runs when the plugin activates and then every 6 hours. Hours, not seconds: the horizon it enforces is measured in days, so a card is retired well within the day it expired while the plugin spends essentially nothing watching the clock. Opening the panel does not sweep, and neither does a refresh.

Retired cards go to one JSON file per board:

| File                                    | Board                                               |
| --------------------------------------- | --------------------------------------------------- |
| `~/.maestro/kanban-archive/global.json` | The Global board.                                   |
| `~/.maestro/kanban-archive/<slug>.json` | One project, under the same slug as its board file. |

A record carries the card key, when it was retired and why, its title, its session and tab ids, its agent and project, the trail of columns it was seen in, its description and its full comment thread. Newest first, capped at 500 records per board, pruned from the oldest on write.

Three properties of the retirement path are worth stating plainly:

- **The archive write comes first and the board edit second.** If the archive cannot be written (an unreadable file the plugin refuses to overwrite), the cards stay exactly where they are and the next sweep tries again. A card is never removed from the board without a record of it having existed.
- **A card is archived under its own project's board**, so retiring from the Global board's view still lands in the right project's file.
- **Retirement does not close your tab.** The archive is what keeps the card off the board; the tab is untouched.

Open the **Archive** view from the board header to read, filter and **Restore** records. Restoring puts the card back with its description and comment thread intact, because the original note was never deleted. You can also retire a single card by hand with **Archive Now** on its detail pane, or empty the whole terminal column with **Clear Done** (which asks first).

### Closing tabs when cards retire

There is one opt-in setting that does reach your tabs: **close a card's tab when it ages out**. It is off by default, and when it is on:

- it closes the real Maestro tab and its transcript, which nothing in this plugin can bring back,
- it never fires for a card you cleared or archived by hand, only for one the horizon retired,
- and it is skipped for a tab that is busy or connecting.

## Capabilities this plugin requests

Every capability below is shown to you at consent, and every one of them is exercised by the code. There is nothing requested "just in case": the audit that keeps it that way is a test (`src/__tests__/plugins/kanban-permissions.test.ts`), which parses `main.js`, collects the host methods it really calls, maps them through the host's own method-to-capability table, and fails in both directions - an unused capability fails, and so does a call the manifest does not cover.

| Capability                                             | Used for                                                                                                                                                                                 | Without it                                                                                                                                                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions:read`                                        | Enumerating agents to label cards with their provider, project and last activity, and to resolve the conductor's own session.                                                            | Cards still build from the tab list, but they lose their agent labels and the board permanently shows its "these cards may be out of date" notice, because a refused read is recorded as staleness rather than hidden. |
| `tabs:manage`                                          | Listing AI tabs and their live status (a card IS a tab), and closing a retired card's tab when you opt into that.                                                                        | No cards at all, and no status dots.                                                                                                                                                                                   |
| `events:subscribe`                                     | Keeping the board live as agents and tabs change.                                                                                                                                        | The board is a snapshot that never updates until you refresh it by hand.                                                                                                                                               |
| `ui:panel`                                             | Drawing the board panel and pushing snapshots to it.                                                                                                                                     | There is no panel to open.                                                                                                                                                                                             |
| `ui:contribute`                                        | The one "Kanban Board" button in the Left Bar's action row.                                                                                                                              | The launcher button is dropped; the keybinding and palette entry still work.                                                                                                                                           |
| `sessions:focus`                                       | Jumping Maestro to the tab behind a clicked card.                                                                                                                                        | Cards open their detail pane but cannot take you to the tab.                                                                                                                                                           |
| `storage:read`, `storage:write`                        | Remembering card placements and positions, descriptions and comments, board settings, plan settings, conductor ids and configuration, the activity feed, and which boards have archives. | Nothing is remembered. Every card falls back to a status-derived column on each start.                                                                                                                                 |
| `notifications:toast`                                  | Surfacing failures, such as a trimmed or failed board update.                                                                                                                            | Failures are logged rather than shown.                                                                                                                                                                                 |
| `agents:read`                                          | Listing the providers you already run agents for, so the conductor picker offers one you can actually pick.                                                                              | The conductor picker cannot offer a provider, and says so rather than claiming you run none.                                                                                                                           |
| `sessions:create`                                      | Creating exactly one conductor agent per board, in its own scratch folder, when you ask for one.                                                                                         | No conductor, so no plans.                                                                                                                                                                                             |
| `sessions:write`                                       | Handing a board's conductor your granted project roots as read-only added directories, and keeping that in sync.                                                                         | A conductor can be created but never sees a project, only the board snapshot in its prompt.                                                                                                                            |
| `fs:read`, `fs:write` on `~/.maestro/kanban.yaml`      | The Global board's columns.                                                                                                                                                              | The Global board falls back to no columns of its own.                                                                                                                                                                  |
| `fs:read`, `fs:write` on `~/.maestro/kanban-boards`    | Per-project columns.                                                                                                                                                                     | Every project board falls back to the built-in default ladder, and custom columns cannot be written.                                                                                                                   |
| `fs:read`, `fs:write` on `~/.maestro/kanban-archive`   | The archive of retired cards.                                                                                                                                                            | Nothing can be retired, because nothing can be recorded.                                                                                                                                                               |
| `fs:read`, `fs:write` on `~/.maestro/kanban-conductor` | The conductor's scratch folder, its README, and reading back plan files.                                                                                                                 | No conductor is created, and a plan could not be read even if one were written.                                                                                                                                        |
| `transcripts:read`, scoped `granted-sessions`          | The recent-History excerpt on an open card, and a few History lines per granted card in a plan prompt.                                                                                   | Cards show no History. Everything else works.                                                                                                                                                                          |
| `agents:dispatch`, scoped `granted-sessions`           | Messages typed on a card, the plan request sent to the conductor, and the messages a plan sends. Also backs `sessions.requestAccess`, which is how you grant a card in the first place.  | The board is read-only: cards still move, but nothing can be messaged and no plan can be asked for.                                                                                                                    |

Deliberately **not** requested: `net:fetch`, `net:connect`, `process:spawn`, `media:tools`, `fs:watch`, `transcripts:write`, `settings:read`, `settings:write`, `ui:command`, `shell:openExternal`, `storage:sql`. The four egress capabilities are not merely unused; holding any of them would be incompatible with `transcripts:read` for an untrusted plugin, which is the trade described next.

## Trust: everything that has to be true

This section is the map of host gates that stand between this plugin and your agents. Nothing here is this plugin's own behavior; it is the host's (`src/shared/plugins/publisher-keys.ts`, `src/main/plugins/plugin-signature.ts`, `src/main/plugins/bundled-plugins.ts`, `src/main/plugins/plugin-host-handlers.ts`).

### Why `granted-sessions`, not an ordinary allow list

Messaging an agent (`agents:dispatch`) and reading its History (`transcripts:read`) are both declared in `plugin.json` with `"scope": "granted-sessions"` rather than a member list. That scope starts with **zero** sessions covered, no matter what you consent to at install time. It only ever covers a session the host itself adds, one at a time, for one of two reasons: **the board created it** (the conductor), or **you approved it** through a one-time, host-drawn confirmation this plugin cannot see, skin, or auto-answer.

Declaring `granted-sessions` also means this plugin can never simultaneously hold `net:fetch`, `net:connect`, `process:spawn` or `media:tools`: the host treats transcript reads and network egress as mutually exclusive for an untrusted plugin (`src/shared/plugins/capability-policy.ts`). `plugin.json` holds none of them, so that trade costs this plugin nothing. A board that reads local YAML and talks to agents you approved has no legitimate reason to reach the network.

### The ladder

For a message (`agents.dispatch`) or a History read (`transcripts.read`) to actually reach an agent, all of this has to hold, in this order:

1. **The plugin is enabled.** A disabled plugin's sandboxed code never runs, so none of the gates below get a chance to deny anything: there is no card, no board, nothing. This is a toggle in Settings, not something the plugin requests.
2. **The plugin is signed with a key that verifies against the baked publisher anchor, or you have separately trusted it.** `verifyPluginSignature()` hashes every file in the plugin directory, confirms that set matches `signature.json` exactly (no added, removed or altered file), verifies the ed25519 signature over that file set, and only then checks the signer's public key against `resolveTrustedKeys()`: the baked-in Maestro publisher key plus whatever keys you have added. Unsigned, tampered or signed by an unrecognized key reads as `unsigned` / `invalid` / `untrusted`, and `assertTrustedActVerb()` refuses every high-power act verb (`agents.dispatch` included) for anything short of `trusted`.
3. **The capability is granted.** `transcripts:read` and `agents:dispatch` each have to be consented to, and the broker has to resolve the `granted-sessions` scope as applying to this call.
4. **Unattended consent was given, separately from the capability grant.** `agents.dispatch` is "never user-present" by the host's own description: on top of the capability, `dispatchUnattendedAllowed(pluginId, agentId)` has to return true. Approving the capability does not imply approving unattended sends.
5. **The target session was created by this plugin, or approved by you.** `isSessionGranted(pluginId, agentId)` has to be true for that exact session id, never an agent name, so renaming an agent cannot retarget a grant.
6. **The message passes the risk ceiling and the rate cap.** `assertLowOrMediumRisk()` refuses a prompt the host's risk classifier flags as high-risk, and `ActionGuard` caps how many dispatches this plugin may make per sliding window and how many may be in flight. A compromised-but-permitted plugin still cannot fire dispatches in a storm.

`transcripts:read` follows steps 1 to 3 and step 5, and has no unattended-consent or risk step of its own: reading History is not sending a prompt.

### What the board does when any of it is not true

- **Steps 1 and 2 (disabled, unsigned, tampered, untrusted):** there is nothing for the board to show, because its code never runs. Maestro's Plugins settings surface the signature and trust state directly. See [Signing, packing, and what a bundled auto-install requires](#signing-packing-and-what-a-bundled-auto-install-requires) for how a copy reaches `trusted` and why a folder install does not.
- **Step 3 or step 4 (capability not granted, or no unattended consent):** the board could never dispatch to any session, so every card renders "Not connected" and the detail pane's access gate permanently replaces the History excerpt and composer. Allow Access itself keeps failing with the host's own text until it is fixed in Settings, which is outside this plugin's reach.
- **Step 5 (session not created by, or approved for, this plugin):** the ordinary, expected state for a card you have not said yes to. See [The access model](#the-access-model).
- **A grant revoked after the fact:** the next dispatch or History read for that session is denied with the same "is not granted to this plugin" message the initial path uses. The board recognizes that specific denial, drops the session from its own in-memory set, clears cached History, and the card returns to the ungranted state, rather than showing a generic error.
- **Step 6, the risk ceiling:** the send fails and the composer shows the host's own refusal text verbatim, with a Retry. Nothing is sent.
- **Step 6, the rate cap:** refused with the host's `rate limit: ...` / `concurrency limit: ...` text, shown the same way. The composer additionally limits itself to one in-flight send per card and one in-flight access request per session, so a double Enter cannot itself trip a host cap.

In every denial above, the text on the card is the host's own message, read out of the rejected call rather than guessed, so what you see names exactly what is missing.

### Signing, packing, and what a bundled auto-install requires

A `trusted` signature is step 2 of the ladder, and it is also the only thing that makes this plugin's code run at all: `isRunnable()` in `src/main/plugins/plugin-manager.ts` requires `signature.status === 'trusted'`, so an unsigned or untrusted copy is still discovered, listed and enable-able, and its three ways in still appear, but its sandbox never starts. Every button in `panel.html` reaches `main.js` through `maestro:invokeCommand`, and `invokeCommand()` returns false with no sandbox behind it, so the board opens with nothing driving it. That is not a read-only board, it is an inert one.

Sign and pack a **copy**, never the checked-in folder. `plugin sign` writes `signature.json` into the directory it signs, and `--gen-key --key-out` writes a private key wherever you point it; neither belongs in the repository:

```bash
npm run build:cli
PKG_TMP="$(mktemp -d)" && cp -R examples/plugins/maestro-kanban "$PKG_TMP/"
node dist/cli/maestro-cli.js plugin sign "$PKG_TMP/maestro-kanban" \
  --gen-key --key-out "$PKG_TMP/dev-key.pem"
node dist/cli/maestro-cli.js plugin validate "$PKG_TMP/maestro-kanban"
node dist/cli/maestro-cli.js plugin pack "$PKG_TMP/maestro-kanban" \
  --out "$PKG_TMP/maestro-kanban.tgz"
```

`sign` hashes the four source files and writes an ed25519 signature over that exact set. `signature.json` itself, and any `*.pem` or `*.key`, are excluded from both signing and packing by the shared policy in `src/shared/plugins/signing.ts`, so a key that ends up inside the plugin folder is never signed into the manifest and never lands in the archive. `validate` then reports `Signature: untrusted` for a throwaway key, which is the expected and correct result: the signature verifies, the signer is simply not a key this build trusts. Pass the public half back with `--trusted-key <base64>` and the same command reports `trusted`, which is how you confirm the signature is good rather than merely present. `pack` writes five files, the four sources plus `signature.json`, because the host verifier needs it to check the bytes after install.

To run a locally signed copy in a real build you also have to make its key trusted, and there is no Settings control for that: add the base64 public key `sign` printed to the `pluginTrustedKeys` array in `<userData>/maestro-settings.json`, then restart. `npm run plugin:dev` copies a folder and does nothing else, so a dev-data install on its own leaves the plugin untrusted and therefore not running.

#### What `bundled-plugins.ts` requires to auto-install this plugin

`seedBundledPlugins()` in `src/main/plugins/bundled-plugins.ts` copies bundled first-party plugins into the user's plugins directory at startup. For this plugin to be one of them, all of the following has to hold. Any one of them failing makes the seeder skip the plugin and log why:

1. **The folder sits at a bundled root.** `bundledPluginsRoot()` looks for `<resources>/plugins` in a packaged app, then `examples/plugins` in a dev checkout. A packaged build only has the first if the build config copies the folder there, and `package.json`'s `extraResources` has no `plugins` entry today, so nothing is bundled yet and this plugin ships as a manual install.
2. **The folder name equals the manifest id** (`maestro-kanban`), and is a safe folder name. A signed bundle whose directory disagrees with its declared id is skipped, so it can never be seeded into a different plugin's directory.
3. **`plugin.json` parses and validates.** An absent or malformed manifest reads as "not a plugin dir" and is passed over.
4. **`verifyPluginSignature()` returns exactly `trusted`.** That means `signature.json` is present, its file set matches the directory byte for byte with nothing added, removed or altered, the ed25519 signature over that set verifies, and the signer's public key is in `resolveTrustedKeys()`: the baked publisher anchor `MAESTRO_PUBLISHER_KEYS` in `src/shared/plugins/publisher-keys.ts`, plus any `pluginTrustedKeys` the user added. `unsigned`, `invalid` and `untrusted` are all skipped. That trust gate is the whole point: it is what stops a bundled plugin from arriving auto-installed but unrunnable.
5. **There is something to install.** The seeder writes when the plugin is absent, when the bundled version is semver-newer than the installed one, or when the installed copy is not itself trusted, so a manual unsigned install of the same id is replaced rather than left in place. Symlinks are never copied, and the swap is staged with a backup so a failed copy cannot destroy a working install.

The private half of the publisher key is a release secret (`MAESTRO_PLUGIN_SIGNING_KEY`) held by no individual, so only a maintainer-tagged release run can produce a signature that anchor trusts. Nothing in this plugin, and nothing in the commands above, changes the anchor.

Seeding is not the last gate either. The `plugins` Encore flag still has to be on for discovery to see the seeded copy, and the enable toggle plus the consent window still apply exactly as they do for a manual install.

## What this plugin does not, and cannot, do

- It cannot sign itself as trusted, add itself to the publisher anchor, or override the enabled, signature or capability gates. Those are host-owned, and nothing in `main.js` or `panel.html` touches them.
- It cannot skip the one-time access confirmation, draw its own version of it, or pre-answer it. That dialog is drawn by the main process, parented to the main window, and defaults to Don't Allow.
- It cannot dispatch to, or read History from, any session by name. Only by the exact session id the host granted.
- It cannot create a card or an agent out of a plan. A card exists because a person opened an AI tab, and the only agent it ever creates is the conductor you asked for.
- It cannot read or write anything in your projects. Its filesystem reach is four locations under `~/.maestro/`, and every path it builds comes from a helper rooted in one of them.
