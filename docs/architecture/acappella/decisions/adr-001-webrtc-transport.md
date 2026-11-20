---
type: decision
title: 'ADR-001: WebRTC for the phone audio leg'
created: 2026-08-14
tags:
  - voice
  - architecture
  - acappella
  - adr
related:
  - '[[system-overview]]'
  - '[[voice-session-protocol]]'
  - '[[adr-002-main-process-session]]'
  - '[[transport-and-pairing]]'
---

# ADR-001: WebRTC for the phone audio leg

**Status:** Accepted
**Date:** 2026-08-14
**Deciders:** A Cappella Phase 01

## Context

A Cappella's iPhone client carries live microphone audio to the desktop and live speech back. The
desktop already runs an authenticated WebSocket at `/$TOKEN/ws`
(`src/main/web-server/routes/wsRoute.ts`) with an established client registry and a broadcast
fan-out (`src/main/web-server/services/broadcastService.ts`). The obvious cheap move is to encode
Opus frames and push them over that socket in both directions.

The obvious cheap move is wrong, and it is worth writing down why so nobody re-proposes it in a
later phase.

## Decision

**The phone's media leg is WebRTC. The existing authenticated WebSocket carries signaling only.**

Signaling (offer, answer, ICE candidates) rides `/$TOKEN/ws`, so the phone leg inherits the token
auth, the client registry, and the connection lifecycle that already exist. Media does not touch
that socket.

Control events from [[voice-session-protocol]] also ride the WebSocket. Only audio moves to the
peer connection.

## Rationale

### Acoustic echo cancellation

This is the decisive reason. The phone plays the assistant's speech through its speaker while its
microphone is open for barge-in. Without echo cancellation the microphone hears the assistant,
the STT transcribes it, and the system talks to itself. Barge-in, the single most important
interaction in the whole feature, becomes impossible.

WebRTC's audio pipeline provides AEC, noise suppression, and automatic gain control as part of
`getUserMedia` plus the peer connection, tuned by people who have spent two decades on it. A raw
WebSocket carrying Opus frames provides none of them. Building AEC by hand is not a weekend
project; it is the reason conferencing products have audio teams.

### Jitter buffer

Networks deliver audio unevenly. WebRTC maintains an adaptive jitter buffer that trades a few
milliseconds of latency for smooth playback and adapts as conditions change. Over a WebSocket we
would write our own, and a hand-rolled fixed buffer is either too small (audible gaps) or too
large (barge-in feels laggy, which reads as the assistant ignoring you).

### Packet loss concealment

Opus over WebRTC conceals lost packets by synthesizing plausible audio for the gap. A lost frame
degrades quality slightly. TCP has no concept of concealment: a lost segment is retransmitted,
and the whole stream **stalls** behind it (head-of-line blocking). On a phone walking between WiFi
and cellular, that turns a small loss into a visible freeze in a conversation.

### UDP versus TCP

WebSockets are TCP. For real-time media, TCP's reliability guarantee is the wrong guarantee: a
retransmitted audio packet that arrives 400 ms late is worthless, and waiting for it delays every
packet behind it. WebRTC uses UDP, where late audio is simply dropped and the conversation keeps
moving. Plus ICE/STUN gives NAT traversal and network-change survival (WiFi to cellular) that a
plain socket would need re-connect logic to approximate.

## Alternatives considered

### WebSocket plus Opus frames

Rejected. Cheapest to build, and it fails on all four axes above. The critical failure is AEC:
without it, open-mic barge-in cannot work at all, and barge-in is not optional in this design
(see [[voice-session-protocol]], "Invariants").

### Native iOS audio session with a custom UDP protocol

Rejected. This is re-implementing WebRTC with fewer eyes on it, and it forfeits the browser-based
fallback client entirely.

### Push to talk only, half duplex, over the existing socket

Rejected as the architecture, though it remains a usable **mode**. Half duplex sidesteps echo by
never having the microphone open during playback, which makes a WebSocket viable. But it removes
barge-in, and barge-in is the difference between talking to a system and waiting for one. Half
duplex can ship as a low-bandwidth fallback on top of the WebRTC design; the reverse (adding full
duplex to a WebSocket design later) means rebuilding the transport.

## Consequences

**Positive**

- Barge-in works with the speaker on, which is the whole interaction model.
- Network changes and packet loss degrade gracefully instead of freezing.
- The browser gets the same client for free, so a laptop can be a voice client too.
- Signaling reuses the existing authenticated socket, so there is no second auth surface.

**Negative**

- More moving parts: ICE, STUN, and possibly TURN for hostile networks. The desktop needs a
  WebRTC peer implementation in the main process, which is a real dependency rather than a few
  lines of `ws`.
- Local network discovery and certificate handling need design work in the phone phase.
- Debugging is harder: media that does not flow has more possible causes than a socket that is
  closed.

**Neutral**

- The [[voice-session-protocol]] event stream is unaffected. It was designed transport-agnostic
  precisely so this decision could be made independently, and so a client with no media leg at all
  (the desktop dev harness) is still a first-class client.

## Related

- [[system-overview]] - where the phone sits in the client model.
- [[voice-session-protocol]] - the control-plane events that ride the WebSocket.
- [[adr-002-main-process-session]] - why there is a session in main for the phone to be a peer of.
- [[transport-and-pairing]] - how the decision was actually built: pairing, signaling, ICE, TURN,
  and the connection matrix.
