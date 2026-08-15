---
type: specification
title: Protocol Conformance
created: 2026-08-14
tags:
  - ios
  - voice
  - acappella
related:
  - '[[overview]]'
  - '[[connection-and-pairing]]'
  - '[[interaction-model]]'
  - '[[audio-session]]'
  - '[[background-and-entitlements]]'
  - '[[project-structure]]'
  - '[[../architecture/acappella/voice-session-protocol]]'
  - '[[../architecture/acappella/transport-and-pairing]]'
---

# Protocol Conformance

This is the contract. [[connection-and-pairing]] says how a phone finds a desktop and
[[interaction-model]] says what the screen does; this file says exactly what goes on the wire, in
what order, and what a client must do with every frame it receives.

Everything here was read out of the implementation rather than designed alongside it. The source of
truth, in the order a message meets it:

| Layer                      | File                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| WebSocket envelope         | `src/main/web-server/handlers/messageHandlers/acappellaSignal.ts` |
| Signaling messages         | `src/shared/acappella/signaling-protocol.ts`                      |
| Signaling behaviour        | `src/main/acappella/transport/signaling.ts`                       |
| Data-channel messages      | `src/shared/acappella/device-protocol.ts`                         |
| Session events             | `src/shared/acappella/protocol.ts`                                |
| Peer and channel behaviour | `src/renderer/acappella-audio/peer-connection.ts`                 |
| SDP tuning and link stats  | `src/shared/acappella/peer-tuning.ts`                             |
| Floor rules                | `src/main/acappella/transport/remote-session.ts`                  |

**If this document and those files disagree, the files win and this document is a bug.** The
conformance suite at `src/__tests__/acappella/conformance/` exists to make that disagreement fail in
CI rather than at App Store review, and every checklist item at the end of this file carries an ID
the suite can name.

**There is also a working client.** `src/web-desktop/acappella-client/` is a browser implementation
of this entire document: it pairs, authenticates, offers, opens both data channels, holds the floor,
and speaks every message defined below, in about 1,700 lines of framework-free TypeScript. Where this
document says what a client must do, that client is the runnable version, and where a comment there
cites a `C-nn` it is implementing the checklist item of that name. Read it alongside this file; the
desktop is served it at `/$TOKEN/acappella`.

## The two layers

```
  phone                                                     desktop
    |                                                          |
    |  1. WebSocket  wss://host:port/$TOKEN/ws                  |
    |     {type:'acappella_signal', payload:{op:...}}           |  pairing, auth, SDP, ICE
    |<-------------------------------------------------------->|
    |                                                          |
    |  2. WebRTC peer connection                                |
    |     audio track (Opus)                                    |  the microphone
    |     'acappella-state'  reliable, ordered                  |  roster, floor, events
    |     'acappella-live'   unreliable, unordered              |  meter, partials, gestures
    |<========================================================>|
```

Layer 1 exists to build layer 2 and then to tear it down. Once the peer is up, nothing that matters
to the user travels over the WebSocket: a phone whose socket dropped but whose peer is healthy keeps
working, and that is deliberate.

---

## 1. Signaling messages

### Envelope

Every signaling frame is a WebSocket text frame carrying the app's ordinary client-message shape:

```json
{ "type": "acappella_signal", "payload": { "op": "..." } }
```

`payload` is one `SignalingClientMessage` outbound, one `SignalingServerMessage` inbound. There is no
second port, no second token, and no separate handshake: the URL's `$TOKEN` is the server token from
the QR payload, and clearing it is what gets a frame looked at in the first place.

A client that sends `acappella_signal` while A Cappella is switched off on the desktop receives
`{op:'error', code:'not-authenticated', message:'A Cappella is not running on this desktop. Turn it
on in Encore Features.'}`. Show that sentence. It is the difference between a feature that is off and
a network that ate the frame, and only one of those is worth retrying.

### Client to desktop

| `op`            | Payload                                                                            | Precondition              |
| --------------- | ---------------------------------------------------------------------------------- | ------------------------- |
| `pair-claim`    | `{ code: string, name: string, platform: string, appVersion?: string }`            | Unpaired only             |
| `pair-poll`     | `{ requestId: string }`                                                            | After `pair-pending`      |
| `auth`          | `{ deviceId: string, token: string, protocolVersion: number }`                     | Have a stored token       |
| `offer`         | `{ sdp: { type: 'offer', sdp: string } }`                                          | **After `authenticated`** |
| `ice-candidate` | `{ candidate: { candidate: string, sdpMid?, sdpMLineIndex?, usernameFragment? } }` | **After `authenticated`** |
| `bye`           | `{}`                                                                               | Any time                  |

What the desktop's parser actually does with a malformed frame, because a client that relies on
coercion will break the day the parser tightens:

- `pair-claim` without a string `code` is dropped as `malformed`. A non-string `name` or `platform`
  is **silently coerced to the empty string**, which produces a nameless row in the approval sheet.
  Send both, always, and send `platform` as the literal `ios`.
- `auth` without a string `deviceId` **and** a string `token` is dropped as `malformed`.
- `auth` whose `protocolVersion` is not a number is treated as version 0, which fails negotiation
  with `client-too-old`. Absent is not "unversioned"; it is "too old".
- `offer` is accepted only when `sdp` is an object with a string `sdp` field. The `type` is forced to
  `offer` regardless of what was sent, so a client cannot smuggle an answer through the offer path.
- `ice-candidate` requires a string `candidate`. The three optional fields default to `null` when
  they are the wrong type, which is why an end-of-candidates marker must be sent as an empty-string
  `candidate` rather than as a null one.
- Anything else, including an unknown `op`, produces one
  `{op:'error', code:'malformed', message:'Unrecognised signaling message.'}` and no state change.

### Desktop to client

| `op`            | Payload                                                                                  | Meaning                                     |
| --------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| `pair-pending`  | `{ requestId: string, expiresAt: number }`                                               | A human is being asked                      |
| `pair-approved` | `{ deviceId: string, token: string }`                                                    | The only time the token exists in the clear |
| `pair-denied`   | `{}`                                                                                     | A human said no                             |
| `pair-rejected` | `{ reason: string, message: string }`                                                    | Bad, used, busy, or expired code            |
| `authenticated` | `{ deviceId, protocolVersion, iceServers, iceTransportPolicy: 'all' \| 'relay', audio }` | Signaling session open                      |
| `auth-failed`   | `{ reason: 'unauthorized', message: string }`                                            | Unknown, wrong, or revoked                  |
| `answer`        | `{ sdp: { type: 'answer', sdp: string } }`                                               | Apply as the remote description             |
| `ice-candidate` | `{ candidate: IceCandidatePayload }`                                                     | Trickled from the desktop                   |
| `closed`        | `{ reason: string }`                                                                     | This signaling session is over              |
| `error`         | `{ code: SignalingErrorCode, message: string }`                                          | See below                                   |

`audio` is a `RemoteAudioConfig`:
`{ fec: boolean, dtx: boolean, maxAverageBitrate: number, requestRemoteEchoCancellation: boolean }`,
defaulting to `{ true, true, 24000, true }`. Apply it to the outgoing encoder; see [[audio-session]].

Three shapes that catch every first implementation:

1. **`pair-pending` in response to a `pair-poll` carries `expiresAt: 0`.** Only the first
   `pair-pending`, the one answering `pair-claim`, carries the real deadline. Keep that value; do not
   overwrite it from a poll response, or the pairing screen's countdown jumps to 1970.
2. **`auth-failed` is deliberately vague.** Unknown device, wrong token, and revoked device all
   produce `reason: 'unauthorized'` with one sentence. Do not try to tell them apart; the desktop is
   refusing to be an enumeration oracle. Every one of them is terminal for the stored token.
3. **A version failure is an `error`, not an `auth-failed`.** See section 3.

### Error codes

| `code`              | When                                                     | Client behaviour                                                 |
| ------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| `not-authenticated` | `offer` or `ice-candidate` before `authenticated`        | Bug. Fix the ordering; never retry blind.                        |
| `rate-limited`      | 7th offer in 60 s, or a 6th `auth` attempt on one socket | Stop. Back off. For auth, open a **new socket** before retrying. |
| `protocol-version`  | `auth` with an unusable `protocolVersion`                | Terminal. Show the message verbatim. See section 3.              |
| `malformed`         | Unparseable frame                                        | Bug. Log it with the frame; do not retry the same bytes.         |
| `peer-failed`       | The desktop's peer connection failed                     | Tear down the peer, restart ICE, re-`offer` under the backoff.   |

### Ordering and limits

- **`offer` and `ice-candidate` are refused until `auth` has succeeded on THIS socket.** An
  authenticated state is never inherited across sockets. Reconnect means `auth` again, every time.
- **Offers: 6 per 60 seconds, sliding window.** Sized for an initial offer plus a renegotiation per
  network change. A client that rebuilds its peer on every ICE hiccup exhausts the budget during
  exactly the handover it was trying to survive.
- **Failed auths: 5 per socket.** The 6th and every one after it answers `rate-limited` on that
  socket forever. The recovery is a new socket after backoff, not a tighter loop.
- **One live signaling session per device.** A second successful `auth` for the same `deviceId`
  displaces the first, and the displaced socket receives
  `{op:'closed', reason:'this device connected again from somewhere else'}`. That is a normal message
  on a phone that changed networks, not an error to show.
- **`bye` before a deliberate teardown.** It closes the peer cleanly instead of leaving the desktop to
  discover the loss from ICE, which takes seconds the user can hear.

---

## 2. Data-channel messages

### The channels

The **client is the offerer**, so the client creates both data channels. The desktop binds them in
`ondatachannel` by label and **closes any channel whose label it does not recognise**, so a typo is a
silently dead channel rather than a warning.

| Label             | `RTCDataChannelInit`                    | Carries                               |
| ----------------- | --------------------------------------- | ------------------------------------- |
| `acappella-state` | `{ ordered: true }`                     | State the far end must not miss       |
| `acappella-live`  | `{ ordered: false, maxRetransmits: 0 }` | Traffic superseded within about 50 ms |

Create both before the offer, so the negotiated SDP includes the SCTP association from the start.

### Encoding

One JSON object per message, sent as a string. Every frame carries `v`, the negotiated protocol
version, stamped by the sender.

```json
{ "type": "floor", "action": "press", "scope": { "kind": "conductor" }, "v": 1 }
```

The desktop's decoder returns "that message did not exist" rather than throwing, for anything that
fails any of these:

- not a string, or not parseable JSON, or not a non-array object;
- `type` is not a string, or is not one of the ten known types;
- **`v` is not a number.** A frame without `v` is dropped in silence. This is the single most common
  way a first client appears to be connected and does nothing at all.
- `voice-event` without an `event` object carrying a string `type`;
- `floor` whose `action` is neither `press` nor `release`.

Malformed frames are dropped individually. They never close the channel, and there is no negative
acknowledgement, so a client cannot detect this by waiting for a complaint.

### Client to desktop

Exactly five types. The desktop's `DEVICE_ORIGINATED_MESSAGES` list is
`['hello', 'floor', 'interrupt', 'audio-level', 'link-quality']`; anything else arriving from a device
is not the client's to send.

| Type           | Payload                                                   | Channel | When                                             |
| -------------- | --------------------------------------------------------- | ------- | ------------------------------------------------ |
| `hello`        | `{ identity: { deviceId, name, platform, appVersion? } }` | `state` | First frame after the state channel opens        |
| `floor`        | `{ action: 'press' \| 'release', scope?: VoiceScope }`    | `live`  | Push-to-talk, and a wake-word hit                |
| `interrupt`    | `{ kind: 'barge-in' \| 'stop-word' }`                     | `live`  | Talking over the reply, or the stop word         |
| `audio-level`  | `{ level: number, speech: boolean }`                      | `live`  | ~20/s **while the floor is open, and only then** |
| `link-quality` | `{ rttMs, jitterMs, packetLoss, candidateType }`          | `live`  | Every ~2 s from a throttled `getStats()`         |

`VoiceScope` is `{ kind: 'conductor' }` or `{ kind: 'agent', sessionId: string }`, where `sessionId`
is an **agent** id from the roster, never a voice session id. Omitting `scope` means conductor.

**Push-to-talk deliberately rides the lossy channel.** A dropped release cannot leave a hot
microphone: the desktop's floor has an idle timeout, the next press is idempotent, and the
authoritative `floor-state` comes back either way.

**A client must not send a `voice-event`.** The Phase 01 protocol marks `wake`, `final-transcript`,
`barge-in`, and `stop-word` as client-originable, but not over this transport: the device channel
expresses them as `floor` and `interrupt`, and a wrapped `voice-event` from a device is dropped by
the coordinator's switch. There is no error, so this fails as silence.

### Desktop to client

| Type               | Payload                                                              | Channel   |
| ------------------ | -------------------------------------------------------------------- | --------- |
| `welcome`          | `{ version: number, appVersion: string, sessionId: string \| null }` | `state`   |
| `version-rejected` | `{ reason, message, desktopVersion, minimumVersion }`                | `state`   |
| `voice-event`      | `{ event: VoiceEvent }`                                              | see below |
| `floor-state`      | `{ holder: string \| null, isSelf: boolean, takenOverBy?: string }`  | `state`   |
| `revoked`          | `{ message: string }`                                                | `state`   |
| `link-quality`     | `{ rttMs, jitterMs, packetLoss, candidateType }`                     | `live`    |

- `floor-state.holder` is a device id, the literal `'local'` for the desktop's own microphone, or
  `null` when nobody holds the floor. `isSelf` saves the client an id comparison; trust it.
- `takenOverBy` is a **display name**, already resolved, and is set only on the message sent to the
  device that just lost the floor. Show it as written. It is also **momentary**: it rides its own
  frame, and the ordinary `floor-state` broadcast that follows a takeover carries no name at all. So
  react to the frame (a banner, a haptic) rather than rendering the field out of stored state, or the
  notice will erase itself a few milliseconds after it appears.
- `revoked` is the last frame before teardown, sent for revocation and for any deliberate close. Its
  `message` is the reason and is written for a human.

### Channel routing

The split is total and stated in one place, `deviceChannelForMessage()`. A client that guesses will
eventually put a `revoked` on the lossy channel, which is a device that keeps its microphone.

| Message                                                          | Channel      |
| ---------------------------------------------------------------- | ------------ |
| `hello`, `welcome`, `version-rejected`, `floor-state`, `revoked` | `reliable`   |
| `floor`, `interrupt`, `audio-level`, `link-quality`              | `unreliable` |
| `voice-event` with `audio-level` or `partial-transcript`         | `unreliable` |
| `voice-event`, every other event type                            | `reliable`   |

The desktop falls back to the reliable channel when a lossy message needs to go out before
`acappella-live` is open. A client should do the same for the first `hello`-adjacent traffic and stop
once both channels report open.

### The session-event catalogue

Every `voice-event` carries `sessionId` (the **voice** session, not an agent), `seq` (monotonic from
1 per session), and `ts` (epoch ms). All twenty types, and what a conforming client does with each:

| Event                | Client duty                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `wake`               | Show arming. Carries `source` and `origin`; a remote origin naming another device is not this phone.                     |
| `listen-start`       | The floor is genuinely open. Start the meter. `sttProviderId` names the engine; show it on demand.                       |
| `listen-stop`        | The floor closed. `reason` is `endpoint`, `stopped`, `interrupted`, or `error`. Clears a remote holder.                  |
| `partial-transcript` | Replace the in-flight user row. Lossy: may skip, never reorder. `text` is the full hypothesis, not a delta.              |
| `final-transcript`   | Commit the user row.                                                                                                     |
| `route-decision`     | Caption the user row with the target and the latency.                                                                    |
| `dispatch`           | Caption with the agent, tab, and whether the prompt was sent. This is the "it actually landed" signal.                   |
| `route-correction`   | **Rewrite the existing caption in place.** Do not append a row: the user said one sentence.                              |
| `agent-reply`        | Start the assistant row. Show `text`; `spokenText` is what is being said aloud.                                          |
| `speak-start`        | Speech begins. `sentenceCount` is a **lower bound while `streaming` is true**, so indices will run past it. Never clamp. |
| `speak-sentence`     | Append. Drop any sentence whose `utteranceId` is not the current run.                                                    |
| `speak-end`          | `complete`, `cancelled`, or `error`. Return the button to idle or latched.                                               |
| `barge-in`           | The authoritative confirmation of an interrupt. Selection haptic. The floor is **kept**.                                 |
| `stop-word`          | The session ended. Floor released, mic closed, success haptic.                                                           |
| `session-error`      | Show `message` verbatim. `code` decides the affordance; `recoverable` decides whether to offer a retry.                  |
| `audio-level`        | Meter, when the desktop's microphone is the open one.                                                                    |
| `mic-state`          | The **desktop's** microphone, not the phone's. Never drive the local mic pill from this.                                 |
| `provider-state`     | Powers the "where does my audio go" sheet. Show `egressStatement` verbatim and honour `audioLeavesMachine`.              |
| `tab-state`          | Update the selected agent's tab accessory.                                                                               |
| `agent-roster`       | **Replace** the project wheel. A snapshot, never a diff.                                                                 |

`session-error` codes, all of which must render a sentence rather than a spinner:
`provider-unavailable`, `provider-auth-failed`, `provider-quota-exceeded`, `provider-network-error`,
`no-agent-matched`, `dispatch-failed`, `audio-capture-failed`.

**Sequence handling.** `seq` is contiguous per voice session on the reliable channel; a gap there
means frames were lost and the client should treat its transcript as suspect rather than silently
stitching. Gaps in `audio-level` and `partial-transcript` are expected and carry no meaning: they are
the two events that ride the lossy channel by design. A `sessionId` change resets `seq` to 1, which
is not a gap.

**Unknown is not fatal.** A client must ignore an unrecognised `voice-event.type` and an
unrecognised field, and must keep processing the stream. That rule is what lets the desktop add an
event without breaking every shipped phone, and it is the reason the version below only moves for
changes that are genuinely breaking.

---

## 3. Version handshake

Two checks, at two layers, and they answer different questions.

### At `auth`, before the credential is looked at

`negotiateProtocolVersion()` runs first, on purpose: a client that cannot be talked to correctly
should be told THAT, rather than being authenticated into a session where it will misbehave in
silence. The current window is `MIN_SUPPORTED_DEVICE_PROTOCOL_VERSION = 1` to
`DEVICE_PROTOCOL_VERSION = 1`.

| Outcome          | Condition                           | Desktop sends                                                        |
| ---------------- | ----------------------------------- | -------------------------------------------------------------------- |
| Accepted         | `min <= v <= max`                   | `{op:'authenticated', protocolVersion: <the lower of the two>, ...}` |
| `client-too-old` | `v < min`                           | `{op:'error', code:'protocol-version', message}`                     |
| `client-too-new` | `v > max`                           | `{op:'error', code:'protocol-version', message}`                     |
| `malformed`      | Not an integer, or `< 1`, or absent | `{op:'error', code:'protocol-version', message}`                     |

The `message` already names the end that has to update. Client-too-old says "Update the app on the
device"; client-too-new says "Update Maestro on the desktop". **Show it verbatim.** Telling a user to
update the wrong end of the pair is worse than saying nothing.

What the client must do:

- **Treat it as terminal.** No reconnect, no backoff, no silent retry. The state is a full-screen
  message with the desktop's sentence and one action, which is not "Retry".
- **Do not delete the Keychain item.** This is not an authentication failure; the pairing is still
  valid and will work the moment one end is updated. Deleting the token here turns a five-minute
  update into a re-pair.
- **Use `authenticated.protocolVersion`, not your own constant,** in every subsequent `v`. It is the
  lower of the two ends and it may be below the version the client compiled against.
- **Never fall back a version you do not implement.** If the negotiated version is one the client
  does not fully speak, say so and stop. Half-speaking a protocol is the failure mode the two-number
  window exists to prevent.

### On the data channel

`welcome` and `version-rejected` are the peer-connection-level equivalents:
`welcome` carries the agreed `version`, the desktop's `appVersion`, and the live `sessionId` or
`null`; `version-rejected` carries the reason, a human sentence, and both `desktopVersion` and
`minimumVersion` so the client can say which end is behind.

**Desktop v1 does not emit either one.** The desktop settles the version at `auth`, so the
data-channel handshake is currently one-sided: the client sends `hello`, the desktop records the name
for its device list, and nothing comes back. A conforming client therefore:

- sends `hello` as the first frame on `acappella-state` and **does not block on `welcome`**. Do not
  gate the UI, the offer, or the floor button on a reply that will not arrive;
- handles `welcome` correctly if it does arrive, because it will once the desktop side closes this
  gap, and a client that treats it as unknown would drop the `sessionId` it carries;
- handles `version-rejected` by closing the peer and showing its `message`, exactly as for the
  signaling-layer rejection above.

This gap is tracked by conformance items C-31 and C-32 and is the one place where this document
describes a protocol the desktop has not finished implementing. It is stated rather than quietly
omitted because the shapes are already frozen in `device-protocol.ts` and a Swift client will
otherwise implement a handshake that appears to hang.

### What a version bump is for

`DEVICE_PROTOCOL_VERSION` moves only for a **breaking** change: a removed message type, a removed or
retyped field, a changed channel assignment, or a changed meaning for an existing value. Adding a
message type, an optional field, or a new `VoiceEvent` is not breaking, because both ends are
required to ignore what they do not recognise. A client that crashes on an unknown field has turned
an additive change into a breaking one on its own.

---

## 4. Required local behaviours

These are not UI suggestions. They are the client's half of guarantees the desktop makes to the user,
and a client that skips them breaks a promise made in the desktop's own settings copy.

### No capture before the floor is open

**Nothing is captured, encoded, or transmitted before the floor opens.** The rule falls out of the
architecture rather than being enforced by the desktop: the phone's microphone is not sent anywhere
until the phone opens the floor, so a client that streams early is unobservable from the desktop and
must be caught here.

Concretely, with `RTCAudioSession.useManualAudio = true` (see [[audio-session]]):

- The WebRTC audio unit stays **off** while the peer connection is up and the floor is closed.
- The outbound audio track exists but is disabled; the desktop's `set-floor-holder` gating is a second
  line of defence, not the first.
- `audio-level` messages are sent only while the floor is open. A meter running with the floor closed
  is a client measuring a microphone it should not have open.

### Wake word and stop word, on the device

Both run locally, for the reason in [[../architecture/acappella/wake-and-hotkeys]]: a wake word cannot
be detected remotely without sending the audio it exists to gate, and a stop word must be heard while
the desktop is speaking.

- A wake-word hit is **exactly** a `floor: press` with the selected scope. Not a `wake` voice event,
  not a new message type. From the desktop's side there is no difference and there must not be one.
- A stop-word hit is `interrupt: { kind: 'stop-word' }`.
- Arming follows the desktop's rule: wake phrases only while the session is cold, stop phrases in
  every active state, never both. Otherwise a wake phrase spoken mid-answer stacks a second session.
- The wake-word tap is a **separate capture gate** from the WebRTC one. It runs locally, transmits
  nothing, and still lights the system recording indicator, which is why the microphone pill in
  [[interaction-model]] has three states rather than two.
- Defaults come from the desktop (`DEFAULT_WAKE_PHRASE = 'hey maestro'`,
  `DEFAULT_STOP_PHRASE = 'maestro stop'`, with `'nevermind'` always armed and not editable). Do not
  carry a second copy of these strings as client constants.

### Barge-in ducking within 20 ms

While TTS is playing, a local VAD watches the microphone. On detected speech:

1. **Duck local playback within 20 ms**, locally, before anything goes on the wire. One frame of
   audio, not one round trip. A phone on a relayed path is 150 ms from the desktop and back, and a
   user who has started talking over the reply has already decided the reply is wrong.
2. Send `interrupt: { kind: 'barge-in' }` in the same turn of the run loop.
3. Restore the level only on the authoritative `barge-in` **or** `speak-end` voice event. If neither
   arrives within 500 ms, restore the level and keep the floor: a duck that never lifts is a session
   that appears to have died.

Barge-in keeps the floor. Stop word releases it. Every assistant that merged those two became one you
cannot get rid of, and the desktop enforces the distinction: `barge-in` calls `interrupt()`,
`stop-word` calls `hardStop()`.

Both are **refused outright from a device that is not holding the floor**, with no error frame. A
client that shows a stop button while another device holds the floor is showing a button that does
nothing.

### Floor state is never assumed

- Send `press` on touch-down, not after classifying tap versus hold. The desktop's press is
  idempotent and waiting 300 ms puts 300 ms in front of every utterance.
- Render the button from `floor-state`, never from the local gesture. The gesture is a request.
- Start closed after any reconnect and wait for `floor-state`. A phone that assumes it still holds
  the floor is a hot microphone the desktop does not know about.
- A release from a device that is not the current holder is discarded, by design: without that rule a
  device that just lost the floor would shut the microphone of the device that just took it.

---

## 5. Conformance checklist

Each item is independently testable and is named by the suite at
`src/__tests__/acappella/conformance/`. An implementation is conformant when every item passes, and
each item is written so that "passes" is observable from outside the client.

The suite runs in `npm run test`, on a harness (`harness.ts`) that assembles the real desktop stack -
`ACappellaTransport` over a real `PeerRegistry` - and drives it with the real browser reference
client, so a frame really is encoded, crosses a loopback data channel, and comes back out of
`decodeDeviceMessage()` on the far side. Four files, split by what fails:

| File                                  | Items                                  | What it proves                                                                                              |
| ------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `signaling.conformance.test.ts`       | C-01 to C-15                           | Pairing, auth, the ordering rules, both rate limits, and what `authenticated` carries.                      |
| `data-channel.conformance.test.ts`    | C-16 to C-30, C-37 to C-40             | Channel labels and inits, `v`, routing, malformed frames, the event catalogue, and the microphone gate.     |
| `failure-paths.conformance.test.ts`   | C-12 to C-15, C-33 to C-49             | Version mismatch, mid-session revocation, a network drop and reconnect, floor takeover, and the stop word.  |
| `../../web-desktop/acappella-client/` | C-24 to C-28, C-31 to C-36, C-44, C-47 | The client-side half, in `src/__tests__/web-desktop/acappella-client/` where the DOM and the gestures live. |

A rule the desktop enforces is asserted from a raw signaling socket rather than from the reference
client, because a limit a conforming client never reaches is a limit nobody has tested.

### Signaling

| ID   | Requirement                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------ |
| C-01 | Every frame is `{type:'acappella_signal', payload:{op}}` over `/$TOKEN/ws`. No second socket, no second token.     |
| C-02 | `pair-claim` sends a non-empty `name` and the literal `platform: 'ios'`.                                           |
| C-03 | `pair-poll` runs on a 1 s interval and stops at the `expiresAt` from the **first** `pair-pending`.                 |
| C-04 | `pair-approved` writes the token to the Keychain **before** any UI state changes.                                  |
| C-05 | `pair-rejected` and `auth-failed` messages are shown verbatim, with nothing appended.                              |
| C-06 | `auth` always carries an integer `protocolVersion >= 1`.                                                           |
| C-07 | No `offer` or `ice-candidate` is sent before `authenticated` arrives on the same socket.                           |
| C-08 | Fewer than 6 offers are sent in any 60 s window under normal network churn.                                        |
| C-09 | At most one `auth` attempt per socket; a failure opens a new socket after backoff.                                 |
| C-10 | `authenticated.iceServers` and `iceTransportPolicy` are used as sent. No hard-coded STUN server exists in the app. |
| C-11 | `authenticated.audio` is applied to the outgoing encoder (`fec`, `dtx`, bitrate, remote AEC request).              |
| C-12 | `closed` and `revoked` are terminal. No reconnect follows either.                                                  |
| C-13 | `auth-failed` deletes the Keychain item and returns the app to the unpaired state.                                 |
| C-14 | `bye` is sent before any deliberate teardown, including backgrounding without a PTT session.                       |
| C-15 | `error: peer-failed` restarts ICE and re-offers under the backoff schedule rather than re-pairing.                 |

### Data channel

| ID   | Requirement                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------ |
| C-16 | Both channels are created by the client, before the offer, with the exact labels `acappella-state` and `acappella-live`. |
| C-17 | `acappella-live` is created with `{ordered:false, maxRetransmits:0}`; `acappella-state` with `{ordered:true}`.           |
| C-18 | Every outbound frame carries a numeric `v` equal to the negotiated version.                                              |
| C-19 | `hello` is the first frame on `acappella-state` and carries a complete `identity`.                                       |
| C-20 | Only the five device-originated types are ever sent. No `voice-event`, `floor-state`, `welcome`, or `revoked`.           |
| C-21 | Each message goes out on the channel the routing table names, with no exceptions.                                        |
| C-22 | Malformed or unknown inbound frames are ignored without closing the channel or the peer.                                 |
| C-23 | An unknown `voice-event.type` and an unknown field are both ignored, and processing continues.                           |
| C-24 | `agent-roster` replaces the wheel wholesale; no merge, no accumulation of stale agents.                                  |
| C-25 | `route-correction` rewrites the existing caption in place and never appends a second row.                                |
| C-26 | `speak-start.sentenceCount` is treated as a lower bound while `streaming` is true; indices past it are not clamped.      |
| C-27 | `speak-sentence` frames whose `utteranceId` is not the current run are dropped.                                          |
| C-28 | `mic-state` drives only the desktop indicator, never the local microphone pill.                                          |
| C-29 | A `seq` gap on the reliable channel is surfaced as a suspect transcript, not stitched over.                              |
| C-30 | `provider-state.egressStatement` is shown verbatim wherever the app answers "where does my audio go".                    |

### Version handshake

| ID   | Requirement                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------- |
| C-31 | `hello` is sent without blocking on `welcome`; the UI, the offer, and the floor button do not wait for it. |
| C-32 | `welcome` and `version-rejected` are both handled correctly if received.                                   |
| C-33 | `error: protocol-version` is terminal, shows the desktop's sentence verbatim, and offers no Retry.         |
| C-34 | A version rejection does **not** delete the Keychain item.                                                 |
| C-35 | `authenticated.protocolVersion` is used for `v`, not the client's own constant.                            |
| C-36 | A negotiated version the client does not fully implement is refused loudly rather than half-spoken.        |

### Local behaviour

| ID   | Requirement                                                                                         |
| ---- | --------------------------------------------------------------------------------------------------- |
| C-37 | No audio is captured, encoded, or transmitted before `floor-state.isSelf` is true.                  |
| C-38 | `RTCAudioSession.useManualAudio` is true and the audio unit is started only for an open floor.      |
| C-39 | `audio-level` is sent at roughly 20/s while the floor is open, and never while it is closed.        |
| C-40 | `link-quality` is sent from a throttled `getStats()` at roughly 2 s intervals.                      |
| C-41 | The wake word runs on the device and produces a plain `floor: press` with the selected scope.       |
| C-42 | The stop word runs on the device and produces `interrupt: {kind:'stop-word'}`.                      |
| C-43 | Wake phrases arm only while the session is cold; stop phrases arm in every active state.            |
| C-44 | Local VAD ducks playback within 20 ms of detected speech, before the `interrupt` frame is sent.     |
| C-45 | The duck lifts on `barge-in` or `speak-end`, or after 500 ms with the floor kept.                   |
| C-46 | Barge-in keeps the floor and the microphone; only the stop word releases them.                      |
| C-47 | `floor: press` is sent on touch-down, before tap-versus-hold is classified.                         |
| C-48 | The button renders `floor-state`, not the local gesture, including `takenOverBy` after a takeover.  |
| C-49 | The floor starts closed after every reconnect and waits for `floor-state`.                          |
| C-50 | The microphone pill distinguishes "Mic off", "Listening for wake word", and "Sending" at all times. |

---

## What to read next

- `src/web-desktop/acappella-client/README.md` for the browser reference client: this document, but
  running, and the endpoint the desktop is regression-tested against.
- [[connection-and-pairing]] for the discovery, pairing, Keychain, and reconnection behaviour these
  messages sit inside.
- [[audio-session]] for how `RemoteAudioConfig` and the two capture gates map onto
  `AVAudioSession` and WebRTC.framework.
- [[interaction-model]] for what each of these events does to the screen.
- [[project-structure]] for where the code implementing this lives.
- [[../architecture/acappella/voice-session-protocol]] for the desktop-side narrative behind the
  session events.
