---
type: specification
title: Connection and Pairing
created: 2026-08-14
tags:
  - ios
  - voice
  - acappella
related:
  - '[[overview]]'
  - '[[protocol-conformance]]'
  - '[[audio-session]]'
  - '[[../architecture/acappella/transport-and-pairing]]'
---

# Connection and Pairing

The desktop side of everything here is specified in
[[../architecture/acappella/transport-and-pairing]] and implemented in
`src/main/acappella/pairing/pairing-service.ts` and
`src/main/acappella/transport/signaling.ts`. This document is the client half.

## The security model the client must not undermine

Four properties the desktop enforces. The client's job is to never work around any of them, and
to explain them honestly when they bite:

1. **Knowing the pairing code is not enough.** A code is a pointer to a request, not an
   authorisation. Pairing completes only when a human presses Approve on the desktop, looking at
   the name and platform this app reported. There is no client-side path that skips that, and the
   app must not imply there is.
2. **The window is short and one-shot.** A code lives 120 seconds and is consumed by the first
   claim, approved or denied. Expiry is normal, not an error state to apologise for: show
   "Ask the desktop for a new code" and a countdown.
3. **The token is never recoverable from the desktop.** The desktop stores only a salted SHA-256.
   If the phone loses its Keychain item, the only path back is a fresh pairing. Never build a
   "recover my token" flow, because the desktop cannot serve one.
4. **Revocation is immediate.** A `revoked` message on the data channel, or an `auth-failed` on
   the signaling socket, is final. The client must delete its Keychain item and return to the
   unpaired state on either. Retrying a revoked token is the one thing that turns a clean
   revocation into a support ticket.

## Transport summary

| Leg       | Carries                                   | Where                                       |
| --------- | ----------------------------------------- | ------------------------------------------- |
| Signaling | Pairing, auth, SDP, ICE candidates        | `ws://<host>:<port>/<serverToken>/ws`       |
| Media     | Opus, both directions                     | WebRTC peer connection                      |
| State     | Roster, tabs, floor, errors, revocation   | `RTCDataChannel` labelled `acappella-state` |
| Realtime  | Levels, partials, press/release, barge-in | `RTCDataChannel` labelled `acappella-live`  |

Every signaling frame is a JSON object `{ "type": "acappella_signal", "payload": <op> }`. The
`payload` shapes are `SignalingClientMessage` and `SignalingServerMessage` in
`src/main/acappella/transport/signaling.ts`; they are enumerated exhaustively in
[[protocol-conformance]].

## Finding a desktop

Three paths, in the order the UI should offer them.

### 1. QR code (the primary path)

The desktop's Settings panel (Encore Features -> A Cappella -> Paired Devices) renders a QR code.
Its payload is a JSON object:

```json
{
	"kind": "maestro-acappella",
	"v": 1,
	"hosts": ["192.168.1.42", "100.83.11.9"],
	"port": 17173,
	"token": "<server token>",
	"code": "K7QMBX",
	"expiresAt": 1786820745000,
	"fingerprint": "9F3A"
}
```

Client requirements:

- **Reject anything whose `kind` is not `maestro-acappella`.** A QR scanner that tries to make
  sense of an arbitrary payload is an attack surface.
- **Reject a `v` this build does not implement**, with the sentence "This Maestro is newer than
  this app. Update the app." Do not attempt a best-effort parse.
- **Treat `expiresAt` as authoritative.** A payload already past it must not be sent to the
  desktop; say the code expired and ask for a new one.
- **Try every entry in `hosts`, in order, in parallel, and take the first socket that opens.**
  `hosts` is ordered with the desktop's primary interface first, and it can contain overlay
  addresses (Tailscale allocates from `100.64.0.0/10`) that work from anywhere. A phone that only
  tries `hosts[0]` fails on any Mac with more than one interface, which is most of them.
- **Show the `fingerprint` on the phone** after connecting, next to the same four characters shown
  on the desktop. It is derived from the server token, so a matching pair means the phone is
  talking to the machine whose screen the user is looking at. This is the only man-in-the-middle
  check the user has; do not hide it behind a details view.

Camera permission uses `NSCameraUsageDescription`: "Maestro scans the pairing code shown on your
computer. The camera is used only for that scan." The scan is `AVCaptureMetadataOutput` with
`.qr`, no image is written to disk, and no photo library access is requested.

### 2. Bonjour LAN discovery

The desktop advertises `_maestro._tcp` when discovery is enabled. Browse with `NWBrowser`
(`NWBrowser.Descriptor.bonjourWithTXTRecord(type: "_maestro._tcp", domain: nil)`) so the TXT
record arrives with the result.

TXT keys, all public by construction:

| Key           | Meaning                                                     |
| ------------- | ----------------------------------------------------------- |
| `version`     | Maestro app version                                         |
| `proto`       | A Cappella device protocol version                          |
| `fingerprint` | Pairing fingerprint, for the same four-character comparison |
| `host`        | Human name of the desktop                                   |

Client requirements:

- **Discovery never carries a credential.** There is no token and no pairing code in the TXT
  record. A discovered desktop still needs a code typed or scanned, and the UI must make that
  obvious rather than implying a discovered machine is a paired one.
- **Grey out, do not hide, a discovered desktop whose `proto` this build cannot speak**, with the
  version sentence from [[protocol-conformance]].
- Requires `NSLocalNetworkUsageDescription` and an `NSBonjourServices` array containing
  `_maestro._tcp` in `Info.plist`. Without the latter the browse silently returns nothing on iOS
  14 and later, which reads as "my Mac is not discoverable" and sends users to the wrong problem.
- **An empty browse is not an error.** The desktop may have discovery switched off deliberately,
  or mDNS may be unavailable. Fall through to manual entry with "Cannot see your Mac? Enter its
  address" rather than a failure dialog.

### 3. Manual host entry

Always available, never buried. Host and port, with the port defaulting to the value the desktop
shows in its manual-entry hint. This path also covers the reverse-proxy and VPN cases that
discovery cannot reach.

The server token still has to come from somewhere. On this path the user types the pairing code
and the desktop's URL including the token segment, which is what the desktop's manual hint
displays verbatim.

## The pairing exchange

```
phone                                     desktop
  |-- {op:'pair-claim', code, name,          |
  |    platform:'ios', appVersion} --------->|  code checked, consumed, request created
  |<- {op:'pair-pending', requestId,         |  human sees an Approve/Deny row
  |    expiresAt} --------------------------|
  |                                          |
  |-- {op:'pair-poll', requestId} ---------->|  (poll until resolved or expiresAt)
  |<- {op:'pair-approved', deviceId, token} -|  32-byte token, minted once
  |     or {op:'pair-denied'}                |
  |     or {op:'pair-rejected', reason,      |
  |         message}                         |
```

- `platform` must be the literal `ios`. It is displayed verbatim in the desktop's device list and
  in the approval row, so a human decides against something recognisable.
- `name` defaults to `UIDevice.current.name` and must be user-editable before the claim is sent.
- Poll on a 1 second interval, and stop at `expiresAt` rather than polling forever.
- `pair-approved` is the **only** time the token exists in the clear. Write it to the Keychain
  before updating any UI state; a crash between "token received" and "token stored" leaves an
  approved device that can never authenticate, and there is no recovery path.
- `pair-rejected` carries a `message` written for a human. Show it verbatim. Do not paraphrase and
  do not append a generic "Try again".

## Storing the token

```swift
// Keychain item, one per paired desktop.
kSecClass:            kSecClassGenericPassword
kSecAttrService:      "sh.maestro.acappella.device"
kSecAttrAccount:      deviceId              // from pair-approved
kSecAttrAccessible:   kSecAttrAccessibleAfterFirstUnlock
kSecAttrSynchronizable: false
kSecValueData:        token                 // UTF-8
```

Requirements, each with a reason:

- **`kSecAttrAccessibleAfterFirstUnlock`, not `WhenUnlocked`.** The app has to reconnect from the
  background with the screen locked (see [[background-and-entitlements]]), and `WhenUnlocked`
  makes the token unreadable in exactly that state.
- **Never `ThisDeviceOnly` plus iCloud sync.** Synchronizable is off outright: a device token
  identifies one physical device to one desktop, and syncing it to an iPad produces two devices
  claiming one identity, which the desktop will treat as a stolen credential.
- **The server token and host list are stored alongside it**, in the same Keychain item's generic
  attribute or a second item. They are not secrets of the same weight, but the server token is
  still a credential and does not belong in `UserDefaults`.
- **Delete on revocation, delete on `auth-failed`, delete on user "Forget this Mac".** Three
  paths, one function.

## Authenticating and connecting

```
  |-- {op:'auth', deviceId, token, protocolVersion} --->|
  |<- {op:'authenticated', deviceId, protocolVersion,   |
  |    iceServers, iceTransportPolicy, audio} ----------|
  |     or {op:'auth-failed', reason, message}          |
  |                                                      |
  |-- {op:'offer', sdp} ------------------------------->|  rate limited: 6 per 60s
  |<- {op:'answer', sdp} -------------------------------|
  |<=== {op:'ice-candidate'} both directions ==========>|
```

- **Version is negotiated at `auth`, before the credential is even checked.** An old client is
  told to update the app; a client from the future is told to update the desktop. Handling is
  specified in [[protocol-conformance]].
- **Use the `iceServers` and `iceTransportPolicy` the desktop sent.** Do not carry a hard-coded
  STUN server in the app. The desktop's settings are the single source of truth, including a
  `relay`-only policy for a user who does not want their IP addresses exchanged.
- **Apply the `audio` config** (`fec`, `dtx`, `maxAverageBitrate`, `requestRemoteEchoCancellation`)
  to the outgoing Opus encoder. See [[audio-session]] for how each maps onto WebRTC.framework.
- **Five failed `auth` attempts closes the socket.** Do not retry in a tight loop. One attempt per
  reconnect, with backoff between reconnects.
- **Offers are limited to 6 per 60 seconds.** That budget is sized for an initial offer plus
  renegotiation on network changes. A client that rebuilds its peer connection on every ICE
  hiccup will exhaust it and be rate limited during exactly the handover it was trying to survive.

## Reconnection

The rules, in order of how often they matter:

| Event                                               | Client behaviour                                                                                                                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RTCPeerConnectionState.disconnected`               | **Do nothing for 5 seconds.** This is what an ordinary WiFi-to-LTE handover looks like, and tearing down here is how you break the case you were trying to handle. Show "Reconnecting" in the quality indicator, keep the UI live. |
| Still `disconnected` after 5s, or `failed`          | Restart ICE and send a fresh `offer` on the same authenticated socket. The desktop applies it to the existing peer, so the media leg survives.                                                                                     |
| Signaling socket closed                             | Reconnect the socket with backoff, re-`auth`, then re-`offer`. The desktop never inherits an authenticated state across sockets, so `auth` is mandatory every time.                                                                |
| `closed`, or the desktop sent `revoked`             | Terminal. Do not reconnect.                                                                                                                                                                                                        |
| `auth-failed`                                       | Terminal. Delete the Keychain item and go to the unpaired state.                                                                                                                                                                   |
| App backgrounded without the Push to Talk framework | Expect the connection to die. Reconnect on foreground; see [[background-and-entitlements]].                                                                                                                                        |

Backoff: 1s, 2s, 4s, 8s, 15s, 30s, then 30s steady, each with up to 30 percent jitter. Reset the
schedule on any successful `authenticated`. Never reconnect while the app is in the background
without an active Push to Talk session; a phone in a pocket retrying every 30 seconds all night is
a battery complaint and a one-star review.

**The floor does not survive a reconnect.** On reconnect the client's mic button starts closed and
waits for a `floor-state` message. Assuming the floor is still held is how a phone ends up with a
hot microphone the desktop does not know about.

## The connection quality indicator

Driven by `link-quality` messages on the lossy channel, which both ends emit from throttled
`getStats()` readings:

```ts
{ type: 'link-quality', rttMs: number | null, jitterMs: number | null,
  packetLoss: number, candidateType: 'lan' | 'stun' | 'relay' | 'unknown' }
```

The indicator has two halves, and both are needed:

**Quality**, from `rttMs`, `jitterMs`, and `packetLoss`:

| Bars | Condition                                      |
| ---- | ---------------------------------------------- |
| 3    | rtt < 80 ms, jitter < 20 ms, loss < 2 percent  |
| 2    | rtt < 200 ms, jitter < 50 ms, loss < 5 percent |
| 1    | connected, anything worse                      |
| 0    | not connected                                  |

**Path**, from `candidateType`, shown as a word, not a colour:

| Value     | Label              | What it means to the user                                                  |
| --------- | ------------------ | -------------------------------------------------------------------------- |
| `lan`     | "Direct"           | Host candidate. Same network or an overlay. No infrastructure in the path. |
| `stun`    | "Direct (via NAT)" | Both ends punched through. Media is still peer to peer.                    |
| `relay`   | "Relayed"          | A TURN server is forwarding every packet. Works everywhere, costs latency. |
| `unknown` | "Connecting"       | No candidate pair selected yet.                                            |

Showing the path in words is deliberate. "Why is it slow" and "where does my audio go" are the
same question for a relayed connection, and a user who can see the word "Relayed" can answer it
without a support thread.

The client emits its own `link-quality` at most once per 2 seconds. It is throttled at the sender
because it rides the lossy channel alongside the audio meter, and a chatty stats message competes
with the thing the user actually hears.
