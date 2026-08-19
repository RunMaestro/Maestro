---
type: decision
title: 'ADR-002: The voice session is headless in the main process'
created: 2026-08-14
tags:
  - voice
  - architecture
  - acappella
  - adr
related:
  - '[[system-overview]]'
  - '[[voice-session-protocol]]'
  - '[[adr-001-webrtc-transport]]'
---

# ADR-002: The voice session is headless in the main process

**Status:** Accepted
**Date:** 2026-08-14
**Deciders:** A Cappella Phase 01

## Context

A voice session owns a state machine, a monotonic event sequence, three providers, and a dispatch
path into agents and tabs. It has to live somewhere.

The renderer is the tempting home. Maestro already does Web Speech dictation there
(`src/renderer/hooks/utils/useVoiceInput.ts`), the microphone and speaker are trivially reachable
from a renderer, `MediaStream` and `AudioWorklet` are browser APIs, and all the state stores are
already there. Building it in the renderer would be faster in Phase 01.

## Decision

**`VoiceSessionService` lives in `src/main/acappella/`, is headless, and is transport-agnostic.**
It may not reference a `BrowserWindow`, a React store, or the DOM. Every UI, on every device, is a
client of [[voice-session-protocol]].

## Rationale

### The iPhone is a peer, not a port

This is the reason that outranks the others. If the session lives in the renderer, the phone
either talks to the renderer (making one window a server for a physical device, which breaks the
moment that window closes or Maestro goes multi-window) or gets a second, parallel session
implementation in main. A second implementation means two state machines that drift, two routing
paths, two barge-in semantics, and two sets of bugs.

With the session in main, the phone and the desktop HUD are the same kind of thing: subscribers to
one event stream, senders of the same three commands. Adding a client is adding a transport
adapter, not a feature.

### Renderer lifetime is not session lifetime

A renderer can be reloaded, hidden, closed, or moved between windows. Maestro is already
multi-window, and windows own subsets of agents. A voice session that dies because the user closed
the window it happened to start in is broken by construction, and one that has to be handed
between windows is worse. Conversations are longer-lived than views.

### Dispatch authority already lives in main

Routing a decision into agents and tabs needs the roster, and main already holds it: the sessions
store (`src/main/stores/getters.ts`, read the same way `registerSessionCallbacks` reads it) plus
the `remote:*` bridge the web server uses to ask the renderer to act
(`src/main/web-server/callbacks/tabCallbacks.ts`). A renderer-owned session would either duplicate
that or reach back into main for every step anyway.

Note the asymmetry this creates and accepts: main holds the roster but has **no** tab authority.
Tab state lives in the renderer, so `executeRouteDecision()` sends `remote:newTab` /
`remote:selectTab` / `remote:renameTab` and waits for confirmation, exactly as the web path does.
Main is the decider; the renderer stays the executor.

### Providers are Node-shaped

Local Whisper and Kokoro are native modules or child processes. Cloud realtime sessions want a
long-lived socket with a secret key. A renderer has neither native module access nor a safe place
for keys, so provider work would end up proxied through IPC in every case. Putting the session
where the providers already have to run removes a whole layer of marshalling from the hot path,
which is latency the user hears.

### Precedent

Every comparable Maestro subsystem is already main-owned and renderer-projected: the Cue engine,
the web server, Pianola's supervised loop, the plugin broker. Cadenza's HUD window
(`src/main/app-lifecycle/cadenza-hud-window.ts`) is the closest visual analogue, and even it is a
main-created window that buffers payloads until the renderer signals ready. Voice would be the
odd one out.

## Alternatives considered

### Session in the renderer, main as a thin relay

Rejected. Fastest to Phase 01 and worst for Phases 02 onward: it forces a second implementation
for the phone, ties session lifetime to a window, and puts provider secrets and native modules on
the wrong side of the bridge.

### Session in a dedicated hidden `BrowserWindow`

Considered seriously. A hidden renderer would give the session `MediaStream`, `AudioWorklet`, and
`RTCPeerConnection` for free, which is genuinely attractive given [[adr-001-webrtc-transport]].

Rejected because it trades one problem for a worse one: a hidden window is still a renderer with a
lifecycle, a crash surface, and IPC latency between it and the dispatch authority, and it makes
"who owns the session" ambiguous again. It also cannot be reached from the CLI or a headless
context.

The capability gap is real but narrow, and it is solvable with a Node WebRTC implementation in
main. If that turns out to be untenable, the fallback is a hidden window acting as a **media
endpoint only**, still driven by the main-process session, not a relocation of the session itself.

### Session in a separate process

Rejected as premature. It would add IPC to the dispatch path and process supervision to the
lifecycle for isolation nobody has asked for. Revisit only if a provider proves unstable enough to
threaten app stability.

## Consequences

**Positive**

- One session implementation for every client, forever.
- Sessions survive window reload, window close, and multi-window moves.
- Providers sit next to their native modules and secrets.
- The service is trivially testable: no DOM, no React, no Electron window. Feed it `startSession`
  and `submitUtterance`, assert on the event stream.

**Negative**

- Audio device access in main needs deliberate work. The renderer's easy `getUserMedia` path is
  not available, so Phase 01 ships mock providers and the real capture path is a later phase's
  problem.
- WebRTC in main requires a Node implementation rather than the browser's built-in one.
- Every UI interaction costs an IPC hop. Acceptable: the events are small and infrequent compared
  to the audio itself, which never crosses this boundary.

**Neutral**

- The renderer keeps `useVoiceInput.ts` for composer dictation until the local STT tier lands.
  Two voice paths coexist briefly, with a clear owner for each.

## Related

- [[system-overview]] - the service, the tiers, and the client model.
- [[voice-session-protocol]] - the contract every client speaks.
- [[adr-001-webrtc-transport]] - the transport this decision makes possible.
