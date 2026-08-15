---
type: reference
title: A Cappella Conversation Acceptance Checklist
created: 2026-08-15
tags:
  - acappella
  - architecture
  - testing
  - speech
related:
  - '[[latency-baseline]]'
  - '[[system-overview]]'
  - '[[voice-session-protocol]]'
---

# A Cappella Conversation Acceptance Checklist

The speech layer is the one part of A Cappella that automated tests cannot sign off. A scheduler
can be proven to deliver sentences in order without a human confirming that the result sounds like
a person talking, and a barge-in controller can tear down in the right order while still feeling
laggy to the person doing the interrupting. This document is the by-hand pass: what to say, what to
listen for, and which module to open when a check fails.

Run it on the oldest machine available. Every check below is a latency judgement in disguise, and a
fast machine hides the failures this list exists to find.

## Precondition: the layer has to be reachable

The speech layer is wired as of 2026-08-15. `VoiceSessionService` composes the translator, the
scheduler, the barge-in controller, the detail buffer, and the background announcer directly, and
`src/main/ipc/handlers/acappella.ts` builds the agent-output tap over the process manager and hands
it in as `agentReplyStream`. Confirm both seams before treating any failure below as a bug:

```bash
grep -rn "ConversationalTranslator\|SpeechScheduler\|BargeInController" \
  src/main/acappella/voice-session-service.ts
grep -rn "createAgentOutputTap\|agentReplyStream" src/main/ipc/handlers/acappella.ts
```

Two things can still leave the layer inert at runtime, and both are silent:

- **No process manager.** `agentReplyStream` is optional, and without it the session waits for a
  whole reply through `submitAgentReply()` - the `buffered` counterfactual the latency harness
  measures the shipped path against in [[latency-baseline]]. This is the mock tier and the dev
  harness. In the packaged app the manager is passed from `src/main/ipc/bootstrap/index.ts`.
- **A focus-only dispatch.** The tap is only armed when the dispatch actually sent a prompt, so
  "switch to the backend agent" is correctly followed by silence rather than by the tab's previous
  output being read aloud.

One thing is genuinely not wired yet: `focusTarget`, which is what a "show me" needs to put a tab on
screen. Nothing supplies it, so check 5's `show` case focuses nothing today. That is a renderer
round trip and belongs with the Phase 09 tab affordances.

## What else you need

Four things, none of which live in the repo:

1. The three native runtimes installed. They are declared in
   `src/shared/acappella/native-runtimes.ts` but are not yet `package.json` dependencies. See
   [[packaging-notes]].
2. The model set downloaded, from **Settings > Plugins > A Cappella > Models**.
3. API keys for OpenAI and ElevenLabs if you are testing anything other than the fully local
   configuration.
4. A microphone, and a quiet room. Barge-in checks are meaningless over a fan.

## The checks

Each check is one utterance, one thing to listen for, and one place to look when it fails.

### 1. The first word arrives before the agent has finished writing

**Say:** "ask backend to summarise everything that changed in the router this week"

**Listen for:** speech starting while the agent is visibly still writing in its tab. The point is
not that speech is fast, it is that speech and writing overlap. If the reply finishes rendering in
silence and only then does anything get said, the tap is not cutting at a completed thought.

**When it fails:** `speech/agent-output-tap.ts`. `DEFAULT_MIN_CHUNK_CHARS` is 200, so a reply whose
first paragraph is shorter than that waits for a paragraph break. Raise the agent's verbosity before
concluding the tap is broken.

### 2. Sentences play without gaps

**Say:** anything that produces a four or five sentence answer.

**Listen for:** the seam between sentence one and sentence two. A pause there is a provider round
trip that the lookahead should have hidden.

**When it fails:** `speech/speech-scheduler.ts`. `DEFAULT_LOOKAHEAD` is 1, meaning two sentences are
in flight at once. A slow TTS provider may need 2. Note that the scheduler delivers strictly in
order regardless of lookahead, so raising it cannot reorder speech.

### 3. Interrupting stops audio immediately and captures your first word

**Say:** anything long, then talk over it mid-sentence. Start your interruption with a distinct word
you can check for, such as "stop, actually, what about the tests".

**Listen for:** audio dropping within a beat, not at the end of the current sentence. Then check the
transcript: your first word has to be there. "Actually, what about the tests" with the leading
"stop" missing means the pre-roll is not reaching the reopened floor.

**When it fails:** `speech/barge-in.ts`. Ducking is a 20 ms ramp to `DEFAULT_DUCK_GAIN` 0.15, so what
you hear should be a fast fade rather than a hard cut. The order matters and is deliberate: duck,
flush playback, cancel synthesis, cancel the translator stream, reopen the floor. A missing first
word is the last step; audio that keeps playing is one of the first two.

Also confirm the negative case: the assistant must not interrupt itself. Let a long reply play in
full without speaking. Any self-interrupt means AEC leakage is beating the 250 ms
`DEFAULT_GUARD_MS` window.

### 4. "Tell me more" drills into real detail instantly

**Say:** after any substantial reply, "tell me more".

**Listen for:** detail arriving with no perceptible think time and no new work in the agent's tab.
The whole point of the detail buffer is that the follow-up costs nothing. If the agent tab shows a
new turn, the utterance was routed instead of matched as a follow-up.

**Then check the siblings:** "read that again" repeats what was actually spoken, not what was
queued. "What was the file" speaks a basename, never a path read character by character. "Show me"
focuses the tab and says nothing at all.

**When it fails:** `speech/drill-down.ts`. Intent matching is ordered, with `show` ahead of `file`.

### 5. Nothing markdown-shaped is ever read aloud

**Say:** something that forces a code-heavy answer, such as "ask backend to show me the diff for the
router change".

**Listen for:** silence over the diff. The intro line should be spoken, the fence never. This is the
check most likely to surface something ugly, because it is where the tap's filtering and the
translator's markdown stripping have to agree.

**Known rough edge:** a diff-heavy reply produces a real multi-second silence mid-turn. The intro is
spoken, the fence is correctly skipped, and the hang notice cannot cover the gap because the diff
keeps arriving as `data` and keeps resetting the 20 s timer. Nothing is malfunctioning and it is
still the worst listening experience the harness produces. See [[latency-baseline]].

### 6. A background completion waits for a pause

**Say:** dispatch to a second agent, then start a conversation with the first while the second
works.

**Listen for:** the second agent's completion never landing on top of your conversation, and when it
does land, naming its source ("the backend agent finished the migration").

**When it fails:** `speech/background-announcer.ts`. The setting is `speakBackgroundCompletions`
under the `acappella` settings key, with `on | off | auto`. `auto` is the default and resolves to on
for the Conductor scope, off inside a focused agent session, so a silent announcement inside a
focused session is correct behaviour rather than a bug.

## Recording the result

Numbers from the same session go in the **Measured results** table in [[latency-baseline]]: press
**Read last turn** on the Models page and paste the copied JSON. Three turns per configuration,
record the median. The first turn of a local configuration includes the model load and is not
representative of a conversation.
