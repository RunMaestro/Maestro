---
type: specification
title: A Cappella iOS Client Overview
created: 2026-08-14
tags:
  - ios
  - voice
  - acappella
related:
  - '[[../architecture/acappella/system-overview]]'
  - '[[connection-and-pairing]]'
  - '[[audio-session]]'
  - '[[interaction-model]]'
  - '[[background-and-entitlements]]'
  - '[[app-store-review]]'
  - '[[protocol-conformance]]'
  - '[[project-structure]]'
---

# A Cappella iOS Client Overview

## What this app is

**A remote microphone and speaker for a Maestro desktop.** Nothing more, and the "nothing more"
is the load-bearing part of the design.

The phone captures audio, sends it to a paired desktop over WebRTC, and plays back what the
desktop sends home. Every decision about that audio - which speech recogniser transcribes it,
which agent it is routed to, what tab gets opened, which voice reads the answer - is made on the
desktop by the code described in [[../architecture/acappella/system-overview]]. The phone
contributes exactly three things the desktop cannot do for itself: a microphone in another room,
a speaker in that same room, and a screen to press.

## What this app is not

It is **not a second brain**. It does not:

- run a speech recogniser, a router, or a text-to-speech engine;
- hold its own conversation state, its own transcript history, or its own agent list;
- talk to Anthropic, OpenAI, ElevenLabs, or any other provider directly;
- work at all without a paired desktop that is awake and running Maestro.

If the phone ever needs to make a decision the desktop already makes, that is a bug in this
specification, not a feature request for the phone. Two implementations of routing will disagree,
and the one the user is not looking at will be the one that is wrong.

There are exactly **three** exceptions, and each exists because latency or privacy makes a round
trip to the desktop unacceptable. They are specified in detail in [[protocol-conformance]]:

| Local behaviour | Why it cannot live on the desktop                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wake word       | No audio may leave the device before the wake phrase fires. Detecting it remotely would require sending audio first, which is the thing the rule forbids.            |
| Stop word       | It must be heard while the desktop is speaking and a recogniser stream is open. A stop that arrives after the thing it was meant to stop has finished is not a stop. |
| VAD ducking     | Barge-in has to attenuate playback within roughly 20 ms. A round trip to the desktop is 30 to 120 ms before the desktop has even decided anything.                   |

Everything else the phone does is: press a button, draw what the data channel says, play what the
audio track carries.

## The shape of a session

```
  iPhone                              Maestro desktop
    |                                        |
    | user presses talk (or says wake word)  |
    |------ floor: press -------------------->  FloorController.press()
    |                                        |  same object the desktop hotkey drives
    |<----- floor-state: isSelf=true ---------
    |                                        |
    |======= Opus audio, phone -> desktop ===>  STT, routing, dispatch
    |                                        |
    |<----- voice-event: partial-transcript --  (lossy channel)
    |<----- voice-event: route-decision ------
    |<----- voice-event: dispatch ------------
    |<====== Opus audio, desktop -> phone ====  TTS
    |<----- voice-event: speak-sentence ------
    |                                        |
    | user talks over the reply              |
    |------ interrupt: barge-in ------------->  session.interrupt()
    |<----- voice-event: barge-in ------------  authoritative, speech actually cancelled
```

The phone never invents a `voice-event`. It **requests** (`floor`, `interrupt`) and it
**renders** (`voice-event`, `floor-state`). Requests are hopeful; events are the truth.

## Why WebRTC and not a WebSocket

Decided in [[../architecture/acappella/decisions/adr-001-webrtc-transport]] and restated here
because it is the first question any iOS developer will ask:

- **Opus with in-band FEC and DTX** survives the loss profile of a phone on cellular. A raw PCM
  stream over a WebSocket does not, and a phone leaving WiFi mid-sentence is the normal case, not
  the edge case.
- **The audio path is peer to peer** when the network allows it, so a phone on the same LAN as the
  desktop pays no server hop at all. See the `lan`/`stun`/`relay` distinction in
  [[connection-and-pairing]].
- **`AVAudioSession` in `.voiceChat` mode** gives us Apple's hardware voice-processing echo
  canceller for free, and that mode is designed around a duplex real-time call. See
  [[audio-session]].
- **Renegotiation is a first-class path.** A phone walking from WiFi to LTE re-offers on the same
  authenticated socket and the media leg survives the handover. A WebSocket audio stream would be
  torn down and rebuilt, mid-sentence.

Signaling still rides Maestro's existing authenticated WebSocket, so there is no second port and
no second authentication surface.

## Reading order

| Document                        | Answers                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| [[connection-and-pairing]]      | How the phone finds a desktop, earns a token, keeps it, and reconnects. |
| [[audio-session]]               | How to configure `AVAudioSession` and WebRTC so the audio is usable.    |
| [[interaction-model]]           | What is on screen and what every gesture does.                          |
| [[background-and-entitlements]] | How the app keeps a microphone alive when the screen is off.            |
| [[app-store-review]]            | How to get an app that is useless without a paired Mac through review.  |
| [[protocol-conformance]]        | Exactly what to send and handle, checkable item by item.                |
| [[project-structure]]           | Xcode layout, dependencies, signing, and the non-goal list.             |

## The reference client

Before any Swift exists, there is a browser reference client at
`src/web-desktop/acappella-client/` that speaks this identical protocol. It is not a demo. It is
the second endpoint the desktop is regression-tested against, and it is the executable answer to
"what does the wire actually look like" for anyone writing the Swift. When this specification and
the reference client disagree, the reference client is right and this document has a bug.
