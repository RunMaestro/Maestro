---
type: specification
title: Audio Session and WebRTC Configuration
created: 2026-08-14
tags:
  - ios
  - voice
  - acappella
related:
  - '[[overview]]'
  - '[[connection-and-pairing]]'
  - '[[interaction-model]]'
  - '[[background-and-entitlements]]'
  - '[[../architecture/acappella/latency-baseline]]'
---

# Audio Session and WebRTC Configuration

This is the file that decides whether the app is usable. Everything else can be rebuilt from a
screenshot; an audio session configured wrong produces echo, a microphone that dies when AirPods
connect, or a call that silently kills the session, and none of those look like configuration
problems from the outside.

## The one thing to get right

**`AVAudioSession` in `.playAndRecord` category with `.voiceChat` mode.**

That mode is what routes capture through Apple's Voice-Processing I/O audio unit, which gives
hardware acoustic echo cancellation, noise suppression, and automatic gain control tuned by people
with access to the microphone geometry of every iPhone ever shipped. It is the reason a phone
placed on a desk with its speaker playing a synthesised reply does not send that reply straight
back as a new utterance.

The desktop cannot do this for us. It asks for it (`requestRemoteEchoCancellation: true` in the
`audio` config from `authenticated`) because the reference signal for cancelling the phone's echo
is the phone's own speaker output, and only the phone has it. The desktop applies its own AEC to
its own microphone, where it works.

## Session configuration

```swift
let session = AVAudioSession.sharedInstance()

try session.setCategory(
    .playAndRecord,
    mode: .voiceChat,
    options: [.allowBluetooth, .defaultToSpeaker, .allowBluetoothA2DP]
)
try session.setPreferredSampleRate(48_000)      // Opus native rate
try session.setPreferredIOBufferDuration(0.02)  // one 20 ms Opus frame
try session.setActive(true)
```

Each choice, and what breaks without it:

| Setting                              | Reason                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.playAndRecord`                     | Duplex. `.record` gives no playback, `.playback` gives no microphone.                                                                                                                                   |
| `.voiceChat` mode                    | The whole point. Enables VPIO, hence hardware AEC. Without it the phone hears itself.                                                                                                                   |
| `.allowBluetooth`                    | HFP, which is the only Bluetooth profile with an input path. Without it, connecting AirPods loses the microphone and the user cannot tell why.                                                          |
| `.defaultToSpeaker`                  | Otherwise `.playAndRecord` routes output to the earpiece receiver, and a phone on a desk sounds like it is broken.                                                                                      |
| `.allowBluetoothA2DP`                | Lets output-only Bluetooth devices carry playback at full quality when nothing needs the HFP input path.                                                                                                |
| `setPreferredSampleRate(48000)`      | Opus is native at 48 kHz. A resample on the way in is latency and quality thrown away. The system may not honour it (VPIO frequently runs at 24 kHz); read back `session.sampleRate` and do not assume. |
| `setPreferredIOBufferDuration(0.02)` | Matches the Opus frame size, so a capture callback fills exactly one packet. Lower buffers cost CPU and gain nothing over the network jitter budget in [[../architecture/acappella/latency-baseline]].  |

**Do not** set `.mixWithOthers`. A voice assistant that ducks under a podcast rather than taking
the audio route is one you cannot hear when it matters.

## WebRTC.framework configuration

libwebrtc on iOS owns its own audio unit and will fight `AVAudioSession` if both are configured
independently. `RTCAudioSession` is the shared lock that stops that.

```swift
let rtc = RTCAudioSession.sharedInstance()
rtc.lockForConfiguration()
defer { rtc.unlockForConfiguration() }

// We decide when the microphone runs, not the peer connection lifecycle.
rtc.useManualAudio = true
rtc.isAudioEnabled = false   // flipped true only while the floor is open

let config = RTCAudioSessionConfiguration.webRTC()
config.category = AVAudioSession.Category.playAndRecord.rawValue
config.mode = AVAudioSession.Mode.voiceChat.rawValue
config.categoryOptions = [.allowBluetooth, .defaultToSpeaker, .allowBluetoothA2DP]
RTCAudioSessionConfiguration.setWebRTC(config)
```

Three requirements:

- **`useManualAudio = true` is mandatory**, not an optimisation. It is what lets the microphone be
  off while the peer connection is up, which is the entire privacy story: a paired phone sitting
  in a pocket has a live connection and a cold microphone. Without it, libwebrtc starts capture as
  soon as a sending transceiver exists.
- **Never call `setActive` on `AVAudioSession` directly while `RTCAudioSession` holds the lock.**
  Route through `RTCAudioSession`'s own `setActive`/`setCategory` so the two agree on state.
- **Do not enable libwebrtc's software echo canceller.** On iOS the VPIO unit already cancelled;
  running the software APM on top of it produces gating artifacts on the far end that sound like a
  bad connection. Verify with the double-talk test below rather than trusting either default.

### Opus parameters

The desktop sends a `RemoteAudioConfig` in the `authenticated` message:

```ts
{ fec: true, dtx: true, maxAverageBitrate: 24000, requestRemoteEchoCancellation: true }
```

Apply them to the outgoing `opus/48000/2` `fmtp` line in the local offer:

| Config field                    | SDP / API                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fec: true`                     | `useinbandfec=1`. This is what survives 5 percent loss on cellular.                                                                                                  |
| `dtx: true`                     | `usedtx=1`. Stops sending during silence, which is most of a session, and lets the radio sleep.                                                                      |
| `maxAverageBitrate: 24000`      | `maxaveragebitrate=24000`. Speech at 24 kbps in Opus is transparent enough to route on.                                                                              |
| `requestRemoteEchoCancellation` | Already satisfied by `.voiceChat`. If it ever arrives `false`, still keep `.voiceChat`: the desktop is asking us to skip processing, not telling us to send it echo. |

Prefer mono (`stereo=0`, `sprop-stereo=0`). A speech pipeline downmixes anyway, and the second
channel is bitrate spent on nothing.

**Never send more than one audio track.** The desktop gates exactly one remote microphone into the
capture pipeline at a time (`set-floor-holder`); a second track is received and discarded.

## Route changes

Subscribe to `AVAudioSession.routeChangeNotification` and act on the reason, not on the fact that
something changed:

| `AVAudioSession.RouteChangeReason` | Situation                                      | Behaviour                                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.newDeviceAvailable`              | AirPods or a headset connected                 | Let it take the route. Update the output label in the UI. If the floor is open, keep it open: the user connected headphones mid-sentence, they did not ask to stop.                                     |
| `.oldDeviceUnavailable`            | AirPods removed, cable unplugged               | Apple's convention is to pause. **Close the floor** and send `floor: release`. A microphone that follows a yanked headset back to the phone's built-in mic without telling anyone is a privacy failure. |
| `.categoryChange`                  | Another app or the system changed the category | Re-apply our configuration. If re-application fails, surface it: the session is no longer what we think it is.                                                                                          |
| `.override`                        | Speaker/receiver override                      | Update the UI label only.                                                                                                                                                                               |
| `.routeConfigurationChange`        | Same route, different config                   | Read back `sampleRate` and `ioBufferDuration`; log if they moved.                                                                                                                                       |

Specific routes worth naming:

- **AirPods and Bluetooth headsets** use HFP for duplex, which is 16 kHz wideband on current
  firmware and 8 kHz narrowband on older devices. Both are below Opus's native rate. This is
  acceptable and must not be treated as an error, but the quality indicator's tooltip should be
  able to say the input is a Bluetooth headset when a user asks why transcription got worse.
- **CarPlay** presents as a route like any other. The app must work there, but the push-to-talk
  button is not reachable while driving, so CarPlay is precisely the case that needs the wake word
  and the Push to Talk framework path in [[background-and-entitlements]]. Do **not** ship a CarPlay
  UI target in the first version; it is on the non-goal list in [[project-structure]].
- **Wired headsets** behave like the built-in route with a different microphone. Nothing special.

## Interruptions

`AVAudioSession.interruptionNotification` is the one that decides whether an incoming phone call
leaves the app in a sane state.

```
.began
  -> close the floor immediately (the OS already took the microphone)
  -> send `floor: release` if we held it, and `interrupt: stop-word` is NOT sent:
     the user did not end the conversation, the phone did
  -> keep the peer connection and the data channel alive; the roster and transcript
     stay on screen so returning from the call resumes a conversation rather than
     restarting one
  -> mark the mic button "Interrupted"

.ended
  -> if options contains .shouldResume: re-activate the session and re-apply the
     RTCAudioSessionConfiguration, then return the button to its idle state
  -> do NOT re-open the floor automatically. A microphone that opens itself after
     a phone call is the worst possible failure mode for a microphone app.
```

Also handle:

- **`AVAudioSession.mediaServicesWereResetNotification`.** The audio server died. Every
  `AVAudioSession`, `AVAudioEngine`, and audio unit reference is now invalid. Tear down the local
  capture graph and the `RTCAudioSession` configuration and rebuild both from scratch. This is
  rare and it is unrecoverable if handled by anything less than a full rebuild.
- **`.mediaServicesWereLostNotification`.** Stop everything and wait for the reset notification.
- **Siri.** Arrives as an ordinary interruption. Nothing special beyond the above.

## Microphone gating

Two independent gates, because they answer two different questions.

**Gate 1: is the peer connection carrying audio?** `RTCAudioSession.isAudioEnabled`, plus
`sender.track?.isEnabled`. Both off until the floor is open. This is the gate that satisfies
"no audio leaves this device before the floor is open".

**Gate 2: is anything capturing at all?** With `useManualAudio = true` and audio disabled, the
WebRTC audio unit is not running. If the app also runs on-device wake-word detection, that
capture is a **separate, local-only** `AVAudioEngine` tap whose buffers never reach an encoder and
never leave the process. It exists so the phone can hear "hey maestro"; it is the one capture that
runs with the floor closed, and it is why the orange microphone indicator can be lit while nothing
is being transmitted. The UI must say which of the two states it is in, in words, in the HUD. See
[[interaction-model]].

## Playback

The desktop's TTS arrives as a remote audio track. Requirements:

- **Attenuate, do not stop, on local VAD.** When the on-device detector hears speech while the
  remote track is playing, duck playback to roughly 20 percent within 20 ms and send
  `interrupt: barge-in`. The authoritative cancellation comes back as a `barge-in` voice event
  once the desktop has actually stopped generating; restore or stop playback then. Ducking first
  is what makes barge-in feel instant even though the round trip is not.
- **Do not buffer ahead.** WebRTC's jitter buffer is the buffer. A second one on top of it adds
  latency to a system whose entire budget is documented in
  [[../architecture/acappella/latency-baseline]].
- **`speak-end` is the end of speech, not the end of the track.** Do not tear down the audio unit
  between replies; the reconfiguration cost lands on the front of the next one.

## Verification

An audio session cannot be reviewed by reading it. Before any release:

1. **Double-talk test.** Phone on a desk, speaker at 80 percent, desktop reading a long reply.
   Talk over it. The desktop must receive your words and must not receive its own voice. If the
   transcript contains fragments of the reply, AEC is not engaged and the mode is wrong.
2. **AirPods mid-sentence.** Open the floor, speak, connect AirPods. Capture must survive.
3. **AirPods removed mid-sentence.** Floor must close and the desktop must be told.
4. **Incoming call during a reply.** Session survives, floor closes, nothing resumes by itself.
5. **CarPlay connect and disconnect** while the floor is open.
6. **Airplane mode toggle** while speaking, to exercise the reconnect path in
   [[connection-and-pairing]] against a live audio session.
