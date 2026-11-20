---
type: specification
title: App Store Review
created: 2026-08-14
tags:
  - ios
  - voice
  - acappella
related:
  - '[[overview]]'
  - '[[background-and-entitlements]]'
  - '[[connection-and-pairing]]'
  - '[[project-structure]]'
---

# App Store Review

Three things about this app make review harder than the code does: it asks for the microphone, it
asks for a restricted entitlement, and it does nothing at all without a Mac the reviewer does not
have. Each has a specific answer, and each answer has to exist before the first submission rather
than after the first rejection.

## Usage description copy

These strings are read by a human in a permission dialog at the moment they decide whether to
trust the app. Write them as answers to "why", not as restatements of "what".

### Microphone

```
NSMicrophoneUsageDescription
```

> Maestro sends your voice to the computer you paired with, so you can talk to your agents from
> across the room. Audio is captured only while you are holding the talk button.

Why each half is there:

- **"the computer you paired with"** names the destination. A microphone prompt that does not say
  where the audio goes is the prompt people deny.
- **"only while you are holding the talk button"** is a commitment the code keeps
  (see [[audio-session]]) and the OS enforces on the Push to Talk path
  (see [[background-and-entitlements]]). Do not write it unless both remain true.

If the wake word ships enabled in a build, the second sentence has to change to include it, and
the wake-word toggle itself must carry the longer explanation. A usage string that describes a
narrower behaviour than the app performs is a 5.1.1 rejection and, worse, is a lie.

### Camera

```
NSCameraUsageDescription
```

> Maestro scans the pairing code shown on your computer. The camera is used only for that scan.

### Local network

```
NSLocalNetworkUsageDescription
```

> Maestro finds your computer on this network so you can pair without typing an address.

The local-network prompt is the one users find most alarming, because iOS presents it in stark
terms. Two mitigations, both worth building:

- **Do not trigger it at launch.** Ask only when the user taps "Find my Mac", so the prompt arrives
  attached to an action they just took.
- **Offer the QR path first**, which needs no local-network permission at all. A user who scans a
  code never sees the prompt.

### Speech recognition

**Not requested.** `NSSpeechRecognitionUsageDescription` must not appear in `Info.plist`. There is
no on-device Apple speech recognition in this app: the desktop transcribes. Requesting a permission
the app does not use is both a rejection risk and a privacy claim we do not need to make.

## Privacy nutrition labels

The honest position, which also happens to be the simplest label:

| Data type                                     | Collected? | Notes                                                                                                                                                                              |
| --------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audio Data                                    | **No**     | Audio is sent peer to peer to the user's own paired computer over an encrypted WebRTC connection. It is not sent to Maestro's servers and it is not retained anywhere by this app. |
| Identifiers                                   | **No**     | The device name and a device identifier are sent to the paired computer only, and stored only on that computer.                                                                    |
| Usage Data, Diagnostics                       | **No**     | v1 ships with no analytics SDK and no crash reporter. See below.                                                                                                                   |
| Contacts, Location, Photos, Health, Financial | **No**     | Not accessed.                                                                                                                                                                      |

Two places this needs care:

**The TURN relay.** If a build ships with a default TURN server operated by us, encrypted media
packets transit it when a direct path cannot be established. That is a transient relay of
end-to-end encrypted data that is not retained and not readable by the operator, which does not
meet Apple's definition of collection (transmitting off device in a way that allows access for
longer than necessary to service the request in real time). It is still worth a sentence in the
privacy policy, and the app already tells the user when it is happening: the connection indicator
says "Relayed" in words (see [[connection-and-pairing]]).

**The desktop's providers.** A user can configure the desktop to transcribe with OpenAI or speak
with ElevenLabs. In that configuration the user's audio does reach a third party. That happens on
the user's own machine, under settings the user set there, and the desktop states it in one
sentence computed from the live configuration (`mic-state.egressStatement`, never hard-coded copy).
The iOS app must:

- **Display that sentence verbatim** on its paired-device sheet, so a phone user can see where
  their audio goes without walking to the desk.
- **Not claim in its own privacy label that it sends audio to third parties**, because it does not.
  It sends audio to one computer. What that computer does next is that computer's disclosure, and
  it makes it.

**Analytics.** Ship v1 with none. It turns the entire label into "Data Not Collected", which is
worth more than the funnel data would be, and it removes a whole class of review questions. If a
crash reporter is added later, it becomes "Diagnostics, not linked to identity, app functionality",
and this document gets updated in the same commit.

## The reviewer problem

**The app is useless without a paired desktop.** A reviewer who installs it and opens it sees a
pairing screen and can go no further. Left unaddressed, that is a Guideline 2.1 rejection
(App Completeness) and possibly a 4.2 one (Minimum Functionality).

Four things, in the order they matter.

### 1. Make the unpaired state a real screen

The first launch experience must be worth reading even for someone with no Mac:

- One screen explaining what the app is: a remote microphone for Maestro on your computer.
- The three ways to connect, with the QR path first.
- A link to the Maestro documentation and to the desktop download.
- **No dead ends.** Never a spinner, never a blank list, never a "connect to continue" wall with
  nothing behind it.

An app that explains itself clearly to someone who cannot use it is not an incomplete app. It is a
companion app, which is a category Apple accepts, and the screen is what makes that legible.

### 2. Provide a live demo desktop

The best outcome is a reviewer who actually uses the app. Provide it:

- Run a Mac with Maestro and A Cappella enabled, reachable over the internet through the TURN
  relay, with two or three agents in the roster doing recognisable work.
- In App Review Information, include a **pairing QR image** and the six-character code, plus the
  host and port for manual entry as a fallback.
- The demo desktop runs with pairing auto-approval enabled for the review window, because the
  approval step needs a human at the desk and there will not be one at 03:00 in Cupertino.
- **Disclose the auto-approval in the review notes.** It is a configuration of the demo machine,
  not a hidden feature of the app, and saying so is what keeps it from looking like one under
  Guideline 2.3.1.
- Rotate the credentials and turn the demo machine off after the review.

### 3. Provide a demo video regardless

Networks fail, review happens at odd hours, and a demo desktop that is asleep is worse than none.
Attach a video, 60 to 90 seconds, screen recording of the phone with the Mac visible:

1. Scan the QR code, approve on the Mac, connected.
2. The project wheel populates with real agents.
3. Hold the button, say "open a tab on the backend agent about the auth refactor".
4. The tab appears on the Mac. The reply is spoken on the phone.
5. Talk over the reply; it stops mid-sentence.
6. Say the stop word; the session ends.
7. Lock the phone, transmit from the Push to Talk system control, show it still works.

Step 7 exists for the entitlement reviewer specifically, and it is the one to lead with in the
notes when the Push to Talk entitlement is under review.

### 4. Write the review notes as if the reviewer has five minutes

```
WHAT THIS APP IS
Maestro is a desktop app for macOS and Windows that runs AI coding agents. This iOS app is a
remote microphone and speaker for it: you talk to your computer from across the room. It does
not run any AI on the phone and it requires a paired computer.

HOW TO TEST IT (demo computer provided)
1. Open the app, tap Scan.
2. Scan the attached QR image (also: code 7K2MBX, host <host>, port <port>).
3. The demo computer auto-approves during this review window (a configuration of our demo
   machine, not a feature of the app; a normal user approves each device by hand).
4. Hold the large Talk button and say: "what are you working on".
5. The reply is spoken back on the phone. Tap the button while it speaks to interrupt.

PERMISSIONS
Microphone: audio is sent over an encrypted WebRTC connection to the paired computer only.
Camera: pairing QR scan only.
Local network: optional Bonjour discovery, only after the user taps "Find my Mac".

PUSH TO TALK ENTITLEMENT
Used for its designed purpose. The user joins a channel for their paired computer, transmits
while holding the button or the system control, and the microphone is closed at all other times.
See the attached video from 0:52.
```

## Other review surface

- **Guideline 4.2 (Minimum Functionality).** The counter-argument is that this is a companion app
  to a shipping desktop product with real users, in the same category as a remote or a companion
  for hardware. The unpaired-state screen from step 1 is the evidence. Have a link to
  https://maestro.sh and the docs in the notes.
- **Guideline 2.5.4 (background audio).** Only relevant if a build declares `UIBackgroundModes:
audio`. It should not. See [[background-and-entitlements]].
- **Guideline 5.1.5 (location).** Not applicable; no location APIs.
- **Age rating.** 4+. No user-generated content is displayed by the app itself, and the agent
  replies are the user's own machine talking to them.
- **Account requirement.** None. Guideline 5.1.1(v) is satisfied trivially: there is no sign-in, no
  email collected, and no account to delete. Say so in the notes so nobody looks for one.
- **Export compliance.** The app uses DTLS-SRTP through WebRTC and TLS for signaling. Confirm the
  exemption applies to that use before setting `ITSAppUsesNonExemptEncryption` to `false`, and file
  the self-classification report if it does not. Do not copy the flag from another project.
- **Privacy policy URL.** Required because a permission-gated microphone is involved. It must
  contain the same two claims this document makes: audio goes to the user's paired computer, and
  onward only to the provider the user configured on that computer.

## Submission checklist

- [ ] `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`, `NSLocalNetworkUsageDescription`
      present, and each matches the copy above.
- [ ] `NSSpeechRecognitionUsageDescription` **absent**.
- [ ] `NSBonjourServices` contains `_maestro._tcp`.
- [ ] `UIBackgroundModes` contains `push-to-talk` and **not** `audio`.
- [ ] `com.apple.developer.push-to-talk` granted and present in the provisioning profile.
- [ ] Privacy nutrition labels filled in as "Data Not Collected", matching the analytics decision
      actually shipped in this build.
- [ ] Privacy policy URL live and containing the two audio-destination claims.
- [ ] Demo desktop running, auto-approval on, credentials fresh, disclosed in the notes.
- [ ] Demo video attached, including the locked-screen Push to Talk segment.
- [ ] Review notes pasted, with the QR image attached.
- [ ] Unpaired first-launch screen reachable with no network at all, and useful there.
- [ ] Export compliance answered deliberately rather than copied.
