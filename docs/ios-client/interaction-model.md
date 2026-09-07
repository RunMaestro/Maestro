---
type: specification
title: Interaction Model
created: 2026-08-14
tags:
  - ios
  - voice
  - acappella
related:
  - '[[overview]]'
  - '[[audio-session]]'
  - '[[protocol-conformance]]'
  - '[[../architecture/acappella/wake-and-hotkeys]]'
---

# Interaction Model

One screen. A wheel at the top, a button in the middle, a transcript you pull up from the bottom.
Everything else is a sheet reached from a corner.

```
 +--------------------------------------------------+
 |  (( Direct ))  3 bars          Pedram's Mac   ... |   status strip
 +--------------------------------------------------+
 |                                                  |
 |   < [ Conductor ] [ backend ] [ docs ] [ api ] >  |   project wheel
 |                                                  |
 |                                                  |
 |                  +----------+                    |
 |                  |          |                    |
 |                  |   TALK   |                    |   push-to-talk
 |                  |          |                    |
 |                  +----------+                    |
 |                                                  |
 |            "open a tab on the backend"           |   live partial
 |                                                  |
 +--------------------------------------------------+
 |  ^  Transcript                                    |   drag up for the sheet
 +--------------------------------------------------+
```

## The push-to-talk button

The single control that matters. It supports **both** gestures, and which one happened is decided
by how long the finger was down, against exactly the threshold the desktop uses.

```
touchDown
   |
   +-- send `floor: press` IMMEDIATELY (do not wait to classify)
   |   haptic: .impact(.medium)
   |
   +-- start a timer at holdThresholdMs (default 300 ms, clamped 100 to 2000)
   |
touchUp before threshold  ->  TAP: the floor stays open. The button is now latched.
                              A second tap sends `floor: release`.
touchUp after threshold   ->  HOLD: send `floor: release` on the lift.
                              haptic: .impact(.light)
```

Requirements, each earned:

- **Send `press` on touch-down, not on classification.** Waiting 300 ms to find out whether this
  is a tap or a hold puts 300 ms in front of every utterance, and the desktop's `press` is
  idempotent, so there is nothing to be gained by waiting. The classification only decides what
  happens on the lift.
- **Use the desktop's threshold.** It arrives with the voice settings; do not carry a second
  constant. `DEFAULT_HOLD_THRESHOLD_MS = 300` in `src/shared/acappella/voice-controls.ts` is the
  default, `resolveHoldThresholdMs()` is the clamp. A phone that classifies at 250 ms while the
  desktop hotkey classifies at 300 ms produces two devices that disagree about what a tap is.
- **Cancel on drag-off.** A finger that slides off the button before lifting sends `floor: release`
  and shows the cancelled state. A push-to-talk button you cannot back out of is a button people
  are afraid to press.
- **The button reflects `floor-state`, not the local gesture.** The gesture is a request. The
  authoritative state arrives as `{ type: 'floor-state', holder, isSelf, takenOverBy }`, and the
  button renders that. If another device takes the floor, the button snaps back with
  `takenOverBy` shown ("Taken by Pedram's iPad"), because a button that lies about holding a
  microphone is worse than one that flickers.
- **Never assume the floor across a reconnect.** Start closed, wait for `floor-state`.

### Button states

| State         | Appearance                              | Reached by                                        |
| ------------- | --------------------------------------- | ------------------------------------------------- |
| Idle          | Outline, "Talk"                         | Floor closed                                      |
| Pressed       | Filled, growing ring, level meter       | `floor-state.isSelf === true`                     |
| Latched (tap) | Filled with a lock glyph, "Tap to stop" | Tap classified, floor still open                  |
| Held by other | Dimmed, "Pedram's iPad is talking"      | `floor-state.holder != null && !isSelf`           |
| Thinking      | Pulsing, no meter                       | `dispatch` seen, no `speak-start` yet             |
| Speaking      | Waveform, "Tap to interrupt"            | Between `speak-start` and `speak-end`             |
| Interrupted   | Outline, brief flash                    | System audio interruption (see [[audio-session]]) |
| Disconnected  | Greyed, not tappable, reason underneath | Peer or signaling down                            |

Tapping during **Speaking** sends `interrupt: barge-in`, not a floor press. That is the one
overloaded gesture in the app and it is worth it: reaching for a separate stop button while
something is talking at you is exactly when a user cannot aim.

## Haptics

Haptics are the app's only feedback channel when the screen is off or in a pocket, so they are
specified rather than decorative:

| Moment                               | Feedback                                           |
| ------------------------------------ | -------------------------------------------------- |
| Floor opens (any cause)              | `UIImpactFeedbackGenerator(style: .medium)`        |
| Floor closes (any cause)             | `UIImpactFeedbackGenerator(style: .light)`         |
| Floor taken by another device        | `UINotificationFeedbackGenerator(.warning)`        |
| Wake word fired                      | `.medium`, identical to a press, because it is one |
| Stop word fired                      | `UINotificationFeedbackGenerator(.success)`        |
| Barge-in accepted (`barge-in` event) | `UISelectionFeedbackGenerator`                     |
| Session error                        | `UINotificationFeedbackGenerator(.error)`          |
| Roster changed                       | Nothing. Background state changes must not buzz.   |

Prepare the generators ahead of the gesture (`prepare()` on touch-down) or the first haptic of a
session arrives late enough to feel like a different event.

## The project wheel

A horizontally scrolling row of agents, driven **entirely** by the `agent-roster` voice event:

```ts
{ type: 'agent-roster', agents: RosterAgent[] }
// RosterAgent: { sessionId, name, agentType, cwd, tabs, status?, recentWork? }
```

Rules:

- **The first item is always Conductor**, which is not an agent. Selecting it sets the scope of
  the next floor press to `{ kind: 'conductor' }`, which lets the desktop route the utterance
  itself. Every other item sets `{ kind: 'agent', sessionId }`.
- **The roster is a snapshot, not a diff.** Replace the list on every `agent-roster` event. Do not
  merge; the desktop sends a whole roster precisely so the phone cannot accumulate agents that no
  longer exist.
- **`status` colours the item** using the same vocabulary as the desktop Left Bar: `idle` green,
  `busy` yellow, `error` red. Absent means unknown, which renders neutral rather than green.
- **`recentWork` is the subtitle.** It is the synopsis the desktop's history manager already wrote,
  and it is what makes the wheel scannable when four agents have similar names.
- **Selection is a client-side preference only.** It changes the `scope` on the next `floor: press`
  and nothing else. It does not tell the desktop to focus anything, and it does not survive a
  roster that no longer contains the selection: fall back to Conductor and say so.
- **`tab-state` events update the selected agent's tab count** in the item's accessory. A phone
  that shows tab state is a phone that can answer "did it actually open the tab" without the user
  walking to the desk.

Scrolling snaps to items. Selecting one is a single tap, with `UISelectionFeedbackGenerator`.

## The live transcript sheet

A `UISheetPresentationController` with detents `[.height(120), .medium(), .large()]`, presented
non-modally so the talk button stays reachable at the small detent.

Content, in arrival order, built from voice events:

| Event                | Row                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `partial-transcript` | Replaces the in-flight user row. Lossy channel: rows may skip, never reorder. Key off `seq`.                    |
| `final-transcript`   | Commits the user row.                                                                                           |
| `route-decision`     | A quiet caption on the user row: "-> backend agent". Includes the confidence when the desktop was unsure.       |
| `dispatch`           | A caption: "Opened tab: auth refactor".                                                                         |
| `route-correction`   | Rewrites the caption in place, with a corrected marker. Do not append a second row; the user said one sentence. |
| `agent-reply`        | Starts the assistant row.                                                                                       |
| `speak-sentence`     | Appends to the assistant row, sentence by sentence, so the text tracks the audio.                               |
| `speak-end`          | Closes the assistant row.                                                                                       |
| `barge-in`           | Marks the assistant row truncated. Do not delete what was already said.                                         |
| `stop-word`          | A divider. The conversation is over.                                                                            |
| `session-error`      | An inline error row with the desktop's own message, verbatim.                                                   |

Requirements:

- **The desktop's text is the truth.** Never re-render a transcript from local audio, and never
  "clean up" the desktop's copy.
- **Order by `seq`, not by arrival.** Two channels means the reliable and lossy streams interleave,
  and a partial can arrive after the final that superseded it.
- **The transcript is per-session and not persisted.** A conversation history that lives on the
  phone is a second brain, and this app does not have one. See [[overview]].
- **Copy is available, sharing is not.** Long-press copies a row. There is no export, no cloud
  sync, no attachment sheet.

## The status strip

Three elements, left to right:

1. **The connection quality indicator**, exactly as specified in [[connection-and-pairing]]: bars
   plus a path word (Direct, Direct via NAT, Relayed, Connecting).
2. **The desktop name and fingerprint**, tappable to show the paired-device sheet with the four
   characters to compare.
3. **A microphone-state pill**, which is the honesty control for the two capture gates in
   [[audio-session]]. It has three states and each says something different:
   - "Mic off" - nothing is capturing.
   - "Listening for wake word" - a local-only tap is running; nothing is transmitted.
   - "Sending" - the floor is open and audio is going to the desktop.

That third element is not optional. iOS lights an orange indicator whenever any capture is
running, including the local wake-word tap, and a user who sees it with nothing on screen
explaining why will assume the worst thing.

## Wake word and stop word

Both run **on the phone**, for the reasons in [[../architecture/acappella/wake-and-hotkeys]] and
[[overview]]: the wake word cannot be detected remotely without sending the audio it is meant to
gate, and the stop word must be heard while the desktop is speaking.

Behaviour:

- A wake-word hit is exactly a `floor: press` with the currently selected scope, plus the same
  haptic a physical press produces. From the desktop's point of view there is no difference, and
  there must not be one.
- A stop-word hit sends `interrupt: { kind: 'stop-word' }`. The floor closes and the session ends.
- **Barge-in and stop word are different things and stay different.** Barge-in means "stop talking,
  I am still here": speech cancelled, floor kept, microphone open. Stop word means "we are done":
  speech cancelled, floor released, microphone closed. Every assistant that merged them became one
  you cannot get rid of.
- Arming follows the desktop's rule: wake phrases only while the session is cold, stop phrases in
  every active state, never both. Otherwise a wake phrase spoken mid-answer stacks a second
  session.
- Wake word is **off by default** and its toggle sits on the main screen, one tap away. It is the
  setting most likely to be turned off in a meeting.

## Accessibility

- The talk button is a single large target well past the 44 pt minimum, and it is the only control
  needed to use the app.
- VoiceOver: the button announces its state, not its label ("Talk, idle", "Talk, sending",
  "Talk, held by Pedram's iPad"). The transcript sheet is a standard list and reads normally.
- Every state distinguished by colour is also distinguished by a word or a glyph. The agent status
  dots pair with the status word in the item's accessibility label.
- Dynamic Type is honoured everywhere except the talk button's own label.
- Reduce Motion removes the pulsing and waveform animations; the states stay distinguishable by
  fill and label.
