---
type: report
title: TTSR Phase 5 Acceptance Matrix
created: 2026-07-21
tags:
  - ttsr
  - acceptance
  - agents
related:
  - '[[ttsr-implementation-plan]]'
---

# TTSR Phase 5 acceptance record

Result of running the Gate A per-agent acceptance criteria from
[[ttsr-implementation-plan]] against the implemented subsystem on branch
`feat/ttsr`.

Every row below is **measured, not declared**. The suite
`src/__tests__/main/ttsr/ttsr-acceptance-matrix.test.ts` feeds real provider
stdout lines through that agent's real parser, into the runtime tap, the
matcher, the interrupt driver, and out as the corrective payload. The matrix is
recorded from what the pipeline actually did and only then compared with the
plan's scope table and with `TTSR_AGENT_CAPABILITIES`, so a parser change that
silently downgrades an agent fails the suite instead of shipping.

**Scope of the evidence.** This is an in-process integration run, not the plan's
literal Phase 3 E2E: it drives real parser output through the real main-side
pipeline with a stubbed `ProcessManager` surface, and asserts the corrective
payload. It does **not** launch the six agent CLIs, and it does not assert the
respawned process's final argv (the `resumeArgs` shape is covered separately by
`buildAgentArgs`' own suite, and the renderer half by
`ttsrRespawn.test.ts` / `useTtsr.test.ts`). A live per-agent run against real
binaries remains unperformed.

## How each axis is decided

| Axis     | Discriminator                                                                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prose`  | `live` when the abort is signalled before the turn's final event; `end-of-turn` when the only matchable prose is the closing event                                           |
| `ast`    | `full` when the edit snapshot recovers the whole written text; `partial` when only part survives (codex ships a patch, not a file); `none` when no tool content reaches TTSR |
| `shell`  | `yes` when the command a shell tool is about to run reaches the matcher, which is what makes a "never run X" rule expressible; `none` when the agent reports no tool calls   |
| `resume` | `clean` when the corrective turn re-attaches with `providerSessionId`; `degraded` when it must respawn fresh with the goal restated                                          |

## Recorded matrix

| Agent         | Prose detection | AST on edits              | Shell commands        | Interrupt + reinject | Status       |
| ------------- | --------------- | ------------------------- | --------------------- | -------------------- | ------------ |
| claude-code   | live            | full                      | yes (`Bash`)          | clean resume         | **pass**     |
| codex         | live            | partial (patch additions) | yes (`shell`)         | clean resume         | **pass**     |
| opencode      | end-of-turn     | full                      | yes (`bash`)          | clean resume         | **pass**     |
| factory-droid | live            | none (no tool events)     | none (no tool events) | clean resume         | **pass**     |
| copilot-cli   | live            | full                      | yes (`shell`)         | degraded (fresh)     | **degraded** |
| grok          | live (thinking) | none (no tool events)     | none (no tool events) | degraded (fresh)     | **degraded** |
| terminal      | n/a             | n/a                       | n/a                   | n/a                  | **excluded** |

Notes on the two degraded rows: copilot-cli and grok publish their provider
session id only on the turn's final event, which an aborted turn never reaches.
Their corrective turn therefore respawns fresh and restates the original goal
(captured by the TTSR spawn registry, since `ManagedProcess` holds no prompt).
This is the plan's Gate A degradation, exercised and asserted, not a gap.

Terminal is excluded exactly as the plan specifies: the spawn registry refuses
the `terminal` tool type, so the tap never registers the session and no TTSR
code runs for it. Asserted end to end in the same suite.

## Spawn flavors TTSR does not touch

The registry also refuses any spawn that is not an AI tab (`{sessionId}-ai-
{tabId}`): Auto Run tasks, background synopsis, tab naming, group-chat
participants. Interrupting is only useful if the turn can be respawned, and the
corrective respawn needs an AI tab to live in - so registering those would let
TTSR kill an unattended turn it could never restart. Covered in
`ttsr-runtime.test.ts` ("ignores a %s spawn").

## Post-review hardening (Phases H1-H4)

Four hardening passes landed after the matrix was first recorded. None of them
changed a row above; they closed correctness and cost gaps around it.

| Pass | What changed                                                                                                                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1   | Airtight gating: the spawn/exit lifecycle now consults the gate too, so a turn spawned while TTSR is off creates no conversation state and schedules no write. The disabled path costs exactly one boolean check per event, asserted by test.             |
| H2   | Budget accounting (an abort that folds a later match is charged once, and a withdrawn abort is refunded), forced-parallel `-fp-` spawn ids normalized to the stable conversation key, transactional reminder draining, and a `tool:bash` self-trip gate.  |
| H3   | Ownership-gated corrective respawn (one renderer, not every window), full state release when a respawn fails so the tab cannot wedge busy, a TTL on orphaned abort-pending entries, and the live Rules panel.                                             |
| H4   | Concurrency and mid-abort-race coverage, the regex backtracking guard and scan ceiling below, cache caps (`globMatcherCache` at 100, in-memory conversations on the same 30-day/500 policy as disk), and correlation-id matching for the corrective turn. |

One fix in H4 came from a defect the new tests surfaced rather than from the
review: the rule-file watcher was handed `.maestro/ttsr.yaml` as a chokidar watch
target, and chokidar 3 watches nothing at all when a listed path inside a
dot-directory does not exist yet - one missing path poisons its siblings. Every
project with rules but no `ttsr.yaml` (a valid, and the common, setup) therefore
never reloaded a rule edit. The watch is now anchored on the `.maestro` directory
with an `ignored` predicate that keeps the scope identical.

## Interrupt budget

A conversation may be aborted at most `MAX_TTSR_INTERRUPTS` (5) times, counted
in the persisted state store so the ceiling survives restarts. Past it, matching
continues but interrupting matches degrade to deferred `<system-reminder>`s on
the next prompt. Without this an agent that keeps tripping a rule would be
killed and respawned indefinitely, since the default `after-gap` policy re-arms
every few turns and each aborted turn advances that counter itself.

## Documented fidelity gaps

Gaps 1-5 are unchanged from the plan; gap 6 is the trust model, written down
during the Phase 4 hardening pass.

1. **AST is post-write, not preventive.** Maestro observes an external CLI's
   tool call after it has usually already applied the edit, so a structural
   match forces a corrective follow-up turn rather than blocking the write.
   There is no `matcherDigest` analog.
2. **`contextMode: discard` is best-effort.** Maestro cannot rewrite an
   external provider's transcript. `discard` hard-kills before the provider
   commits the partial turn; `keep` (the default) interrupts and lets it flush.
   Resolved per turn as: the project's `.maestro/ttsr.yaml`, then the global
   `ttsrContextMode` setting, then `keep`.
3. **opencode has no live prose.** Its text part arrives only at end of turn,
   so prose rules fire as a corrective follow-up. Tool and AST matching still
   land at tool-call time.
4. **terminal is out of v1.** Raw batched PTY output only, and not a resumable
   conversation.
5. **`tool:bash` is corrective, not preventive.** The command is matched as the
   tool call streams, which for a fast command is after it has already run. TTSR
   cannot block a command the way a permission prompt can - it interrupts the
   turn and makes the agent answer for it. factory-droid and grok report no tool
   calls at all, so "never run X" is not expressible for them.
6. **Rules are repo-controlled input, in the same trust class as
   `.maestro/cue.yaml`.** Rule bodies are injected verbatim into the agent's
   prompt, so whoever can commit to `.maestro/rules/` can put text in front of
   the agent (repo-controlled prompt injection), and rule regexes execute in the
   Electron main process against live agent output. Two bounds keep the regex
   half from being a denial of service: the normalizer refuses patterns with a
   quantified group over an unbounded body (`(a+)+`, `(x*)+`, `(\d+){2,}`) or
   with an overlapping alternation under a quantifier (`(a|aa)+x`, `(\d|\w)+!`)
   with a load warning, exactly like an uncompilable pattern, and
   `findRegexMatch` hands no single evaluation more than `TTSR_MAX_SCAN_CHARS`
   (32KB): oversized tool payloads are scanned in bounded windows with a 1KB
   overlap, so the whole payload is covered without ever growing one
   evaluation's input. Both are security invariants rather than tuning knobs.
   Regexes are case-sensitive with no flags surface: there is no way for a rule
   to request `i`, `m`, or `s`.

## Feature-off safety

With the gate off (`encoreFeatures.ttsr` or `ttsrEnabled` false) the observer
returns before any work: no rule load, no matching, no abort. Asserted per
agent over the same real fixtures ("is a total no-op with the feature gate
off"), and again at the unit level in `ttsr-runtime.test.ts`. The tap in
`StdoutHandler.handleParsedEvent` is a null check plus one short-circuiting
call.

## Anti-pattern greps

| Check                                                | Result                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| No `ProcessManager.write` injection into AI sessions | clean (the only `.write(` under `src/main/ttsr/` is the state persistence backend) |
| No renderer-owned repeat state                       | clean (no `repeatMode` / injected-rule bookkeeping under `src/renderer/`)          |
| No direct TTSR import into `process-manager`         | clean (the observer is injected via `setParsedEventObserver`)                      |

## Merge-time notes

- **Host API version: nothing to re-bump.** This branch does not touch
  `src/shared/plugins/host-api.ts` or the SDK at all. Its base already read
  `HOST_API_VERSION = '1.13.0'`, and `upstream/rc` has since moved to `1.14.0`
  (Agent Flow's `tool.executed` + `ui.panelPost`). Checked on 2026-07-22 with
  `git show upstream/rc:src/shared/plugins/host-api.ts`. The branch's only
  plugin-surface change is `src/shared/plugins/first-party.ts`, which adds the
  `ttsr` first-party id and its permission set - additive and version-neutral,
  so a merge takes upstream's version untouched. Bumping to a free minor here
  would claim host capability this branch does not add.
- **`PluginPanelSlot placement="settings"` is not this branch's change.**
  Settings-placed plugin panels do render from `DisplayTab` rather than from the
  Plugins panel, but that is already true at the merge base (`fbc664ff4`): the
  branch touches neither file. Recorded here because the hardening review
  flagged it as a possible user-visible change of this branch, and it is not.

## Gates run

- `tsc -p tsconfig.lint.json`, `tsconfig.main.json`, `tsconfig.cli.json`: clean.
  Note that none of the three cover `src/__tests__`, so test files are validated
  by running them, not by type-checking.
- ESLint + Prettier on touched files: clean.
- Suites: `src/__tests__/main/ttsr`, `src/__tests__/main/ipc/handlers/process`,
  `src/__tests__/renderer/utils/ttsrRespawn.test.ts`,
  `src/__tests__/renderer/hooks/useTtsr.test.ts`,
  `src/__tests__/renderer/components/Settings`. All green, re-run after each
  hardening pass.
- Windows leg: not runnable locally. CI must be green on both
  `test (ubuntu-latest)` and `test (windows-latest)` before merge.
- A live end-to-end run against real agent binaries is still unperformed, and
  cannot be automated from the test suite. It stays the one open acceptance item.
