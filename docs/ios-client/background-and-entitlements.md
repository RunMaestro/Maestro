---
type: specification
title: Background Audio and Entitlements
created: 2026-08-14
tags:
  - ios
  - voice
  - acappella
related:
  - '[[overview]]'
  - '[[audio-session]]'
  - '[[app-store-review]]'
  - '[[project-structure]]'
---

# Background Audio and Entitlements

The problem this document solves: a user puts the phone on the desk, walks to the whiteboard, and
talks. The screen locks. On iOS, that is the end of the microphone unless the app has told the
system, in advance and in a way Apple sanctions, what it is.

There are exactly two sanctioned answers and one tempting wrong one.

## The clean answer: the Push to Talk framework (iOS 16+)

`PushToTalk` was built for walkie-talkie apps, and A Cappella is one. The phone joins a channel,
the system shows a persistent indicator and its own transmit affordance, and the app is allowed to
capture audio in the background **while transmitting and only while transmitting**.

That restriction is not an obstacle. It is the same rule the app already enforces: the floor is
open or it is not, and no audio leaves the device when it is not. The framework enforces in the OS
what [[audio-session]] enforces in our code, which means the two cannot drift.

### What it requires

| Requirement                              | Detail                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minimum deployment target                | **iOS 16.0.** This is the single constraint that sets the app's floor. See [[project-structure]].                                                                                                        |
| Entitlement                              | `com.apple.developer.push-to-talk`. **Restricted**: it must be requested from Apple through the developer account and granted before it can be added to a provisioning profile. Assume weeks, not hours. |
| Background mode                          | `UIBackgroundModes` must contain `push-to-talk`.                                                                                                                                                         |
| Push credentials                         | An APNs key configured for the `pushtotalk` push type, if the desktop should be able to wake a backgrounded phone.                                                                                       |
| Framework ownership of the audio session | The app must **not** activate `AVAudioSession` itself while in a channel.                                                                                                                                |

### What it grants

- **Background microphone access while transmitting.** Screen locked, app not foreground, floor
  open: audio flows.
- **A system UI the user cannot lose.** iOS shows the channel in the status bar and Dynamic Island
  with a transmit control, so the user can talk and stop talking without unlocking the phone. This
  is the actual feature; our in-app button becomes the secondary path, not the primary one.
- **A wake path from the desktop.** A `pushtotalk` PushKit notification can bring the app back into
  a live channel state without the user touching anything.
- **Battery behaviour the system understands**, rather than an app fighting the scheduler.

### What Apple expects in return

Read this as a contract, because review treats it as one:

1. **The app is genuinely push-to-talk.** There is a transmit gesture, a clear start and end, and
   the microphone is closed the rest of the time. A Cappella is exactly this; do not add a
   continuous-listening mode to the framework path.
2. **The channel is joined in response to a user action** and left when the user is done. Joining
   at launch and never leaving is the pattern Apple rejects.
3. **The framework owns the audio session.** Implement
   `channelManager(_:didActivate:)` and `channelManager(_:didDeactivate:)` and do the WebRTC
   configuration from [[audio-session]] inside those callbacks. Calling `setActive(true)` yourself
   while in a channel is undefined behaviour and, in practice, silence.
4. **The system UI is authoritative.** When the user transmits from the status bar control,
   `channelManager(_:didBeginTransmittingFrom:)` fires and we send `floor: press`. When they stop,
   we send `floor: release`. The in-app button and the system control drive the same code path.
5. **Leaving the channel means leaving.** `leaveChannel` on user request, on revocation, and on a
   terminal disconnect. A stale channel indicator on a user's status bar for an app that is not
   connected to anything is the complaint that gets an entitlement pulled.

### Mapping onto our protocol

```
PTChannelManagerDelegate                          A Cappella
------------------------------------------------  ---------------------------------
didActivate audioSession                       ->  configure RTCAudioSession, isAudioEnabled = true
didBeginTransmittingFrom: .unknown/.userRequest->  send { type: 'floor', action: 'press', scope }
didEndTransmittingFrom:                        ->  send { type: 'floor', action: 'release' }
didDeactivate audioSession                     ->  isAudioEnabled = false, teardown capture
channelDescriptor                              ->  name: the paired desktop's name
                                                   image: the selected agent's glyph
incomingPushResult                             ->  reconnect signaling, re-auth, re-offer
```

`floor-state` from the desktop still drives the UI. If another device takes the floor while we are
transmitting, stop the transmission through `stopTransmitting(channelUUID:)` so the system UI
agrees with the app.

### What it does not grant

**Not a background wake word.** The framework gives the microphone during transmission, and the
wake word by definition runs before transmission. There is no supported way to run continuous
background capture for keyword spotting, and there should not be one.

So: **the wake word works while the app is foregrounded, and only then.** Say that in the app, next
to the wake-word toggle, in one sentence. A user who thinks the phone is listening for "hey
maestro" in their pocket and finds it is not will conclude the feature is broken rather than
constrained, and they will be right to.

## The alternative: foregrounded with a dimmed screen

For iOS 15, for a user who does not want the system channel indicator, and as the fallback while
the entitlement request is pending:

```swift
UIApplication.shared.isIdleTimerDisabled = true
// plus a large dark UI, and an explicit "Keep awake" toggle the user controls
```

The app stays foreground, the audio session stays active, and everything in [[audio-session]]
works unchanged. It requires no entitlement and no review conversation.

The cost is real and must be stated in the UI rather than discovered:

| Draw                                | Rough order of magnitude, to be measured before shipping                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opus at 24 kbps with DTX, over WiFi | Low. The radio is the smaller half of this.                                                                                                               |
| Cellular instead of WiFi            | Noticeably worse, because DTX lets the radio sleep less often than the periodic data channel traffic allows.                                              |
| Screen on at minimum brightness     | **Dominates everything else.** On an OLED device a near-black UI is much cheaper than a light one, which is why the keep-awake screen is specified black. |

Those are shapes, not measurements. Before shipping, run the device for a measured hour in each of
three states (idle connected, floor open on WiFi, floor open on cellular) with Xcode's Energy
gauge, and put the real numbers in this table. Shipping an estimate as if it were a measurement is
how a battery complaint becomes a surprise.

Mitigations that are worth building on this path:

- A dedicated **keep-awake screen**: pure black, the talk button, the level meter, nothing else.
- **Auto-release the idle timer** whenever the floor has been closed for 5 minutes, and say so.
- **Disable it on Low Power Mode** (`ProcessInfo.processInfo.isLowPowerModeEnabled`), with a
  visible explanation, and re-enable when it clears.

## The tempting wrong answer: `UIBackgroundModes: audio`

Declaring the `audio` background mode and keeping a `.playAndRecord` session alive does keep the
microphone running with the screen off. Do not ship it as the primary path.

- **It is not what the mode is for.** The `audio` mode is for playback and for recording apps whose
  recording is the user-visible product. Review reads a background `audio` declaration on a
  microphone app as continuous background recording and asks hard questions, and the answers are
  worse to give than the Push to Talk entitlement is to request.
- **It gives the OS no reason to protect the app.** Under memory pressure a background audio
  session is a candidate for termination in a way a PTT channel is not.
- **It removes the OS-level guarantee** that the microphone is closed when the floor is closed. The
  same guarantee then rests entirely on our own gating, with no second enforcement.

There is one legitimate use: a **debug build** flag, so protocol work can happen before the
entitlement arrives. Keep it out of any configuration that can be archived for distribution.

Also on the do-not list: **CallKit and VoIP PushKit**. Reporting an A Cappella session as a call to
keep the microphone alive misrepresents the app to the OS and to the user's call history, and a
VoIP push that does not report a call to CallKit terminates the app by design.

## `Info.plist` and entitlements summary

```xml
<!-- Info.plist -->
<key>NSMicrophoneUsageDescription</key>
<string>Maestro sends your voice to the computer you paired with, so you can talk to your agents from across the room. Audio is captured only while you are holding the talk button.</string>

<key>NSCameraUsageDescription</key>
<string>Maestro scans the pairing code shown on your computer. The camera is used only for that scan.</string>

<key>NSLocalNetworkUsageDescription</key>
<string>Maestro finds your computer on this network so you can pair without typing an address.</string>

<key>NSBonjourServices</key>
<array><string>_maestro._tcp</string></array>

<key>UIBackgroundModes</key>
<array><string>push-to-talk</string></array>
```

```xml
<!-- Maestro.entitlements -->
<key>com.apple.developer.push-to-talk</key>
<true/>
<key>aps-environment</key>
<string>production</string>
```

The exact copy for the usage descriptions, and why each sentence is worded the way it is, is in
[[app-store-review]].

## Decision, stated once

**Ship the Push to Talk framework path, minimum iOS 16, with the dimmed-screen keep-awake mode as
a user-selectable alternative on the same build.** Request the entitlement on day one of the Swift
effort, because it is the longest-lead item in the whole project and everything else can be built
against the keep-awake path while it is pending.
