---
type: reference
title: A Cappella Wake Word, Stop Word, and Hotkeys
created: 2026-08-15
tags:
  - acappella
  - architecture
  - wake-word
  - hotkeys
related:
  - '[[system-overview]]'
  - '[[voice-session-protocol]]'
  - '[[model-manager]]'
---

# Wake Word, Stop Word, and the Global Hotkey Registry

Three ways to open the floor, and one way to shut it.

| Surface                      | Opens                              | Steals focus | Lives in                                  |
| ---------------------------- | ---------------------------------- | ------------ | ----------------------------------------- |
| Wake word (global phrase)    | Conductor-scoped session           | No           | `main/acappella/wake/wake-detector.ts`    |
| Wake word (per-agent phrase) | Session bound to that agent        | No           | same                                      |
| `voiceConductor` hotkey      | Conductor-scoped session           | No           | `main/acappella/hotkeys/voice-hotkeys.ts` |
| `voiceCurrentAgent` hotkey   | Session bound to the focused agent | Yes          | same                                      |
| Stop word                    | Nothing - it ENDS the session      | No           | `main/acappella/wake/stop-word.ts`        |

Every one of them routes through `audio/floor-control.ts`. That module already
owns what a second press means, what a release means, and when an untouched
microphone goes cold. Four surfaces re-deriving any of it would drift inside a
week.

## The privacy invariant

**While only the wake detector is running, no audio frame reaches a hosted
provider or leaves the process.** This holds whether the user picked Whisper or
OpenAI for speech-to-text, and it is not a preference.

It is enforced structurally rather than by discipline:

- `WakePhraseScorer.tier` is the string literal `'local'`, not a
  `VoiceProviderTier`. A cloud provider's tier is `'cloud'`, so a hosted scorer
  is not assignable and the mistake is a type error.
- `assertWakeScorerLocal()` re-checks at runtime, for anything that arrives
  through a cast or across an IPC boundary.
- `WakeDetector` has exactly ONE outward edge, `onWake`. It never sees a
  provider, never holds a socket, and cannot be handed one.
- `wake-detector.test.ts` feeds 200 frames past a hosted STT spy and a `fetch`
  spy with neither called.

## Wake word

openWakeWord on `onnxruntime-node`, loaded through `native-loader.ts`. The chain
is melspectrogram -> embedding -> one small classifier per phrase, and the
detector's contract with the scorer is one 80 ms hop (1280 samples at 16 kHz) in,
a score per phrase id out.

`createOnnxWakeScorer()` returns null when the runtime or the model files are
missing, which is the ordinary state of a machine that has not opted into
hands-free. The detector then runs INERT and says so; the capability gate is
where a missing model becomes a sentence the user can act on.

Three orchestration properties the model does not provide:

- **Per-phrase sensitivity.** A two-syllable agent name and "hey maestro" do not
  false-fire at the same threshold. The score has to clear `1 - sensitivity`.
- **Debounce.** One spoken phrase clears the threshold over several consecutive
  windows; without a debounce each would be a session.
- **Pre-roll.** The `WakeDetection` carries the audio around the phrase, drained
  from the ring, so "Maestro, what's the status" does not reach the recogniser as
  "...what's the status". Wire the detector to the AUDIO PIPELINE's ring so there
  is one buffer rather than two.

### A phrase the user records themselves

openWakeWord's classifiers are trained on thousands of synthetic clips per
phrase, so only shipped phrases have one. A phrase of the user's own is handled
by ENROLLMENT: about 20 recordings of the phrase and 30 seconds of other speech,
recorded in Voice Controls or brought as WAV files by `maestro-cli voice wake`.

The classifier slot in the chain is then filled by a matcher instead of a graph.
Both satisfy the same internal `WakeClassifier` (a classifier window in, a score
from 0 to 1 out), so the scorer, the detector, debounce and the sensitivity
slider do not know which they hold.

```
audio -> mel -> embedding -> [ pretrained ONNX classifier | enrolled matcher ] -> score
         \__ wake-front-end.ts __/
```

The matcher is nearest-example, not a trained head. A logistic or MLP head
fitted to a user-sized data set learns "is not the 30 seconds of other speech I
was shown" and fires on the first sentence it has not heard. On four synthetic
voices it produced three to six times the false alarms of the matcher at the
same recall. What a small data set supports is: keep every recording as an
example, several times over with pace, level, noise and preceding speech varied;
score live audio by cosine similarity to the nearest example in the embedding
space; and use the other speech only to find the threshold.

| Step      | What happens                                                                                                           | Where                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Segment   | Each burst of speech becomes one recording. No button per take.                                                        | `speech-burst.ts`        |
| Examples  | Each recording, as recorded and five varied copies, through the SAME front end stream the live scorer uses.            | `wake-trainer.ts`        |
| Weighting | Each compared frame counts by how much of its 760 ms the phrase accounts for, so preceding speech does not decide it.  | `wakeFrameWeights()`     |
| Outliers  | A recording unlike the rest (a cough the detector took for the phrase) is left out.                                    | `wake-trainer.ts`        |
| Threshold | Each recording scored against the OTHERS; the other speech scored against all. 0.5 sits between, biased to recordings. | `wake-trainer.ts`        |
| Score     | Per hop: centre, normalise, dot with every example, logistic. A few hundred thousand multiply-adds.                    | `enrolled-wake-model.ts` |

An enrolled phrase outranks a pretrained one for the same words, in the scorer
and in the capability gate alike. Retraining bumps `trainedAt`, which is part of
the always-on listener's arm key, so the armed detector is replaced.

The recordings are kept (`userData/acappella/wake-phrases/<key>/`) because they
are the only thing a model can be rebuilt from. They never leave the machine,
and deleting the phrase deletes them, with voice switched on or off.

## Stop word versus barge-in

The single most important distinction in this subsystem.

|                | Barge-in                               | Stop word     |
| -------------- | -------------------------------------- | ------------- |
| Means          | "stop talking, I am still here"        | "we are done" |
| Speech         | cancelled                              | cancelled     |
| Floor          | KEPT                                   | released      |
| Microphone     | stays open                             | closed        |
| Terminal state | `speaking -> interrupted -> listening` | `-> idle`     |
| Event          | `barge-in`                             | `stop-word`   |

They are separate modules, separate events, separate settings, and separate HUD
feedback, because every assistant that folded them together became one you cannot
get rid of. `StopWordController` is handed a session interface with `hardStop`
and deliberately WITHOUT `interrupt`, so it cannot reach barge-in even by
accident.

The stop word runs on the local detector specifically because it must be heard
while TTS is speaking and while a cloud STT stream is open. It cannot depend on a
transcript coming back from a remote engine: the answer would arrive after the
thing it was meant to stop had finished.

`armedPhrases(state, ...)` is the arming rule: wake phrases while the session is
cold, stop phrases in every active state. Never both, or a wake phrase spoken
mid-answer would stack a second session.

## The global hotkey registry

`src/main/global-hotkey-manager.ts` was one deliberate singleton for "show
Maestro". It is now a `GlobalHotkeyRegistry` keyed by id, because with three
hotkeys a shared failure path would mean losing "show Maestro" over a bad voice
combo.

Failure kinds, distinguished because the user's next move differs:

- `invalid-accelerator` - the combo has no non-modifier key.
- `maestro-conflict` - two Maestro hotkeys want the same combo. Detected here and
  NAMED; left to Electron the second registration silently wins or loses by
  platform.
- `os-conflict` - another application owns it.
- `register-error` - `globalShortcut.register` threw.

Failures reach the renderer on `globalHotkey:registrationFailed`, now carrying
the whole `GlobalHotkeyStatus` (id included) rather than a bare key array. The
definitions - ids, labels, and defaults - live in `src/shared/global-hotkeys.ts`,
which both `DEFAULT_SHORTCUTS` and the main-process registry read, so a hotkey the
Settings list and the registry spelled differently cannot exist.

## Tap versus hold

Electron's `globalShortcut` fires on PRESS and never on release. `press-hold.ts`
turns one press callback into tap / hold-start / hold-end by polling a key-state
probe.

**Today every platform returns null and the hotkeys report `tap-only`.** There is
no way to read live key state from Electron's own API: macOS needs
`CGEventSourceKeyState`, Windows `GetAsyncKeyState`, X11 `XQueryKeymap`, and all
three mean a native module Maestro does not ship. Auto-repeat timing is not a
substitute - the OS repeat delay is longer than any usable hold threshold.

Rather than fake it, the detector says so: `describePressHoldCapability()` is
rendered in the Voice Controls settings. A push-to-talk key that silently behaves
like a toggle is a bug users blame themselves for.

The seam is real, not decorative. `setKeyStateProbe()` is what a native module
plugs into, and it is how both branches are tested. Surfaces that DO have a real
release event - the HUD button, the Phase 10 phone button - never come through
here; they call `FloorController.press()`/`release()` directly.

## Settings

Everything except the two key bindings lives under `controls` in the one
`acappella` settings blob (`useVoiceControls`, read back by
`readVoiceControlSettings()` in main). The bindings live in the ordinary
`shortcuts` map, so the Shortcuts tab and the Voice Controls panel are two views
of one value rather than two values that can disagree.

The Voice Controls panel shows each hotkey's REAL registration state inline, and
a Test button runs the wake detector with no session behind it so sensitivity can
be tuned by saying the phrase instead of by guessing.

## Files

| File                                                                | Owns                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| `src/shared/global-hotkeys.ts`                                      | Hotkey ids, labels, defaults, status shape                      |
| `src/shared/acappella/voice-controls.ts`                            | Shipped phrases and timing numbers, both processes              |
| `src/main/global-hotkey-manager.ts`                                 | `GlobalHotkeyRegistry`                                          |
| `src/main/acappella/hotkeys/press-hold.ts`                          | Tap vs hold classification                                      |
| `src/main/acappella/hotkeys/voice-hotkeys.ts`                       | The two hotkeys' semantics                                      |
| `src/main/acappella/hotkeys/index.ts`                               | Electron / settings wiring                                      |
| `src/main/acappella/wake/wake-detector.ts`                          | openWakeWord detector and the ONNX scorer                       |
| `src/main/acappella/wake/stop-word.ts`                              | Stop phrases, arming rule, teardown                             |
| `src/main/acappella/wake/wake-front-end.ts`                         | The mel and embedding stream both scorers and the trainer share |
| `src/main/acappella/wake/wake-enrollment-service.ts`                | Recording, training, and the one request entry point            |
| `src/main/acappella/wake/wake-trainer.ts`                           | Recordings in, matcher out                                      |
| `src/main/acappella/wake/enrolled-wake-model.ts`                    | The matcher's model and scoring                                 |
| `src/main/acappella/wake/wake-enrollment-store.ts`                  | Recordings and models on disk                                   |
| `src/shared/acappella/wake-enrollment.ts`                           | Limits, naming, wire types, both processes                      |
| `src/renderer/components/Settings/ACappella/VoiceControlsPanel.tsx` | The settings surface                                            |
