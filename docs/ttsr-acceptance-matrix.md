---
type: report
title: TTSR native Steer acceptance
created: 2026-07-21
updated: 2026-10-27
tags: [ttsr, acceptance, agents]
related:
  - '[[ttsr-implementation-plan]]'
---

# TTSR native Steer acceptance

TTSR is a first-party plugin (`com.maestro.ttsr`). Matching and repeat policy
remain main-authoritative. Corrections use the existing queue and Steer service;
TTSR has no process interrupt, kill, restart, or corrective spawn path.

```text
parsed output -> project rules -> deferred reminder + correction offer
owning desktop -> canonical HELD queue item -> canonical persistence + readback
  -> one-time live claim -> native steerQueuedItem
     -> pendingSteers -> observed provider verdict or native queue restoration
unsupported/no owner/stale claim -> next normal prompt's deferred reminder
```

The held item must be visible through the existing sessions bootstrap read before
main removes its deferred copy. A rejected claim removes the held duplicate; an
uncertain claim or a successful claim followed by renderer shutdown retains the
held item. Native Steer owns delivery/refusal, early verdicts, dropped messages,
process exits and restored `pendingSteers`. A transport that changes after a
successful claim falls back to that same queue, preserving the accepted guidance.

## Availability

| Agent or transport                                       | Live correction                                                 | Other matched guidance                      |
| -------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| Claude Code, local maestro-p interactive turn            | Native Steer, subject to its editor/dialog/read-only/size gates | Deferred reminder                           |
| Codex, local opt-in app-server transport                 | Native `turn/steer`                                             | Deferred reminder                           |
| Local Claude API, Codex exec, other structured providers | Unavailable                                                     | Deferred reminder on the next normal prompt |
| Forced-parallel process id                               | Deferred, to avoid steering another process on the same tab     | Deferred reminder                           |
| SSH remote spawn                                         | Excluded until remote rule loading exists                       | No local rule reads or reminder prepend     |
| Terminal and non-AI-tab spawn                            | Excluded                                                        | No TTSR registration                        |

A `delivered` verdict means the provider received the text. Only its observed
`absorbed` verdict proves the running turn changed course. `queued` means the
provider answered it as a follow-up. TTSR makes no cancellation or side-effect
prevention promise. Tool guidance asks the agent to inspect actual results and
files; an observed tool call may already have run.

The six-provider parser matrix measures detection and emitted correction offers,
including full/partial AST snapshots and shell events. It does not claim those
providers all support live Steer. The persisted `interruptCount` name is retained for compatibility; it is not a
respawn mechanism.

## Budgets and compatibility

At most `MAX_TTSR_INTERRUPTS` (5) automatic correction handoffs are accepted per
provider conversation once provider identity is known; unknown-provider
forced-parallel aliases share the pending conversation budget. The persisted `interruptCount` field retains its old name. An
unclaimed offer does not spend budget; once claimed the native queue owns its
correction, including refusal/fallback. Additional matches remain reminders.
Stream buffers, provider identities and AST deduplication belong to each raw
turn ID. Forced-parallel aliases share bounded conversation reminders.
Unknown-provider aliases share repeat eligibility; once provider session IDs are
known, repeat history is provider-specific. The automatic correction budget
follows the same scope. AST passes collect candidates before synchronously
rechecking the live turn, current provider identity and repeat eligibility.

Prompt preparation reserves exact match identities across all intersecting live
offers and parallel preparations. Every failed or abandoned spawn releases its
reservation; a successful spawn commits only its captured matches, even after
queue trimming. Deferred guidance checks its original project's current enablement
and active rule definition after process exit. Changed or disabled rules discard
the old guidance and release its reservation; unchanged reloaded rules remain valid.

Matching reserves repeat eligibility in memory. Only acceptance by the durably
held native queue or a successful normal prompt spawn commits and flushes repeat
history through the existing TTSR state backend. On restart, unclaimed guidance
can match again; accepted guidance retains its cooldown. The deferred queue itself
is not persisted. Queue eviction releases undelivered repeat reservations.

Repeat policies, bounded regex windows, regex rejection, project authorization,
config self-write suppression and transactional reminder draining remain intact.

Legacy project `contextMode` and global `ttsrContextMode` values are accepted when
reading old configuration but are ignored. Native Steer retains the existing
conversation and output. The old keep/discard controls have been removed.

## Evidence and boundaries

- `ttsr-acceptance-matrix.test.ts`: real provider parsers and main matcher,
  synthetic process lifecycle and correction sink. Covers token/closing events,
  tool snapshots, AST and project-relative glob containment.
- `ttsr-steering-offers.test.ts`: deferred ownership, claim token, current
  enable/rule gates, consumed reminders, exit/replacement races, concurrent
  conversations, forced-parallel streams, pending provider adoption and budget.
- `ttsr-state-persistence.test.ts`: restart before ownership, after a durable held
  native claim and after successful normal prompt delivery.
- `useTtsr.test.ts`: real canonical queue/Steer service with synthetic IPC;
  held persistence ordering/readback, native delivery/refusal/unconfirmed/exit
  restoration, duplicate offers, ownership, unsupported transports and unmount.
- `chatSteering.test.ts`: the existing native lifecycle owner, including early
  verdicts, pending records and restoration. No new parallel Steer owner exists.
- Existing matcher/config/state/parser tests retain the earlier review fixes.

These are bounded automated tests. They do not launch real provider CLIs or prove
that a live model obeys guidance. Local full suites are omitted under the user's
invocation policy; GitHub CI supplies Linux/Windows broad qualification.

## Packaged AST qualification

`@ast-grep/napi` target bindings still need packaged acceptance on macOS (both
architectures) and Windows. A generic multi-target builder and `asarUnpack`
patterns do not prove the required binary is installed in each artifact.
The lazy loader fails to regex-only behavior and the Rules panel displays matcher
availability. No new packaged/native acceptance is claimed here. This remains a
separate, nonblocking release qualification item under
[maintainer guidance](https://github.com/RunMaestro/Maestro/pull/1273#issuecomment-5753946144).

Rules remain trusted repository configuration. Regex scans retain their 32 KB
window/1 KB overlap ceiling and rejection of known nested-quantifier and
overlapping-alternation hazards; these bounds are not a general regex safety proof.
