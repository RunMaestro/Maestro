---
type: reference
title: A Cappella Latency Baseline
created: 2026-08-15
tags:
  - acappella
  - architecture
  - latency
  - providers
related:
  - '[[system-overview]]'
  - '[[model-manager]]'
  - '[[voice-session-protocol]]'
  - '[[conversation-acceptance]]'
---

# A Cappella Latency Baseline

Voice is the one Maestro surface where latency is not a quality-of-life detail. A user talking to
an agent has no screen to read while they wait, so a slow turn is indistinguishable from a broken
one. This document records what each provider configuration costs per hop, how those numbers are
measured, and which hop to suspect first when someone reports that voice feels slow.

## How a turn is measured

Every turn is timed by `src/main/acappella/telemetry/turn-metrics.ts`. The zero point is the
moment the voice activity detector decides the user stopped talking, published by the audio
pipeline as `onSpeechEnd`. That point matters: a timer anchored on the transcript would exclude the
decode, which is exactly the hop most often to blame.

Six milestones are stamped per turn:

| Span                            | What it measures                                                       |
| ------------------------------- | ---------------------------------------------------------------------- |
| **Speech end to first partial** | How long before anything at all appears. The gap the user feels most.  |
| **Final transcript**            | Endpointing to a settled utterance.                                    |
| **Route decision**              | Brain latency: which agent, which tab, which prompt.                   |
| **Agent first token**           | Dispatch to the agent producing text. Not ours, but it is in the turn. |
| **First spoken sentence**       | Reply text to the first audible sentence.                              |
| **Total turn**                  | Speech end to first audible sentence.                                  |

Spans are recorded cumulatively (one subtraction per mark, which is all a hot path should do) and
converted to per-hop deltas for display. They are formatted with `formatDuration()` from
`src/shared/performance-metrics.ts`; there is no second duration helper.

The last twenty turns are retained in memory. The most recent breakdown is readable from
**Settings > Plugins > A Cappella > Models > Turn latency**, with a Copy button, so a bug report
carries numbers rather than an adjective.

## Configurations

Four shapes, in the order a user is likely to try them.

### 1. Fully local (Whisper, Qwen3, Kokoro)

Audio never leaves the machine. Every hop is CPU or GPU work on the user's hardware, so the numbers
vary by an order of magnitude across machines and this configuration is the one worth measuring on
the oldest machine you can find rather than the newest.

### 2. OpenAI STT, local Brain, ElevenLabs TTS

The mixed case. Two network hops and one local inference. Usually the fastest cascade on a laptop,
because a hosted transcription of a short utterance beats a local decode on a CPU without an
accelerator.

### 3. Fully hosted cascade (OpenAI STT, OpenAI Brain, ElevenLabs TTS)

Three network hops in series. Predictable, and bounded by the slowest provider on the day.

### 4. Realtime (OpenAI speech to speech)

One socket, the provider's own endpointing, and no serial hops at all. The tradeoff is stated in
the settings copy where the choice is made: the assistant speaks in that provider's voice, and the
microphone's samples go to their servers.

## Measured results

**Not yet measured. This table is deliberately empty rather than filled with plausible numbers.**

Recording it requires four things this phase did not have on the build machine: the three native
runtimes installed (they are declared in `src/shared/acappella/native-runtimes.ts` but not yet in
`package.json` dependencies, see [[packaging-notes]]), the model set downloaded, API keys for
OpenAI and ElevenLabs, and a microphone. Inventing a baseline would be worse than having none: the
whole purpose of this document is to be the thing a regression is measured against.

| Configuration            | First partial | Final | Route | Agent first token | First spoken sentence | Total |
| ------------------------ | ------------- | ----- | ----- | ----------------- | --------------------- | ----- |
| Fully local              | -             | -     | -     | -                 | -                     | -     |
| OpenAI STT + local Brain | -             | -     | -     | -                 | -                     | -     |
| Fully hosted cascade     | -             | -     | -     | -                 | -                     | -     |
| Realtime                 | -             | -     | -     | -                 | -                     | -     |

To fill it in: enable the Encore Feature, configure the slots in **Voice Providers**, speak one
short instruction ("ask backend what changed"), then press **Read last turn** on the Models page
and paste the copied JSON into the row. Repeat three times per configuration and record the median,
because the first turn of a local configuration includes the model load and is not representative
of a conversation.

The by-hand pass that produces these numbers, including what to say and what to listen for on each
check, is [[conversation-acceptance]]. Read its precondition section first: a session built without
an `agentReplyStream` still waits for a whole reply, which measures the `buffered` arm below rather
than the streamed one.

## What each hop tells you

- **First partial is slow, local STT.** The decode is CPU-bound. Check whether the machine has an
  accelerator whisper.cpp can use, and check the partial interval: re-transcribing the whole
  utterance every 900 ms is the design, and on a slow machine each pass takes longer than the
  interval, so passes are skipped rather than queued.
- **First partial is slow, hosted STT.** Network, or the utterance was long. The upload happens on
  endpointing, so a long utterance costs upload time no partial can hide.
- **Route decision is slow, local Brain.** Almost always a model load: the Qwen3 context unloads
  after five idle minutes, and the next turn pays for it once. Two consecutive turns will show the
  difference immediately.
- **Route decision is slow, hosted Brain.** Look for a retry. The transport backs off on 429 and
  5xx up to three attempts, which can add seconds; the `provider-quota-exceeded` session error
  fires only after the last attempt.
- **First spoken sentence is slow.** The TTS provider is synthesising the whole first sentence
  before any audio exists. Both real providers work sentence by sentence for exactly this reason,
  so a long first sentence is the usual cause.
- **Total is fine but it FEELS slow.** Check barge-in rather than latency. Cutting the assistant
  off has to be instant, and a cancel that waits out a sentence reads as lag even when every number
  above is good.

## Time to first spoken word

The number a user actually feels is not the total turn: it is how long they stand in silence before
anything is said. Everything in `src/main/acappella/speech/` exists to shorten that one span, and it
is measured as `speak-sentence` index 0 minus the detector's speech end, which is the
**First spoken sentence** column above.

Three mechanisms move it, in descending order of effect:

1. **The agent output tap cuts at a completed thought, not at the end of the reply.** A four hundred
   line summary is spoken from its first paragraph while the agent is still writing the rest. This
   is worth more than every other optimisation combined, because it removes the agent's own write
   time from the span rather than shaving a hop.
2. **The translator rewrites that piece alone.** One short rewrite instead of one long one, and a
   reply that is already conversational ("yes, the tests pass") skips the model entirely.
   `ConversationalTranslator.stats` reports the translations-to-passthroughs split, which is the
   number to check when short answers feel slower than they should.
3. **The scheduler synthesizes one sentence ahead of the one being delivered.** This does not shorten
   the first word; it removes the provider round trip that would otherwise fall between every pair
   of sentences. A reply that starts fast and then stutters is this, not the tap.

### Measurements

Two instruments, because they answer different questions and neither replaces the other.

**The harness** (`npm run acappella:latency`) measures the span this layer owns, with the providers
replaced by stubs whose costs are declared in the script. It exists because a microphone session
measures four things at once - the decode, the model on the day, the network on the day, and the
streaming layer - and only the last of those is ours to regress. Everything between the stubs is the
shipping code: `AgentOutputTap`, `ConversationalTranslator`, `SpeechScheduler`, and the splitter.
Each fixture runs twice: `streamed` is the shipped path, `buffered` is the counterfactual the layer
replaced (wait for the whole reply, rewrite the whole thing, then speak). The agent writes at the
same rate in both arms, so the difference between them is the tap and nothing else.

Recorded 2026-08-15, one run per cell, zero point the agent's first token. **First sound** and
**first word of the answer** are different numbers on a long reply: the buffered arm makes a noise at
twenty seconds because the tap refuses to go silent and says the agent is still working, which is the
safety net firing rather than an answer arriving.

| Profile | Fixture      | Arm      | First sound | First word of the answer | Longest mid-turn silence |
| ------- | ------------ | -------- | ----------- | ------------------------ | ------------------------ |
| local   | long summary | streamed | 220 ms      | 220 ms                   | 0 ms                     |
| local   | long summary | buffered | 20221 ms    | 33734 ms                 | 11227 ms                 |
| local   | diff-heavy   | streamed | 226 ms      | 226 ms                   | 11903 ms                 |
| local   | diff-heavy   | buffered | 14248 ms    | 14248 ms                 | 0 ms                     |
| local   | confirmation | streamed | 206 ms      | 206 ms                   | 0 ms                     |
| local   | confirmation | buffered | 206 ms      | 206 ms                   | 0 ms                     |
| hosted  | long summary | streamed | 280 ms      | 280 ms                   | 0 ms                     |
| hosted  | long summary | buffered | 20283 ms    | 33795 ms                 | 11226 ms                 |
| hosted  | diff-heavy   | streamed | 284 ms      | 284 ms                   | 12061 ms                 |
| hosted  | diff-heavy   | buffered | 14307 ms    | 14307 ms                 | 0 ms                     |
| hosted  | confirmation | streamed | 271 ms      | 271 ms                   | 0 ms                     |
| hosted  | confirmation | buffered | 275 ms      | 275 ms                   | 0 ms                     |

Three things to read out of it:

- **The tap is worth 33 seconds on a long reply and 14 on a diff-heavy one.** That is the whole
  argument for the layer, and it is not a hop that was shaved - it is the agent's own write time
  removed from the span. Both profiles land within 60 ms of each other on the streamed arm, which is
  the point: once the first spoken word costs one short rewrite, the choice of provider stops
  mattering to the number the user feels.
- **A one-line confirmation is identical in both arms.** No model hop, because the passthrough test
  catches it. If that row ever shows the streamed arm slower, the passthrough stopped firing.
- **The diff-heavy streamed row has a 12 second silence in the middle of the turn.** The intro line
  is spoken at 226 ms, the fence is correctly never spoken, and nothing is said again until the
  closing prose. The hang notice does not cover it, because the diff keeps arriving as `data` and
  keeps resetting the timer. Nothing here is behaving incorrectly, and it is still the worst listening
  experience the harness produces - the thing to watch if a user reports the assistant "stopping
  halfway".

**The real pipeline**, which the harness deliberately does not stand in for. Record the median of
three turns per configuration with one short instruction ("ask backend what changed"), taken from
**Settings > Plugins > A Cappella > Models > Turn latency**. Zero point is the detector's speech end,
so these include the decode and the route that the harness excludes.

| Configuration        | Time to first spoken word | Inter-sentence gap | Notes |
| -------------------- | ------------------------- | ------------------ | ----- |
| Fully local cascade  | -                         | -                  | -     |
| Fully hosted cascade | -                         | -                  | -     |
| Realtime             | -                         | -                  | -     |

The realtime pipeline bypasses this layer: its provider produces speech directly, so the tap and the
translator do not run and the span is the provider's own. That is the comparison the table exists to
make - when the cascade's time to first spoken word is within a couple of hundred milliseconds of
realtime, the streaming layer is doing its job and there is no reason to send audio to a third party
for speed alone. It is also why the harness has no realtime arm: there would be nothing of ours in it.

### Barge-in

Measured separately, from the detector's `speech-start` to playback going quiet. The teardown is
ordered so the ducking is first (see `speech/barge-in.ts`), which puts the number the user perceives
at roughly the duck ramp, about 20 ms, regardless of how long the cancellation behind it takes. The
guard window (250 ms after speech starts) is deliberately excluded: it is the one span where a
barge-in is refused on purpose.

## Related

- [[system-overview]] - the two pipeline shapes and the provider resolution rules.
- [[model-manager]] - what the local tier downloads and how readiness is decided.
- [[packaging-notes]] - the native runtimes the local tier needs.
