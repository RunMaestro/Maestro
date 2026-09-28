# Playbook Exchange v2 - Guided Install Proposal

**Status:** proposal, nothing built.
**Scope:** `RunMaestro/Maestro` + `RunMaestro/Maestro-Playbooks`.
**Goal:** replace "download docs → hand-edit a 4KB markdown prompt → find the dropdown → hit Start" with "open a tile → confirm a short form → it runs → here's what happened."

Produced by a four-agent design debate (typed-form vs. LLM-interview vs. reporting/analytics, plus an adversarial reviewer). Where the agents converged, this records the decision. Where they didn't, it records the open question.

---

## 0. Fix this first - Exchange installs silently drop `assets/`

This is a live bug, not a proposal, and it undercuts the exact journey we want to build.

Four playbooks ship an `assets/` folder on disk:

| Playbook                        | Assets                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `Assistants/Message-Bus`        | `maestro_message_scanner.py`, `Maestro-Message-Channel.md`, `cue-subscription.yaml` |
| `Assistants/Voice-Journal`      | `voice_memo_to_journal.py`, `voice_memos.py`, `GIST_README.md`                      |
| `Assistants/LifeOS-Setup`       | `INSTALL_NOTES.md`                                                                  |
| `Development/Superpowers-Setup` | `INSTALL_RECIPES.md`                                                                |

**Zero of the 16 manifest entries declare an `assets` key.** At `marketplace-service.ts:551`, `effectiveAssets = marketplacePlaybook.assets ?? []`, and the filesystem-discovery fallback at `:553` is gated on `isLocalPath()` - true only for local-overlay playbooks, never for anything fetched from GitHub. So an Exchange install of Message-Bus writes five markdown docs and no `assets/` directory, and `3_INSTALL.md:63` then runs:

```
cp "{{AUTORUN_FOLDER}}/assets/maestro_message_scanner.py" "<INSTALL_DIR>/"
```

against a path that does not exist. The playbook degrades gracefully (`3_INSTALL.md:75` detects the missing folder and tells the user they must have received it via share) - so it fails _politely_ rather than loudly, which is likely why it went unnoticed.

**Fix:** add `"assets": [...]` to those four manifest entries. That's a manifest-only change, no app release. Then add a CI check in Maestro-Playbooks: every file under `<path>/assets/` must appear in the entry's `assets[]`, and vice versa. Ten lines, and it is the single highest value-per-minute item in this document.

---

## 1. What the debate settled

### Form, not conversation

The interview designer conceded the position outright:

> "I was reusing shipped infrastructure because it was there, not because the problem demanded it."

Both sides landed on the same architecture: **a typed input schema is the contract; the human always confirms a form; an LLM prefill pass is an optional v3 layer that may propose values but never commits them.**

The deciding arguments were all structural, not aesthetic:

- **The artifact.** A transcript is not a spec. Run reports, bug triage, "re-run with the same settings," and popularity attribution all need a validated, diffable `inputValues` object. The interview design carried one internally anyway - which conceded the point before the debate started.
- **Cold start.** A conversation needs a live session to stream into. A form does not. On a fresh install, form-first configures without forcing agent creation first.
- **best-pr.** Seven weights that must sum to 100 is a slider group with a live counter. Eliciting it in prose is slower _and_ nondeterministic.
- **Safety.** `ALLOWED_SENDERS` grants remote execution. Safe-by-construction (the field defaults to `self` and only a keystroke changes it) beats safe-by-verifier.

Honest scoping of where conversation still wins: **two playbooks out of sixteen** - `research-corpus`'s free-text `ANALYTICAL_LENS` (a blank textarea is where users abandon) and `lifeos-setup`'s `LIFEOS_ENHANCEMENTS` (eight options whose _meaning_ a filter can't explain). That is a per-field "help me pick" affordance in v3, not a wizard.

### The reviewer's correction: configuration is not the whole bottleneck

The strongest challenge to the entire premise, and it holds up:

- Median playbook has **3 variables**. Two have zero. `research-market` - the canonical reference for the whole CONFIGURE convention - has two variables inside a 3,905-byte prompt.
- Message-Bus, the 7-variable outlier, already ships **correct defaults for 6 of 7** (`self`, `@maestro`, `self`, `manual`, `3`, `~/bin/maestro-message-bus`).
- The 7th, `WORK_DIR`, defaults to `{{AGENT_PATH}}` - a template variable that only resolves against a session.

So the form is worth building, but it is not the thing standing between a user and a working message bus. Two other things are, and neither proposal originally modeled them:

1. **The two-step gap.** Import writes a `Playbook` record and stops. The user must then find the Auto Run dropdown, load it, and press Start. _That_ is the manual step, and closing it is a small diff.
2. **The run target.** `worktreeSettings`, `taskSelectionMode`, and model are all in the `Playbook` type (`src/shared/types.ts:332`) and none are set by import. A form that captures `POLL_MINUTES` but not "which repo does this land in" has configured the trivial half.

One correction to the reviewer: it claimed there is no session at import time. There is - `sessionId` is threaded through `usePlaybookImportActions.ts:29` into `importMarketplacePlaybook`, which is how it knows to write `userData/playbooks/<sessionId>.json`. So `{{AGENT_PATH}}` _is_ resolvable in the form. The risk is not "unknown target," it's "**invisible** target" - a user browsing the Exchange installs into whatever agent was last selected without being shown which. The fix is a confirmation row, not a new picker subsystem.

### Base rate worth respecting

`assets[]` was specified, documented in CLAUDE.md and CONTRIBUTING.md, and adopted by **zero** manifest entries (§0). That is the historical adoption rate for adding schema to this manifest. Every field we add must either be used by a playbook on day one or not ship.

---

## 2. The design

### 2.1 `inputs[]` - start deliberately small

Additive, optional, on the manifest entry. **Four types in v1:** `string`, `enum`, `boolean`, `number`. Fields: `id`, `label`, `help`, `default`, `options?`, `min/max?`.

```json
"inputs": [
  { "id": "TRIGGER_MARKER", "label": "Trigger marker", "type": "string", "default": "@maestro",
    "help": "Plain ASCII - it is byte-matched inside a binary blob." },
  { "id": "ALLOWED_SENDERS", "label": "Who can drive this agent", "type": "enum", "default": "self",
    "options": [{ "value": "self", "label": "Only me (recommended)" },
                { "value": "custom", "label": "Also these handles…" }] },
  { "id": "ARM_ON_INSTALL", "label": "Arm the bus when install finishes", "type": "boolean", "default": false },
  { "id": "POLL_MINUTES", "label": "Scan interval (minutes)", "type": "number", "default": 3, "min": 1, "max": 60 }
]
```

Deferred until a real playbook needs them: `path`, `url`, `agent-ref`, `multienum`, `secret`, `pattern`, `visibleIf`, `dangerIf`, `inputGroups`, `inputConstraints`. Each was proposed for exactly one playbook - usually Message-Bus, which is an outlier distorting the schema, or best-pr, whose author is the person building the widget.

**`type: 'secret'` is cut.** Zero of sixteen playbooks take a secret. It drags in `safeStorage`, env injection, and a redaction audit across the report and issue paths. Reserve the identifier; reject it in CI.

### 2.2 The backward-compatibility invariant - the load-bearing rule

> **`prompt` rendered at `inputs[]` defaults must equal the shipped `prompt`, byte for byte. Enforced in CI.**

Consequences, and they are the whole reason this ships safely:

- Old Maestro drops the unknown `inputs` key and shows today's editable CONFIGURE markdown. Identical behavior.
- **No `minMaestroVersion` bump.** Bumping _hides the tile_ from older clients rather than degrading it - the opposite of what we want.
- The 16 existing playbooks need zero document edits.

### 2.3 Rendering - patch the prompt, never the documents

`renderPromptFromInputs(prompt, inputValues)` in `src/shared/playbookInputs.ts` regex-patches the existing `**VAR:** \`value\`` lines in place. It **edits** the author's prompt; it does not generate it.

Two hard rules:

1. **Never template document bodies.** `useDocumentProcessor.ts:363-380` expands templates into the `.md` and writes the result back over the file (guarded only by a content-inequality check). Anything pushed into a doc body is burned in permanently on first run. Rendering into `prompt` only - which is passed per-task and never written to a document - keeps the blast radius correct and means reconfiguring is a single field update.
2. **Render at import/apply time, not at run time.** The runtime never sees `inputValues`. This is what keeps the second, deliberately-duplicated CLI engine (`src/cli/commands/auto-run.ts`) working with zero changes. If values were resolved lazily, the two engines diverge permanently.

Persist on the `Playbook` record:

```ts
inputValues?: Record<string, { value: string; provenance: 'default' | 'user' }>;
marketplace?: { id: string; lastUpdated: string };
```

`provenance` is four bytes and, in a bug report, distinguishes a broken default from a typo. `marketplace.id` is the join key everything downstream needs; without it, per-playbook analytics is impossible and "reconfigure" means re-import.

### 2.4 Probes - real, but deferred

The interview design's best contribution was a declarative allowlisted probe registry (`os.platform`, `harness.kind`, `agent.self`, `fs.readable`, `bin.which`, `git.remote`) run in the main process, feeding `default: {probe: 'agent.self.id'}` and `options[].availableIf: {probe: 'os.platform', equals: 'darwin'}`, plus a `preflight[]` block with soft-block + forced-safe values + a deep link. Both designers ranked it their #1 item. It is deterministic, model-free, and unit-testable.

**It still doesn't ship in v1**, for one reason: the fields it would auto-fill already have correct defaults. `HANDLER_AGENT_ID: self` and `WORK_DIR: {{AGENT_PATH}}` are already resolved at run time by the playbook's own prose. The genuine win is the **Full Disk Access preflight** - a verdict obtainable only by attempting the read, which no form field can express, and where the payoff is a deep link instead of 400 words of documentation.

That's one probe (`fs.readable`) for one playbook. Ship it as a one-off preflight in Phase 3 if Message-Bus install failures justify it; build the general registry only when a second playbook needs a second verb.

### 2.5 Authoring - keep it boring

**`manifest.json` does not become a build artifact.** The proposed `playbook.yaml` + `Agent-Prompt.md` + `build:manifest` + ajv + `git diff --exit-code` toolchain solves a wound (hand-escaping a JSON string) that one person hits twice a month, and charges every future contributor a toolchain to learn before their first PR.

Ship instead:

- `npm run fmt:prompt` - 30 lines, reads a `.md`, prints an escaped JSON string.
- CI checks, all **warning-level except the first**: (1) assets on disk ↔ `assets[]` - _this one blocks_, it's a correctness bug; (2) valid JSON; (3) render-at-defaults == `prompt`; (4) every `[TOKEN]` in a document resolves to an `inputs[].id` and vice versa.

Check (4) is the highest-value lint: a renamed variable silently reaching the agent as an unfilled `[PLACEHOLDER]` is the failure mode this whole system is most likely to produce.

---

## 3. Reporting, errors, popularity

### 3.1 The honesty problem comes before the report

Today a marketplace playbook can stall on the document that installs the scanner, get **silently skipped** (`useBatchRunner.ts:1191`), tick every remaining box, and finish - at which point `useBatchHandlers.ts:238` fires a toast, achievements, a standing-ovation modal, and a leaderboard submission. The user is told they have a message bus. They don't.

**This is the single highest-value change in the entire proposal, and it is ~40 lines.**

1. If `stalledDocuments` is non-empty at `onComplete`, suppress the ovation, achievements, and leaderboard submission, and show a plain "finished with N skipped documents" summary naming them.
2. For **marketplace-installed** playbooks, route a stall through the existing `pauseBatchOnError` path (`useBatchControlActions.ts:77`), which already offers `resume | skip-document | abort`. The human decides to skip, in the moment, with the reason in front of them.

No retry engine required - that machinery doesn't exist anywhere and building it is a separate project. This converts silent corruption into a visible decision using code that already ships.

A beautiful report on a half-broken install is worse than today's honest ambiguity. Fix the semantics, then report.

### 3.2 `PlaybookRunReport`

Invert `buildFinalSummary()` (`batchFinalSummary.ts:34`): build a structured object first, then render today's markdown from it so `HistoryEntry` stays byte-compatible.

Persist as **one `report_json TEXT` column** on `auto_run_sessions`, plus three real columns for the queries we know we need - `outcome`, `playbook_id`, `error_kind`. JSON1 (`json_extract(report_json, '$.outcome')`) answers everything else for the next year; add columns when a dashboard query is actually slow. The originally-proposed eleven columns plus two new tables shaped the schema before knowing the queries.

Also write `Runs/<runId>/RUN_REPORT.json`. That folder already exists as an audit trail for `resetOnCompletion` working copies (`useBatchRunner.ts:464`), so it's already per-run and already on disk.

### 3.3 Playbooks reporting on themselves

Checkboxes are not truth - the agent is the only thing that knows whether the install worked. **One marker**, added to `src/shared/autorunMarkers.ts` beside `MAESTRO:HITL`:

```
MAESTRO:RESULT ok|partial|failed reason="short human string"
```

`MAESTRO:ARTIFACT` is derivable from the filesystem - drop it. `MAESTRO:VERIFY` is valuable but only for playbooks that install things - optional, unenforced.

A terminal `N_REPORT.md` document is a **convention, not a requirement**. Requiring a reporting document of `research-market`, which produces a prose analysis, is ceremony reporting on ceremony - and when the run is broken, the reporting document is the most likely thing to be broken.

**CI warns, never rejects.** A rejecting gate on a volunteer PR repo with one maintainer trades a real contribution for a marker line. Enforcement is social instead: a run with no `MAESTRO:RESULT` reports as `completed_unverified` and its tile lacks a verified checkmark next to peers that have one. Retrofit the ~5 playbooks where success is genuinely checkable; the prose playbooks stay unverified, which is an accurate description of them.

### 3.4 Error submission - prefilled GitHub issue

|              | GitHub issue                                    | `POST runmaestro.ai/api/…`         | Sentry                                         |
| ------------ | ----------------------------------------------- | ---------------------------------- | ---------------------------------------------- |
| Server work  | **none**                                        | route, storage, spam, GDPR, uptime | none                                           |
| Consent UX   | **user reads the exact text before submitting** | trust-me dialog                    | invisible                                      |
| Triage/dedup | native                                          | build it                           | groups on stack traces, not playbook semantics |
| Fix lands    | **same repo as the fix**                        | nowhere                            | separate tool                                  |

**Pick GitHub issues.** Playbook failures are usually not exceptions - they're "the agent wrote the wrong config file," which needs prose, a repro, and a public thread. Keep Sentry passively: add `playbook_id` / `outcome` tags at the existing `captureException` sites in `marketplace-service.ts`, ~10 lines, free crash visibility.

Flow: redact (home → `~`, drop document content and git remotes, regex-scrub `sk-`/`ghp_`/`xox`/`AKIA`/JWT, truncate) → consent sheet showing the exact JSON → copy to clipboard → `shell.openExternal` a prefilled issue against `.github/ISSUE_TEMPLATE/playbook-run-failure.yml`. A 20-line labeler action applies `pb:<id>`, and per-playbook failure counts come free from GitHub issue search.

**On locally-modified playbooks:** do not refuse the button. Refusing punishes the users who engaged most, and the edit is usually unrelated. Detect drift by byte-comparing against the cached manifest, prefix the title `[modified]`, apply `needs-repro`, and warn in the consent sheet.

### 3.5 Popularity - piggyback, don't build a pipeline

Popularity means **completions, not installs**. Installs measure the thumbnail; completions measure whether it works.

Drop the proposed `telemetry_outbox` table and the new `/api/v1/playbooks/stats` route. Add one field to the checkin payload that already fires, is already gated on the update-check pref, and already carries the anon `installId` (`src/main/checkin.ts:27`):

```ts
playbooks: { "assistants-message-bus@2026-08-14": { i: 1, s: 3, c: 2, f: 1 } }
```

Deltas since last ack, read from `auto_run_sessions` with a `GROUP BY`. No new table, no new route, no new gate, no new kill switch, no delivery guarantees to reason about. A machine that never checks in contributes nothing - which is exactly the opt-out semantics we want.

Return path (worth keeping, genuinely clever): a nightly GitHub Action bakes a `stats` block into `manifest.json`, so badges inherit the existing 6h cache, stale-cache fallback, and offline behavior for free - **zero new client network paths.** Suppress below n=20 for k-anonymity; render nothing when absent, so no layout shift.

With 16 playbooks and an unknown install base most tiles will be suppressed at first, so this is genuinely Phase 4 - but the client-side counters cost nothing to start accumulating earlier.

---

## 4. Phasing

### Phase 0 - this week, manifest only

Add `assets[]` to the four playbooks that need it (§0). Add the blocking CI check. **No app release.** Fixes Message-Bus, Voice-Journal, LifeOS-Setup, and Superpowers-Setup on the Exchange path today.

### Phase 1 - "Configure & Start" (~2 weeks, one person)

The owner's stated journey, for Message-Bus specifically.

- `inputs[]` (4 types) on the **Message-Bus entry only**; the other 15 fall through to today's textarea.
- `src/shared/playbookInputs.ts` - `renderPromptFromInputs()`, plus the CI render-at-defaults assertion.
- `src/shared/types.ts:332` + `marketplace-service.ts:616` - add `inputValues` and `marketplace` to the record; accept `inputValues` in `importMarketplacePlaybook` and render before writing `prompt`. **Re-validate in main** - renderer validation is UX, not trust.
- `PlaybookDetailView.tsx` - a form with prefilled defaults, **plus a target confirmation row** showing the agent and resolved cwd this will install into.
- One button: **Install & Start**, following the `useWizardHandlers.ts:109` precedent straight into `startBatchRun` (`useBatchRunner.ts:123`). Extract `applyPlaybookRecord()` out of `handleLoadPlaybook` (`usePlaybookManagement.ts:176`) so both paths share it.
- **The honesty patch** (§3.1) - ships here, not later. A one-click install that celebrates a skipped document is worse than what we have.

_Not in Phase 1:_ probes, interview, secrets, YAML toolchain, telemetry, badges, `RUN_REPORT.json`, CI gates, mobile.

**User sees:** Exchange → Message Bus → four prefilled fields → "installing into: _Maestro (~/Projects/Maestro)_" → one button → it runs.

### Phase 2 - the report (~1-2 weeks)

`PlaybookRunReport` inverted from `buildFinalSummary`; `Runs/<runId>/RUN_REPORT.json`; three columns + `report_json`; a **two-section** modal (outcome banner, what went wrong + next-step buttons - "what was done" and verification rows need markers that don't exist yet); outcome-based routing at `useBatchHandlers.ts:238`; the GitHub issue button with redaction; Sentry tags. No new markers, no CI gate, no server.

### Phase 3 - widen where the data says to

Add `inputs[]` to whichever playbooks Phase 2's failure issues implicate. Add `path`/`visibleIf` only when a real playbook needs them. `MAESTRO:RESULT` + the FDA preflight probe. Per-run `run.log` teeing.

### Phase 4 - popularity

Checkin counters, nightly aggregate Action, `stats` in `manifest.json`, tile badges, popularity sort.

### Phase 5 - LLM assist, if ever

A per-field "help me pick" affordance on the two fields that need it, filling the **same** `inputs[]` schema. Never a parallel schema, never a whole-playbook interview. Fix the per-tab wizard-state wart (`AITab.wizardState` is a drifting mirror of `useInlineWizard`'s authoritative `tabStates`) before touching this.

---

## 5. Open questions for you

1. **Unattended runs.** The engine is a `while(true)` inside a React `useCallback` in the renderer (`useBatchRunner.ts:~493`). "Hit a button and walk away" is a promise the runtime cannot keep - close the window or sleep the laptop mid-install and Message-Bus dies after writing scripts to `~/bin` and possibly arming a Cue. Do we (a) scope the promise honestly ("keep Maestro open"), (b) add a resume-incomplete-install path, or (c) treat moving the engine to main as the real prerequisite? This is the largest unpriced item in the document.

2. **Mobile/web.** `messageHandlers.ts:855` can already `marketplace_import_playbook` but cannot start a run - the engine is desktop-renderer-only. A form makes mobile's dead end _longer_. Block it explicitly, or leave it?

3. **Reconfigure.** "Change `POLL_MINUTES` and re-run" needs a defined path. Re-import appends a second record and re-fetches docs over a folder whose `{{...}}` were already burned in by `useDocumentProcessor.ts:368`. Simplest answer: keep a pristine copy at import and restore on reconfigure - but the disease is the write-back, and fixing that is a separate small project worth scoping.

4. **Worktree / model / `taskSelectionMode`.** In the `Playbook` type, never set by import. Should the manifest be able to _recommend_ them (e.g. Message-Bus should never run in a worktree; a refactor playbook probably should)?

5. **Message-Bus as schema driver.** Most of the elaborate machinery proposed - `dangerIf`, sentinels, preflight, provenance verification - exists for one playbook's safety story. Phase 1 keeps it small deliberately. Confirm that's the right call, or say Message-Bus is the template and we build for it.

### Riskiest thing in this plan

The **target confirmation row**. Binding "Install & Start" to a session and resolving `{{AGENT_PATH}}` against it is the piece with no existing code path, and getting it wrong means silently installing a message bus into the wrong repository. Prototype that binding in week one, before writing a single form field.
