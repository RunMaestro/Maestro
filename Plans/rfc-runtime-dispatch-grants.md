---
type: analysis
title: 'RFC: Runtime Dispatch Grants'
created: 2026-07-22
tags:
  - plugins
  - security
  - board
  - dispatch
related:
  - '[[CLAUDE-PLUGINS.md]]'
  - '[[PLUGIN-DEVELOPMENT.md]]'
  - '[[BOARD.md]]'
  - '[[plugin-phase4-high-risk-verbs.md]]'
---

# RFC: Runtime Dispatch Grants

Status: proposed, unscheduled. Implementation is explicitly OUT OF SCOPE for this
document. This specifies the seam; a separate plan would build it.

## 1. Problem

Six first-party features in `src/shared/plugins/first-party.ts` ship as
PROJECTIONS over host code rather than as real sandboxed plugins, and every one
of them names the same single blocker in its NOTE block. Quoting the shared
finding, from Pianola (the earliest statement of it):

> NOTE: `agents:dispatch` is deliberately ABSENT. FC2 promoted it to an
> allowlist scope naming exact agent targets; Pianola dispatches to
> dynamically-discovered waiting sessions, which a static manifest scope cannot
> name. Pianola's dispatch authority today is HOST-OWNED (supervised CLI path
> gated by the Encore consent flag + risk engine + audit), not a broker grant.
> The plugin lift must design a runtime per-agent grant seam (or host-mediated
> dispatch) before this can become a broker capability.

The same sentence, with a different dynamic target, appears on:

| Feature          | The target a static scope cannot name                          |
| ---------------- | -------------------------------------------------------------- |
| Pianola          | whichever session is currently awaiting input                  |
| Maestro Cue      | sessions discovered by a trigger, plus user-authored commands  |
| Board            | the profile-to-base-agent a card resolves to at claim time     |
| Symphony         | the session a contribution creates for its Auto Run            |
| Director's Notes | the synopsis provider chosen in settings, resolved per request |
| Concerto         | the agent owning a decision cadenza, injected as a live prompt |

The mismatch is structural, not incidental. A grant in the authorization ledger
is minted at consent time against a literal target string. Every one of these
features chooses its target LATER, from state that does not exist when the user
clicks approve. There is no way to write the manifest scope truthfully, so the
honest thing the codebase does today is refuse to declare the capability at all
and keep the authority host-owned.

The cost of that honesty: none of these features can become a real tier-2
plugin, third parties cannot build anything that dispatches, and the projections
must be hand-maintained against host code as it changes.

## 2. Proposal: rule-based runtime grants

Add a THIRD grant shape alongside the existing two.

1. **Literal grant** (today): `agents:dispatch` scoped to `agent:abc123`. Minted
   at consent, matched by string equality.
2. **Standing rule grant** (new): a user-approved PREDICATE over agent
   properties, not a target string. Two example rules: "Board may dispatch to
   any agent with `boardWorker: true` whose working directory is inside project
   `/home/me/repo`", and "Pianola may dispatch to any agent it observed as
   awaiting input in the last 60 seconds". The rule is authored by the host from
   a fixed vocabulary, NOT by the plugin. A plugin requests "dispatch to this
   resolved target"; the host evaluates every standing rule for that plugin
   against the target's live properties and allows when one matches.
3. **One-time consent** (new): when no rule matches, the host surfaces a prompt
   naming the exact resolved target and what the plugin wants to send. The user
   may approve once, or approve and promote the decision into a standing rule.

Properties the rule vocabulary may test are host-owned and metadata-only: agent
id, agent type, project root prefix, an opt-in boolean set on the agent
(`boardWorker`), group membership, and current status. Free-form predicates,
regexes supplied by the plugin, and anything reading transcript content are out.

Grants are persisted in the sealed authorization ledger next to literal grants,
so they inherit the existing anti-forgery guarantees: a plugin cannot mint or
edit one by writing files, and the consent nonce plus trusted-sender check in
`consent-minter.ts` still gate the prompt. Every rule is listed and revocable in
Settings, and every match is written to the ActionGuard audit trail with the
rule id that authorized it, so "why did this run" is answerable after the fact.

## 3. How this composes with the existing gate stack

The gate stack in `plugin-host-handlers.ts` (`agents.dispatch`) stays intact.
Rule matching replaces exactly ONE link, the allowlist assert, and nothing else:

| Gate                    | Today                                    | With rule grants                               |
| ----------------------- | ---------------------------------------- | ---------------------------------------------- |
| Closed schema           | `{agentId, prompt}` only                 | unchanged                                      |
| Length caps             | agentId and prompt caps                  | unchanged                                      |
| Broker allowlist assert | grant must name this exact agentId       | literal match OR a standing rule matches       |
| Unattended consent      | `dispatchUnattendedAllowed`, fail-closed | unchanged, still fail-closed                   |
| Trusted signature       | `assertTrustedActVerb`                   | unchanged                                      |
| Risk ceiling            | `assertLowOrMediumRisk(prompt)`          | unchanged                                      |
| ActionGuard             | rate, concurrency, audit                 | unchanged, audit gains the authorizing rule id |

Three invariants must survive the change:

- **Fail closed.** An absent or unreadable rule set denies, exactly as an absent
  `dispatchUnattendedAllowed` predicate denies today. A missing wiring must
  never degrade to "allow".
- **Unattended stays orthogonal.** A standing rule authorizes WHO may be
  dispatched to. It does not answer whether unattended execution is permitted.
  A plugin dispatching from its own code still needs the separate unattended
  consent, because it is still definitionally nobody-at-the-keyboard.
- **Evaluation is host-side and fresh.** The target's properties are read from
  live host state at dispatch time, never from plugin-supplied claims. A plugin
  asserting `boardWorker: true` about an agent proves nothing.

## 4. What a tier-2 `com.maestro.board` would look like

With the seam in place, the Board projection could become a real sandboxed
plugin, and the shape is worth writing down because it is the concrete test of
whether the seam is sufficient.

- **`agents:dispatch`** via a standing rule: `boardWorker: true` within the
  board's project root. This is the whole reason for the RFC. The Board already
  has the opt-in flag the rule would test (`selectPoolAgentIds` in
  `src/shared/board/pool.ts`), so the vocabulary is not speculative.
- **`background:service`** running its own timer instead of riding the Cue tick.
  The Board would own its dispatch cadence and stop being gated on the Maestro
  Cue Encore flag, which is a dependency of convenience rather than of meaning.
- **`ui:panel`** for the kanban, rendered as sandboxed HTML with the one-way
  command bridge. The card editor is form state plus a save call, which the
  bridge already supports.
- **`fs:read` / `fs:write`** scoped to `.maestro/`, exactly as declared today.
  These need no change: the Board's storage is already a small, honest scope.
- **`notifications:toast`** for terminal card transitions, as declared today.
- **`events:subscribe`** so the plugin can react to host activity, now that the
  Board's own topics are on the bus.

Two things would still NOT move into the sandbox:

- **Worktree provisioning.** A card that opts into isolation gets a `git
worktree add` into a directory beside the project root and a spawn redirected
  to that checkout. A capability that permits arbitrary sibling-directory writes
  plus running git is `process:spawn` wearing a hat. This stays host-owned; a
  tier-2 Board would request isolation through a host-mediated verb or drop the
  feature.
- **Agent spawn configuration.** Model, effort, permission mode, and SSH remote
  come from the profile resolved by the host. The closed dispatch schema
  deliberately forbids a plugin supplying them, and that should not change.

**Migration path.** The projection and the plugin can coexist: the projection is
data, so the tier-2 plugin ships behind the same `board` Encore flag, and the
flag selects which implementation registers the dispatcher. When the plugin path
proves out, the projection entry in `first-party.ts` is deleted and the plugin
becomes the only implementation. Board state lives in `.maestro/board.yaml`
either way, so there is no data migration.

## 5. Out of scope

- Implementation. No code, no schema, no ledger migration is specified here.
- The rule vocabulary's final field list. Section 2 gives a starting set; the
  implementing plan owns the exact surface.
- Whether the other five projections adopt rules. Each has a different dynamic
  target and deserves its own read, though Pianola's awaiting-session rule is
  the obvious second candidate.
- Third-party access. First-party, trust-signed plugins first. Opening rule
  grants to unsigned third parties is a separate risk decision.

## 6. Decision needed

Schedule the seam, or accept that the six features stay projections indefinitely
and keep maintaining `first-party.ts` by hand against host code. This is the
single blocker between "projection" and "real sandboxed plugin", and it has now
been named independently in six places.
