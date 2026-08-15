# A Cappella reference client

The device half of the A Cappella voice protocol, in a browser, with no framework in it.

This is not a demo. It exists for two reasons:

1. **It keeps the desktop honest.** The desktop's WebRTC transport, signaling service, and floor
   controller were all written against tests that the desktop also wrote. This is an independent
   endpoint that pairs, authenticates, offers, opens both data channels, holds the floor, and speaks
   every message the protocol defines, so a change that would break a phone fails here first.
2. **It is what a Swift developer reads.** [`docs/ios-client/protocol-conformance.md`](../../../docs/ios-client/protocol-conformance.md)
   says what the wire behaviour is; this says it in code that runs. Where a comment here cites a
   `C-nn`, that is the conformance item it implements.

## Layout

| File         | What it is                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `client.ts`  | The whole protocol, with **no DOM in it**. Socket, peer, microphone, clock, and store injected. |
| `main.ts`    | The browser adapters: WebSocket, `RTCPeerConnection`, `getUserMedia`, meter, playback, gesture. |
| `ui.ts`      | Plain-DOM rendering: project wheel, status strip, transcript.                                   |
| `index.html` | The page. A second Rollup input in the web-desktop bundle.                                      |
| `styles.css` | No framework, no theme system.                                                                  |

The split is the point. `client.ts` is DOM-free so the conformance suite at
`src/__tests__/acappella/conformance/` can drive it against fakes, and so the parts a phone has to
reimplement are not tangled with the parts a browser happens to provide.

Nothing here restates the protocol. The message shapes, the channel routing table, the encoder, and
the decoder all come from `src/shared/acappella/device-protocol.ts`; the signaling shapes from
`src/shared/acappella/signaling-protocol.ts`; the SDP tuning and stats reduction from
`src/shared/acappella/peer-tuning.ts`, which is the same code the desktop's peer runs. A second copy
of any of them would drift, and the drift would be silent.

## Running it

**Against a running desktop.** Turn on A Cappella in Encore Features, open
Settings -> Encore Features -> A Cappella -> Paired Devices, and press "Show pairing code". Then open
`http://<desktop>:<port>/<token>/acappella` and paste the JSON behind the QR code into the payload
box. The desktop encodes exactly `JSON.stringify(PairingPayload)` into that QR, so pasting it is what
a camera scan produces. Approve the request on the desktop and the client authenticates, offers, and
connects.

**Standalone, against a desktop elsewhere.** `npm run dev:web-desktop`, then open
`http://localhost:5176/acappella-client/`. Same payload paste. This is the useful mode when the thing
being tested is the desktop, because the client is then genuinely a different origin and a different
process.

## What it does, and what it deliberately does not

It implements: pairing (claim, poll, approve, deny, reject), authentication with the stored token,
offer/answer with trickled ICE, both data channels with their exact labels and inits, `hello`, the
floor (tap to toggle and press-and-hold, with the release classified against the desktop's own
`DEFAULT_HOLD_THRESHOLD_MS`), `audio-level` at roughly 20/s while the floor is open, `link-quality`
from a throttled `getStats()`, barge-in with local ducking before the frame goes out, the stop word,
the full session-event catalogue into a transcript, the project wheel from `agent-roster`, `seq` gap
detection on the reliable channel, and audible playback of the assistant's voice.

It deliberately does not implement: a wake word (an on-device model is not what this proves), the
Keychain (it uses `localStorage`, which is this platform's equivalent), or any UI polish.

One deliberate difference from the iOS design worth knowing about. iOS keeps the WebRTC audio unit
cold with `RTCAudioSession.useManualAudio = true` and toggles it for an open floor. A browser has no
such switch, so this client calls `getUserMedia` when the floor opens and stops the track when it
closes, attaching and detaching it with `replaceTrack` (which needs no renegotiation). The observable
property is the same and is the one that matters: the recording indicator tracks the floor exactly,
and nothing is captured before it opens.

## When this needs changing

If you change any message shape, channel assignment, or ordering rule in the protocol, this client
has to change with it, and the conformance suite should fail before you notice by hand. That is the
whole arrangement: three things that must agree, with the third one executable.
