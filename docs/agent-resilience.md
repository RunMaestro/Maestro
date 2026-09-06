---
title: Agent Resilience
description: Maestro resends your prompt automatically when a provider is overloaded or your plan quota runs out, and can hand the turn to a backup endpoint instead of waiting for the reset window.
icon: shield-check
---

Providers fail. Anthropic returns `529 Overloaded` for a minute, or you burn through a Max plan window at 11am and the next reset is three hours out. Without help, both look the same from your side: a turn that stops, a prompt you have to send again, and an autonomous run that quietly stalls until you notice.

Agent Resilience answers that failure for you. When a turn fails for a reason that time alone will fix, Maestro keeps the exact prompt, waits the right amount, and sends it again. You get a live status card in the transcript instead of an error dialog, and long Auto Run batches survive an outage that started while you were asleep.

It is on by default for every agent.

## What it does

When an agent turn fails, Maestro classifies the error and picks one of two strategies.

| Failure                  | What it looks like                                                                                    | What Maestro does                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Availability**         | `Overloaded`, HTTP 529/503/502/500, `429`, `too many requests`, rate-limit throttling, network errors | Backs off and resends: 30s, 1m, 2m, 4m, 8m, 16m, then every 30m |
| **Plan quota exhausted** | `You've hit your session limit`, `usage limit reached`, `quota exceeded`, `out of credits`            | Waits until the quota actually resets, then resends             |

The resend is your original prompt replayed through the same code path that sent it the first time, so attached images, slash commands, `@` file mentions, and your tab's model and effort settings all survive unchanged. This holds for every provider, not just Claude Code.

### It waits for the real reset time

For a quota failure, backing off in seconds is pointless. Maestro reads the reset moment out of the error itself, in descending order of confidence:

1. The provider's own quota block. Claude Code sends `quotaLimits.resetsAt` alongside the limit message, which is the exact reset second, so the retry lands the moment your window reopens rather than up to an hour late.
2. A top-level `retryAfter` / `resetAt` field, or a `retry after 30 seconds` / `try again in 5 minutes` phrase.
3. Claude Code's legacy `Claude AI usage limit reached|1755500000` epoch marker.
4. The banner text itself, which names its own timezone: `You've hit your session limit · resets 11:40am (America/Chicago)`. This is the fallback for paths that forward only the message.

If none of those parse, it falls back to waiting an hour and retrying hourly. A wall-clock phrase with no timezone (`resets at 3pm`) is deliberately ignored, since a wrong guess is worse than the reliable hourly poll.

<Note>
Claude Code does not report a hit plan limit as an error. It sends an ordinary-looking assistant message whose text is the banner, which is why an unpatched build showed the notice as a normal reply and the turn appeared to succeed. Maestro recognizes that message specifically. It requires the banner to be the entire message, so an agent that merely writes *about* usage limits is never mistaken for one.
</Note>

### What it will never retry

Some failures need you, and retrying them either loops forever or hides a real problem. These always surface the normal error dialog instead:

- Expired or invalid credentials
- Permission denied
- Session not found
- A [human-in-the-loop gate](/autorun-playbooks) in an Auto Run document
- A full context window (`prompt is too long`) - resending the same oversized prompt cannot help
- An agent crash

## The status card

An outage collapses into a single live card in the transcript, not a wall of repeated error bubbles. While it is retrying, the card shows which failure mode you are in, how many retries have gone out, how long the outage has been running, and a live countdown to the next attempt.

Two buttons:

- **Try now** - skip the timer and resend immediately. Useful when you know the provider recovered, or you just switched accounts.
- **Stop** - give up on this outage. The card freezes into a summary and the turn is yours to handle.

When a retry succeeds, the card turns green and freezes: _Connection recovered. Service overloaded cleared after 3 retries over 4m._ Every outage keeps its own card, so a transcript honestly records what the day was like.

<Note>
Pending retries do not survive quitting Maestro. This is deliberate: a closed app should not sit in the background burning quota on your behalf. Reopening the app leaves the outage card in place as a dim summary, and you send the prompt again yourself.
</Note>

## Queued messages

If you queued several messages behind a turn that then failed, the queue **holds**. It does not drain into a provider that just refused you, because every queued message would hit the same wall and fail in turn.

The retry goes out for the prompt that actually failed. Your queue then drains in order behind it, exactly as it would have if the outage had never happened. Nothing is dropped and nothing is reordered, so a batch of work you lined up before bed is still there in the morning.

Sending a **new** message while a retry is counting down is different: that is you moving on, so it takes over. The countdown stops, the outage card freezes into a stopped summary, and your new prompt goes out instead.

## Prompts that arrive from automation

A turn does not have to be typed to be covered. Prompts that arrive from `maestro-cli dispatch`, a Cue pipeline, or the web and mobile composer are ordinary desktop turns, and they retry on exactly the same rules as one you typed yourself.

This matters more for automation than for interactive use: when a scheduled pipeline hits a quota wall at 3am, nobody is watching to press **Try now**.

## Turning it on and off

Both toggles live in the **New Agent** dialog when you create an agent, and in **Edit Agent** afterwards. To reach Edit Agent, right-click the agent in the Left Bar and choose **Edit Agent...**, or press `Cmd+K` / `Ctrl+K` and pick **Edit Agent**.

- **Retry on availability errors** - overloaded, 529, and server errors. Backs off 30s to 30m, then keeps trying.
- **Retry on token exhaustion** - plan or quota limit reached. Waits until the reset, or hourly.

Both default to on, including for agents you created before the feature existed. Turn one off and that failure class goes back to opening the error dialog immediately.

## Auto Run

An Auto Run batch is where this matters most, because a stalled overnight run wastes the whole night.

When a batch turn fails with a retryable error, Maestro parks the loop rather than aborting it, then resumes it automatically once the backoff elapses. The run continues from where it stopped, re-reading the document so any task you checked off in the meantime is respected. You get a toast reading **Auto Run: retrying**, and the History entry records the outage rather than logging it as a plain failure.

You can still take over: cancel the auto-retry from the status card and the batch's usual resume, skip, and abort controls come back.

<Note>
Auto Run batches launched from `maestro-cli` do not auto-retry. Resilience is a desktop feature, and the CLI's batch runner reports the failure instead. A prompt sent INTO the running desktop app with `maestro-cli dispatch` is different: it is a normal desktop turn and retries like any other.
</Note>

## Provider Failover

Waiting is the right answer for a 60-second blip. It is a poor one for a weekly quota that resets on Thursday.

Provider Failover is the other half. Give an agent an ordered list of Anthropic-compatible backup endpoints, and when resilience would otherwise start waiting, Maestro hands the turn to the next backup instead and keeps working. A backup can be a local vLLM or Ollama server, a third-party service like Z.AI, an enterprise proxy, or simply a second account.

It is **off by default** and configured per agent, in **Edit Agent** below the resilience toggles.

### Adding an endpoint

An endpoint is a name plus a bundle of environment variables layered on top of the agent's own, so nothing new has to be integrated - every Anthropic-compatible CLI already reads its base URL and token from the environment. Two variables carry it:

```bash
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=your-token-here
```

`ANTHROPIC_BASE_URL` is required and must start with `http://` or `https://`. Endpoints are tried top to bottom, so put your preferred spare first; use the arrows on each card to reorder.

<Warning>
Set a **model override** on each endpoint. Backup providers rarely accept Anthropic's model IDs - Z.AI wants `glm-4.6`, a local server wants whatever it has loaded - so failing over without swapping the model usually just trades a quota error for a 404.
</Warning>

### How a failover turn plays out

1. A turn fails with a retryable error, and the agent has an untried backup.
2. Maestro swaps that endpoint's environment into the next spawn and resends after a three second handover. The pause is short on purpose: long enough to see what is about to happen and cancel it, short enough that having a spare tire is worth something.
3. Each endpoint is tried at most once per outage. When all of them are spent, the agent falls back to plain wait-and-retry on whatever endpoint is currently live.
4. After **Return to primary after** minutes on a backup (60 by default), the next turn probes your primary again. The probe is lazy - it happens on the next spawn, never on a background timer - so an idle agent never burns quota just to test the water.

Failover requires Agent Resilience to be on for the matching failure class. It rides the same classification, so an error resilience would not retry is not one it will fail over on either.

<Warning>
While a backup is live, your prompts and your code go to a different operator, under different terms and different retention. That is why this is off by default and armed per agent.
</Warning>

### Your primary key is never handed to a backup

Auth is all-or-nothing per endpoint. If a backup sets `ANTHROPIC_BASE_URL` but does not supply its own credential, Maestro **removes** `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` from that spawn rather than letting the backup inherit them.

A URL-only backup row is the most natural way to configure this, and inheriting the key would present your primary Anthropic credential to a third party. The endpoint fails to authenticate instead, which is loud, recoverable, and much better than the alternative.

## Tracking it over time

The [Usage Dashboard](/usage-dashboard) (`Cmd+Alt+U` / `Ctrl+Alt+U`) keeps score under **Activity → Resilience**: how many outages Maestro carried your work through, how much downtime it bridged while you were away, the recovery rate, and a per-day timeline split into recovered vs. stopped. Only resolved outages are counted - a countdown still in progress shows on its transcript card, not here.

## See also

- [Provider Notes](/provider-notes) - Claude Code token sources, and how Dynamic mode switches from Max plan quota to API when a window runs dry
- [Auto Run & Playbooks](/autorun-playbooks) - the batch runner resilience keeps alive
- [Troubleshooting](/troubleshooting) - agent errors that resilience deliberately does not handle
