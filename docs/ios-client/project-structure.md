---
type: specification
title: A Cappella iOS Project Structure
created: 2026-08-14
tags:
  - ios
  - voice
  - acappella
related:
  - '[[overview]]'
  - '[[connection-and-pairing]]'
  - '[[audio-session]]'
  - '[[interaction-model]]'
  - '[[background-and-entitlements]]'
  - '[[app-store-review]]'
  - '[[protocol-conformance]]'
---

# iOS Project Structure

The layout, the dependencies, the signing chain, and the list of things the first Swift effort is
not allowed to build. Everything here exists to keep one app small enough that one person can
finish it, and to keep the protocol in it from drifting away from the desktop that defines it.

## Where the code lives

**In this repository, at `ios/`.** Not a second repository.

The argument for a separate repo is that an Xcode project in a TypeScript monorepo is noise, and
that is true. The argument against it is stronger: the wire protocol is defined by
`src/shared/acappella/device-protocol.ts`, the reference implementation of the client half is at
`src/web-desktop/acappella-client/`, and the conformance suite that judges both is at
`src/__tests__/acappella/conformance/`. A protocol change touches all of them, and it should be
able to touch the Swift in the same commit and the same review. Two repositories means a change
lands in one of them first, and the window between the two is exactly where the phone goes silent
in a way nobody notices until a device is in a hand.

Cost, paid deliberately: macOS runners are expensive, so the iOS job is a separate workflow gated
on `paths: ['ios/**', 'src/shared/acappella/**']` rather than a fourth leg of the existing
`test` matrix in `.github/workflows/ci.yml`. The Node CI legs must never wait on Xcode.

## Deployment target and toolchain

| Choice             | Value                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minimum iOS        | **16.0**                                                                                                                                                                    |
| Devices            | iPhone, and iPad unmodified (universal, no iPad-specific layout in v1)                                                                                                      |
| Language           | Swift, strict concurrency on, no Objective-C beyond what WebRTC's headers bring in                                                                                          |
| UI                 | SwiftUI for everything except the talk button's gesture handling, which is a `UIViewRepresentable` so touch-down can be handled without SwiftUI's gesture-recognition delay |
| Xcode              | Pinned in `ios/.xcode-version` and read by CI. Do not track "latest"; a toolchain bump is a commit like any other.                                                          |
| Dependency manager | Swift Package Manager only. No CocoaPods, no Carthage.                                                                                                                      |

**iOS 16 is set by one thing and one thing only:** the Push to Talk framework, which is the
sanctioned way to hold a microphone with the screen off and is therefore the whole background
story. The reasoning, and the two alternatives that were rejected, are in
[[background-and-entitlements]]. If that decision is ever revisited, the floor moves with it; no
other API in this app needs more than iOS 15.

Everything in [[audio-session]], [[connection-and-pairing]], and [[protocol-conformance]] runs on
iOS 15. The keep-awake path exists partly so the app is usable before the Push to Talk entitlement
is granted, and it should not be quietly deleted once it is.

## Repository layout

```
ios/
├── .xcode-version                     Toolchain pin, read by CI.
├── README.md                          How to build, how to pair against a dev desktop.
├── ACappella.xcodeproj/               One project. No workspace: SPM needs no .xcworkspace.
├── ACappella/                         The app target. UI and platform glue only.
│   ├── ACappellaApp.swift             @main, scene setup, deep-link and PTT restoration entry.
│   ├── Info.plist                     Usage strings and NSBonjourServices; see below.
│   ├── ACappella.entitlements         push-to-talk, aps-environment.
│   ├── Screens/
│   │   ├── UnpairedScreen.swift       The real screen a reviewer sees first (app-store-review).
│   │   ├── PairingScreen.swift        QR scan, Bonjour list, manual host entry.
│   │   ├── SessionScreen.swift        Status strip, project wheel, talk button, live partial.
│   │   ├── TranscriptSheet.swift      The three-detent sheet.
│   │   └── KeepAwakeScreen.swift      Pure-black fallback background mode.
│   ├── Components/
│   │   ├── TalkButton.swift           Gesture down/up, states, VoiceOver announcements.
│   │   ├── ProjectWheel.swift         Snap-scrolling roster row.
│   │   ├── QualityIndicator.swift     Bars plus the path word ("Direct", "Relayed").
│   │   └── MicPill.swift              Off / Listening for wake word / Sending. Three states.
│   ├── Haptics/Haptics.swift          One place that owns every feedback generator.
│   └── Assets.xcassets/
├── Packages/
│   ├── ACappellaKit/                  The protocol. No UIKit, no AVFoundation, no WebRTC.
│   │   ├── Package.swift
│   │   ├── Sources/ACappellaKit/
│   │   │   ├── Generated/ProtocolConstants.swift   GENERATED. Do not hand-edit.
│   │   │   ├── Signaling/SignalingMessage.swift    Codable client and server messages.
│   │   │   ├── Signaling/SignalingSocket.swift     Protocol (the Swift kind). Injected.
│   │   │   ├── Device/DeviceMessage.swift          The ten data-channel messages.
│   │   │   ├── Device/DeviceCodec.swift            encode/decode, the `v` stamp, seq gaps.
│   │   │   ├── Device/SessionEvent.swift           The twenty voice events.
│   │   │   ├── Session/ClientState.swift           Phase, floor view, roster, transcript.
│   │   │   ├── Session/ACappellaClient.swift       The state machine. Everything injected.
│   │   │   ├── Session/Reconnection.swift          Backoff, terminal versus retryable.
│   │   │   └── Ports/                              PeerPort, MicrophonePort, Clock, TokenStore.
│   │   └── Tests/ACappellaKitTests/
│   │       ├── Fixtures/                           GENERATED golden frames. See below.
│   │       └── Conformance/                        Test names carry their C-nn.
│   ├── ACappellaAudio/                The adapters. WebRTC and AVFoundation live only here.
│   │   ├── Sources/ACappellaAudio/
│   │   │   ├── WebRTCPeer.swift                    PeerPort over RTCPeerConnection.
│   │   │   ├── AudioSessionController.swift        RTCAudioSession, category, mode, manual audio.
│   │   │   ├── RouteObserver.swift                 routeChange and interruption handling.
│   │   │   ├── OpusPreferences.swift               fmtp munging from RemoteAudioConfig.
│   │   │   ├── LevelMeter.swift                    audio-level source, floor-gated.
│   │   │   └── Ducking.swift                       Local VAD and the 20 ms attenuation.
│   │   └── Tests/ACappellaAudioTests/
│   ├── ACappellaTransport/            The other adapters: socket, discovery, Keychain.
│   │   ├── Sources/ACappellaTransport/
│   │   │   ├── URLSessionSignalingSocket.swift
│   │   │   ├── BonjourBrowser.swift                NWBrowser over _maestro._tcp.
│   │   │   ├── PairingPayload.swift                QR JSON parse and validation.
│   │   │   └── KeychainPairingStore.swift          TokenStore over kSecClassGenericPassword.
│   │   └── Tests/ACappellaTransportTests/
│   └── ACappellaWake/                 The one on-device model. Isolated so it can be removed.
│       ├── Sources/ACappellaWake/
│       │   ├── WakeWordDetector.swift
│       │   └── StopWordDetector.swift
│       └── Tests/ACappellaWakeTests/
└── Fastlane/ (optional)               Only if TestFlight uploads become manual toil.
```

Three rules the layout is enforcing, each of which is a lesson from the reference client:

- **`ACappellaKit` imports nothing.** Not UIKit, not AVFoundation, not WebRTC, not Network. It is
  the direct analogue of `client.ts`, which has no DOM in it, and it exists for the same reason:
  the protocol has to be testable on a machine with no microphone, no camera, and no phone. If a
  Swift file in `ACappellaKit` needs `import AVFoundation`, the thing it is doing belongs in
  `ACappellaAudio` behind a port.
- **Ports are protocols, and the app target owns the wiring.** `ACappellaClient` receives a
  `PeerPort`, a `MicrophonePort`, a `Clock`, and a `TokenStore`. In the app they are the WebRTC,
  AVFoundation, system, and Keychain implementations. In tests they are fakes. Nothing in
  `ACappellaKit` ever constructs one.
- **`ACappellaWake` is a separate package specifically so it can be cut.** It is the only thing in
  the app with a model file in it, it is the only thing that opens a microphone the desktop does
  not know about, and it is the most likely thing to be replaced. Isolating it means the answer to
  "what happens if the wake word ships later" is "remove one dependency", not "unpick it from the
  session code".

## Dependencies

| Dependency           | How                                                                 | Why, and what happens without it                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **WebRTC**           | Binary XCFramework via SPM, exact version pinned, checksum recorded | The entire media path. There is no first-party Apple or Google SPM package: Google's `GoogleWebRTC` CocoaPod has been unmaintained for years, so the practical choice is a maintained community XCFramework build. |
| **Push to Talk**     | System framework (`import PushToTalk`)                              | Background microphone. Entitlement-gated; see the signing section.                                                                                                                                                 |
| **AVFoundation**     | System                                                              | Audio session, and `AVCaptureMetadataOutput` for the QR scan.                                                                                                                                                      |
| **Network**          | System                                                              | `NWBrowser` for `_maestro._tcp` discovery.                                                                                                                                                                         |
| **Security**         | System                                                              | Keychain. See [[connection-and-pairing]] for the exact item attributes.                                                                                                                                            |
| **Wake-word engine** | Decided in the Swift effort, isolated in `ACappellaWake`            | Keyword spotting only. Whatever is chosen must run offline, be small, and never transmit. This is the one place a licence or a per-device fee can enter the project, so decide it with eyes open.                  |

**Explicit non-dependencies.** Each of these is a package someone will reach for, and each has a
reason not to be here:

- **No QR-scanning library.** `AVCaptureMetadataOutput` with `.qr` is about forty lines and reads
  the payload in [[connection-and-pairing]] directly. A scanning SDK is a camera permission story
  and a privacy manifest for something the OS already does.
- **No networking library.** Signaling is one WebSocket. `URLSessionWebSocketTask` is enough, and
  it is the only thing in the app that has to survive an OS behaviour change on backgrounding.
- **No analytics, crash, or attribution SDK in v1.** A microphone app whose privacy label says
  "no data collected" must be able to keep saying it. If crash reporting is added later, it goes
  through Apple's own organiser first, and the privacy label changes with it, deliberately.
- **No dependency injection, logging, or reactive framework.** Four packages and a state machine
  do not need one, and the reference client proves the protocol fits in one file with no framework
  at all.

**Third-party binary obligations.** Before the first submission, check the WebRTC XCFramework
against Apple's current rules for third-party SDKs: whether it appears on the commonly-used-SDK
list (which forces a privacy manifest and a signature), what required-reason APIs it touches, and
whether its own bundled dependencies are separately listed. Do not assume it is exempt because it
is a media library. If the shipped binary lacks what is required, the escape hatch is building
libwebrtc from source with a generated privacy manifest, which is a week of work and needs to be
discovered before the submission, not during it.

## Generated protocol constants, and generated fixtures

Two files in the tree above are marked GENERATED. Both exist because a hand-copied constant is a
protocol split into two disagreeing halves, and the disagreement is silent on the wire.

**`Generated/ProtocolConstants.swift`** is emitted by `scripts/generate-ios-protocol-constants.mjs`
from the TypeScript that already owns each value:

| Swift constant           | Source                                                                       |
| ------------------------ | ---------------------------------------------------------------------------- |
| `deviceProtocolVersion`  | `DEVICE_PROTOCOL_VERSION` in `src/shared/acappella/device-protocol.ts`       |
| `minSupportedVersion`    | `MIN_SUPPORTED_DEVICE_PROTOCOL_VERSION`, same file                           |
| `reliableChannelLabel`   | `RELIABLE_CHANNEL_LABEL` (`acappella-state`)                                 |
| `unreliableChannelLabel` | `UNRELIABLE_CHANNEL_LABEL` (`acappella-live`)                                |
| channel inits            | `RELIABLE_CHANNEL_INIT`, `UNRELIABLE_CHANNEL_INIT`                           |
| `defaultHoldThresholdMs` | `DEFAULT_HOLD_THRESHOLD_MS` and its 100 to 2000 clamp in `voice-controls.ts` |
| `defaultWakePhrase`      | `DEFAULT_WAKE_PHRASE`, `DEFAULT_STOP_PHRASE`, `FALLBACK_STOP_PHRASE`         |
| Bonjour service type     | `_maestro._tcp`, from `src/main/acappella/pairing/discovery.ts`              |

The generator runs in the iOS CI job and the job fails if the output differs from what is
committed. A drift is then a red build on the commit that caused it rather than a phone that
cannot open a data channel.

Note the difference between a default and a live value. `defaultHoldThresholdMs` is what the client
uses before it has heard from a desktop. The desktop's own value arrives in the `authenticated`
message and wins; see [[interaction-model]]. The constant exists so the two are the same number on
the first press, not so the client can decide the threshold.

**`Tests/ACappellaKitTests/Fixtures/`** holds golden frames exported by
`scripts/export-acappella-fixtures.mjs` from the conformance suite: one JSON file per message type,
byte-for-byte what the desktop encodes and what it accepts. The Swift tests decode them and encode
back. This is what catches an optional field that Swift's `Codable` silently drops, which is the
failure that looks exactly like a working client that does nothing.

## Mapping to the reference client

A Swift developer starting cold should read the reference client first and this table second. Every
row is a file that already exists and already runs.

| Swift                                  | Reference client                             |
| -------------------------------------- | -------------------------------------------- |
| `ACappellaKit`                         | `src/web-desktop/acappella-client/client.ts` |
| `ACappellaAudio`, `ACappellaTransport` | `src/web-desktop/acappella-client/main.ts`   |
| `Screens/`, `Components/`              | `src/web-desktop/acappella-client/ui.ts`     |
| `ACappellaKitTests/Conformance/`       | `src/__tests__/acappella/conformance/`       |
| `ProtocolConstants.swift`              | direct imports from `src/shared/acappella/`  |

Where the Swift and the reference client disagree, one of them is wrong, and
[[protocol-conformance]] decides which. There is exactly one sanctioned divergence, documented in
both places: the browser cannot keep the audio unit cold the way `RTCAudioSession.useManualAudio`
does, so it acquires and stops the track around the floor instead.

## Build configurations

| Configuration | Purpose                          | Push to Talk                                       | Distribution   |
| ------------- | -------------------------------- | -------------------------------------------------- | -------------- |
| `Debug`       | Simulator and device development | Off. `UIBackgroundModes: audio` allowed here ONLY. | Never archived |
| `Beta`        | TestFlight                       | On once the entitlement is granted                 | TestFlight     |
| `Release`     | App Store                        | On                                                 | App Store      |

The `Debug`-only background `audio` mode is the compromise in [[background-and-entitlements]]: it
lets protocol work happen with the screen off before the entitlement exists. It must be impossible
to archive. Put it in a `Debug`-only `Info.plist` fragment rather than behind an `#if DEBUG` in
Swift, because a plist key cannot be conditionally compiled and a reviewer reads the plist.

## Signing and capabilities

| Item              | Value                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Bundle identifier | `sh.maestro.acappella` (matches the Keychain `kSecAttrService` in [[connection-and-pairing]]) |
| Capabilities      | Push to Talk, Push Notifications, Background Modes (`push-to-talk` only)                      |
| Entitlements file | `ACappella/ACappella.entitlements`                                                            |
| Signing           | Automatic for `Debug`, manual with a committed profile name for `Beta` and `Release`          |

### The Push to Talk entitlement, and the ordering problem it creates

`com.apple.developer.push-to-talk` is a **restricted entitlement**. It is requested through Apple's
form, it is reviewed by a human, and until it is granted the identifier cannot carry it, which
means the provisioning profile cannot carry it, which means a build that declares it will not sign.

That is a schedule constraint, not a paperwork detail:

1. **Request the entitlement on day one of the Swift effort.** It is the longest-lead item in the
   project and everything else can be built while it is pending.
2. Build against the keep-awake path in the meantime. It needs no entitlement and no review
   conversation, and it has to exist in the shipped app anyway.
3. When the grant arrives, add the capability to the identifier, regenerate the `Beta` and
   `Release` profiles, and flip the configuration. Nothing else changes: the PTT channel manager
   drives the same `floor` messages the button does.

The request text should say what the app is in one sentence and then answer the question the
reviewer is actually asking, which is whether this is a walkie-talkie or a background recorder. The
answer is in [[app-store-review]] and the entitlement request should reuse its wording rather than
inventing a second description of the same app.

Push Notifications is required because the Push to Talk framework delivers channel activity over
PushKit. `aps-environment` is `development` in `Debug` and `production` in `Beta` and `Release`.
The app sends no other push and must not acquire a notification permission prompt it does not need.

### TestFlight

- **Internal testers first**, which needs no beta review and is where the pairing flow gets its
  real-network testing. A simulator cannot scan a QR code from a real screen and cannot join a
  Bluetooth headset, and both of those are where this app breaks.
- **External testing needs beta app review**, and that review hits the same wall as the App Store
  review does: the app does nothing without a paired Mac. Have the demo desktop and the demo video
  from [[app-store-review]] ready before the first external build, not after it is rejected.
- **Build numbers are monotonic and generated**, not typed. Marketing version tracks the desktop's
  minor version so a support conversation can compare them.
- **Export compliance is a real question, not a checkbox.** The app encrypts: DTLS-SRTP inside
  WebRTC and TLS on the signaling socket. Whether that qualifies for the standard-algorithms
  exemption depends on the third-party binary as much as on our own code. Decide it once, in
  writing, with someone qualified to answer, and record the answer next to the `Info.plist` key
  rather than re-guessing at each submission.

## Continuous integration

One workflow, `.github/workflows/ios.yml`, on a macOS runner, gated on `ios/**` and
`src/shared/acappella/**`:

1. `node scripts/generate-ios-protocol-constants.mjs --check` and the fixture equivalent. Fail on
   any diff against what is committed.
2. Build `ACappella` for the simulator.
3. `swift test` on `ACappellaKit`, `ACappellaTransport`, and `ACappellaWake`. These need no
   simulator and no device, which is the payoff of the import rules above.
4. `xcodebuild test` for `ACappellaAudio`, which does need a simulator.

The existing Node matrix in `.github/workflows/ci.yml` stays exactly as it is. An iOS build must
never be able to make `test (ubuntu-latest)` or `test (windows-latest)` slower or redder.

## Non-goals

The first Swift effort ships a remote microphone and speaker. These are the things it will be
tempted to build, and each one is a way to turn a two-month project into a year.

**Not building, ever, because the desktop already decides it:**

- **No on-device speech recognition, routing, or text-to-speech.** No `SFSpeechRecognizer`, no
  `AVSpeechSynthesizer`, no LLM, no summariser. `NSSpeechRecognitionUsageDescription` must not
  appear in `Info.plist`. The single exception is the wake and stop keyword spotter in
  `ACappellaWake`, which classifies one phrase and transmits nothing; it is not a recogniser and
  must not be allowed to become one.
- **No agent management.** No creating, deleting, renaming, or reconfiguring agents. No running
  commands. No file browsing. The project wheel is a picker over a roster the desktop sent, and
  selecting an item changes the scope of the next press and nothing else.
- **No settings that duplicate desktop settings.** Provider choice, model downloads, TTS voice and
  rate, hold threshold, wake phrase text, idle timeout: all of these live on the desktop and arrive
  over the wire. The phone's settings screen holds exactly what is about this phone: which desktop
  is paired, whether the wake word is armed, whether keep-awake is on, and the output route. If a
  setting can be answered by "what did the desktop say", it is not a phone setting.
- **No local conversation history.** The transcript sheet renders the current session from the
  events that arrived and is gone when the session ends. History lives on the desktop, which is
  where it can be searched, and where it is already backed up.

**Not in v1, deferred deliberately:**

- Multiple simultaneous desktops. Store several pairings, connect to one at a time.
- Apple Watch, macOS, visionOS, and CarPlay targets. CarPlay in particular is called out as a
  do-not-ship in [[audio-session]] for reasons that outlast v1.
- Siri and App Intents. The wake word covers the same ground without an entitlement conversation.
- An iPad-specific layout, widgets, Live Activities, and Focus filters.
- Any account, sign-in, or server of our own. The pairing token is the only credential the app has
  and there is nothing to log into.

If a feature request cannot be phrased as "the microphone, the speaker, or the button", the answer
is that it belongs on the desktop. That is the whole thesis of [[overview]], and this list is what
it looks like when it is enforced.

## Related

- [[overview]] for what the app is and, more usefully, what it is not.
- [[protocol-conformance]] for the wire behaviour every one of these packages exists to implement.
- [[background-and-entitlements]] for why the deployment target is 16.0 and why the entitlement is
  the critical-path item.
- [[app-store-review]] for the submission material the TestFlight external build needs first.
- `src/web-desktop/acappella-client/README.md` for the endpoint this project is a port of.
