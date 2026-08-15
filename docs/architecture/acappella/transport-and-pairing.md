---
type: architecture
title: A Cappella Transport and Pairing
created: 2026-08-15
tags:
  - voice
  - architecture
  - acappella
  - webrtc
  - pairing
related:
  - '[[system-overview]]'
  - '[[adr-001-webrtc-transport]]'
  - '[[voice-session-protocol]]'
---

# A Cappella Transport and Pairing

How a phone becomes a microphone and a speaker for a desktop that is somewhere else, and what
that costs on each kind of network.

The design in one sentence: **the phone carries audio and nothing else.** One STT, one TTS, one
router, all still in the main process, so whatever provider you picked on the desktop is exactly
what you hear on the walk. A remote utterance is not a second pipeline; it is the same pipeline
with a different microphone attached.

## The parts

| Piece                    | Where it lives                                                      | What it owns                                                   |
| ------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| Pairing service          | `src/main/acappella/pairing/pairing-service.ts`                     | Codes, desktop approval, hashed device tokens, revocation      |
| Discovery                | `src/main/acappella/pairing/discovery.ts`                           | The Bonjour `_maestro._tcp` advert, and its off switch         |
| Signaling                | `src/main/acappella/transport/signaling.ts`                         | Offer/answer/ICE over the existing authenticated WebSocket     |
| ICE configuration        | `src/main/acappella/transport/ice-config.ts`                        | STUN, TURN, candidate classification, the reach statement      |
| Remote session semantics | `src/main/acappella/transport/remote-session.ts`                    | One floor, takeover, clean teardown on connection loss         |
| Peer connection          | `src/renderer/acappella-audio/peer-connection.ts`                   | `RTCPeerConnection`, Opus tuning, data channels, `getStats()`  |
| Data-channel protocol    | `src/shared/acappella/device-protocol.ts`                           | Version handshake, message shapes, reliable/unreliable routing |
| Device management UI     | `src/renderer/components/Settings/ACappella/PairedDevicesPanel.tsx` | QR code, approval, device list, revoke, TURN, Test Connection  |

The peer terminates in the hidden audio window from Phase 02, because that window already owns
the `AudioContext`: a remote track has to meet the local microphone somewhere, and this is the
only place both exist. Electron ships Chromium's libwebrtc, so the desktop needs no new native
dependency for any of it.

## The connection matrix

Three paths, tried in this order, and honestly labelled everywhere they are shown:

| Path                    | Candidate type | Infrastructure needed                | Typical latency added  | Works on                                 |
| ----------------------- | -------------- | ------------------------------------ | ---------------------- | ---------------------------------------- |
| Host (LAN)              | `lan`          | None                                 | Under 5 ms             | Same WiFi, same wire                     |
| Host (overlay)          | `lan`          | Tailscale/ZeroTier                   | Overlay's own latency  | Anywhere the overlay reaches             |
| Server reflexive (STUN) | `stun`         | A STUN server                        | None (media is direct) | Most home NATs                           |
| Relayed (TURN)          | `relay`        | **A TURN server you run or pay for** | One extra hop          | Cellular, hotel WiFi, corporate networks |

**The overlay row is the interesting one.** A Tailscale-style network hands both machines a
routable address for each other, so the connection is a plain host candidate and it connects
instantly, from anywhere, with no STUN, no TURN, and no port forwarding. If you already run one,
this is the whole answer and everything below it is a fallback. The pairing QR code carries every
local address the desktop has, overlay addresses included, so a phone that is on the overlay but
not on the WiFi still connects directly.

### TURN is not optional for cellular

A phone on a mobile network sits behind carrier-grade NAT. CGNAT shares one public address across
thousands of subscribers and does not support the endpoint-independent mapping that hole punching
needs. No amount of STUN gets through it. If you want voice to work while walking down the street
on LTE, **you need a TURN server**, somebody has to run it, and somebody has to pay for the
bandwidth every second of audio goes through it.

Settings states this as a fact rather than hiding it behind a warning triangle, and the Test
Connection button proves it either way: a `relay` candidate can only be gathered by successfully
authenticating to a TURN server, so its presence is evidence rather than configuration.

### The Cloudflare quick tunnel cannot carry this

`src/main/tunnel-manager.ts` runs a Cloudflare quick tunnel so the browser interface is reachable
from outside your network. **It cannot carry the voice audio.** It is an HTTPS reverse proxy and
terminates TCP at Cloudflare; the media leg is a direct UDP association between two peers, chosen
by ICE. The two are separate paths that happen to be used by the same feature:

- **Signaling** (offer, answer, ICE candidates) is WebSocket traffic on `/$TOKEN/ws`, so it goes
  through the tunnel perfectly well.
- **Media** never touches the tunnel. It is LAN, STUN-punched, or relayed through TURN.

So "the tunnel is up" tells you nothing about whether audio will flow, and a tunnel URL is not a
substitute for a TURN server. This is written into the settings copy (`TUNNEL_MEDIA_NOTE`) because
a user who does not know it will blame the wrong component every time.

## Pairing

```
Device                          Desktop
  |                                |
  |  scans QR / enters code        |  startPairing() -> 6-char code, 2 min TTL
  |------ pair-claim ------------->|  claim() consumes the code, creates a request
  |<----- pair-pending ------------|
  |                                |  *** a human clicks Approve, looking at the
  |                                |      name and platform of the thing asking ***
  |------ pair-poll -------------->|  approve() mints a 32-byte token,
  |<----- pair-approved -----------|  persists ONLY its salted SHA-256
  |                                |
  |------ auth (deviceId, token) ->|  authenticate() -> signaling session
  |<----- authenticated -----------|  (ICE servers, negotiated protocol version)
  |------ offer ------------------>|  rate limited, 6 per minute, sliding window
  |<----- answer ------------------|
  |<===== ICE candidates =========>|
  |<~~~~~ audio + data channels ~~>|
```

Four properties this flow is arranged around:

1. **Knowing the code is not enough.** A code is short enough to read over a shoulder, so it buys
   a row in a dialog and nothing else. Pairing completes only on an affirmative action on the
   desktop.
2. **The window is short and one-shot.** Two minutes, and the code is spent by the FIRST claim
   whether or not the human approves - a denied request must not leave a live code behind for
   whoever was watching.
3. **The token is never stored in plain text.** `userData/acappella/devices.json` holds a salted
   SHA-256. A stolen file discloses device names, which is the smallest disclosure that still lets
   a returning device authenticate with no server involved.
4. **Revocation is immediate.** `revoke()` fires an event before the disk write completes; the
   signaling service turns that into a torn-down peer connection and a closed voice session. A
   revocation that only applied at the next connect would be useless in the one situation anybody
   ever uses it.

The QR payload carries the host candidates, the port, the server token, the pairing code, and a
fingerprint derived from the server token. The fingerprint is shown on both screens so a user can
compare four characters and notice a man in the middle.

### Discovery

The desktop advertises `_maestro._tcp` over Bonjour so a device on the same network finds it
without anybody typing an address. Three things about it:

- It is a convenience, never the connection. The QR code carries the addresses directly, and
  manual host entry always works.
- It is off-switchable, and the switch is real: broadcasting a machine name and a port to every
  device on a network is a disclosure some people do not want to make.
- It carries no secret. The TXT record holds the app version, the protocol version, the machine
  name, and the pairing fingerprint. Never the token and never a pairing code - an advert is
  readable by everything on the network.

The mDNS responder is loaded optionally (`bonjour-service` if present). When it is absent the
advert reports `unavailable` with the sentence that says so, rather than failing silently.

## The data channels

Two, because the two kinds of message have opposite failure preferences:

| Channel           | Config                         | Carries                                                                               |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| `acappella-state` | ordered, reliable              | Agent roster, tab state, route decisions, dispatches, errors, floor state, revocation |
| `acappella-live`  | unordered, `maxRetransmits: 0` | Audio level, partial transcripts, push-to-talk press/release, barge-in, link quality  |

Session events travel as `{ type: 'voice-event', event }` - a Phase 01 `VoiceEvent`, unchanged.
There is deliberately no parallel vocabulary: the phone reads the same object graph the desktop
renderer and the CLI read. Only the things a peer connection genuinely adds (the version
handshake, floor control, link quality) are new message types.

Push-to-talk rides the lossy channel with the rest of the gesture traffic. A dropped RELEASE
cannot leave a hot microphone: the floor's idle timeout closes it, the next press is idempotent,
and the desktop re-sends the floor state it observes.

Version negotiation happens at `auth`, before the credential is even checked, and a mismatch is
refused with a sentence naming which end has to update. An old client that half works is worse
than one that will not connect.

## Remote session semantics

- **One floor, last press wins.** A device that presses talk takes the floor from whoever had it,
  and the displaced device is told immediately so its button snaps back. Every device here was
  individually approved by the person doing the pressing; the alternative rule ends with a user
  pressing talk on the phone in their hand and nothing happening because a laptop in another room
  holds the floor.
- **A stale release cannot close a live floor.** Only the current holder's release does anything.
- **The path is identical.** A remote press drives the same `FloorController` the desktop hotkey
  drives, and opens an ordinary session whose only difference is `VoiceOrigin`. The origin exists
  so the desktop HUD can name the device that is listening, not so anything can branch on it.
- **A dropped connection ends the session cleanly.** Speech is cancelled first (the chunks are
  already queued in the audio host), then the session closes. An ICE `disconnected` is NOT that
  trigger: it is what a WiFi-to-LTE handover looks like, and hanging up there would hang up on
  every user this transport exists for.
- **Wake word and stop word stay local to whichever device is capturing.** No audio leaves a
  device before its wake phrase fires. This falls out of the design rather than being enforced:
  the phone's microphone is not sent anywhere until the phone opens the floor.

## Audio configuration

Opus, mono, with in-band FEC and DTX on and a 24 kbps target:

- **FEC** is what makes 5% packet loss sound like nothing instead of like a robot.
- **DTX** stops a phone in a pocket transmitting silence over a metered radio.
- **Mono at 24 kbps** is transparent for speech, and the pipeline downmixes to one channel anyway.

Both the SDP `fmtp` parameters and `RTCRtpSender.setParameters` are set, because either one alone
is routinely ignored depending on which end negotiated what.

**Echo cancellation for the remote path runs on the device, not on the desktop.** The echo happens
in the room the phone is in, and cancelling it requires the phone's own speaker output as the
reference signal - which only the phone has. The desktop asks for it
(`RemoteAudioConfig.requestRemoteEchoCancellation`) and applies its own AEC to its own microphone,
where it works. Any claim that the desktop cancels the phone's echo would be false.

## Acceptance: what to check by hand

The suites in `src/__tests__/main/acappella/` and
`src/__tests__/renderer/acappella-audio/peer-connection.test.ts` run in jsdom with a mocked
`RTCPeerConnection` and no network. They cannot prove audio flows. These steps can:

- [ ] Pair a second machine over LAN with the QR code, approve it on the desktop, hold its
      push-to-talk, and speak. The desktop routes and dispatches identically to a local utterance
      and the reply is audible on the remote device in the configured voice.
- [ ] Record the candidate type the device list shows. On the same network it must say
      `Direct (LAN or overlay)`.
- [ ] Repeat over a Tailscale-style overlay with the desktop off the device's WiFi. Still
      `Direct (LAN or overlay)`, because an overlay address is a host candidate.
- [ ] With a TURN server configured, repeat over cellular. The device list must say
      `Relayed (TURN)`, and Test Connection must report a relay candidate.
- [ ] Walk from WiFi to cellular mid-conversation. The peer renegotiates; the session survives.
- [ ] Revoke the device mid-conversation. The connection drops immediately, the session ends, and
      no speaking state or open floor is left behind.
- [ ] Two devices: press talk on the second while the first holds the floor. The first shows the
      takeover and its microphone closes; the second is heard.

## Related

- [[system-overview]] - where the phone sits in the client model.
- [[adr-001-webrtc-transport]] - why WebRTC rather than Opus frames over the WebSocket.
- [[voice-session-protocol]] - the event vocabulary the data channel carries unchanged.
