# Plugin Phase 4: the RCE-grade verbs (safe wiring AFTER the sandbox decision)

Status: INERT. These verbs stay un-wired until Phase 3
(`plugin-phase3-sandbox-decision.md`) is resolved. This document specifies
exactly HOW to wire them safely when that gate opens; it changes no code.

Scope: three arbitrary-code-execution-equivalent powers.

1. `agents:dispatch` - send a prompt to an existing agent.
2. `agents:spawn-own` - spawn the plugin's OWN allowlisted helper binary (the
   `process:spawn` capability, confined to host-owned binaries).
3. automation emit (`cue:emit`) - let a plugin fire a cue/automation, which can
   itself resolve to a dispatch.

Grounded in `Plans/plugin-build-contract.md` (NON-NEGOTIABLE invariants) and
`maestro-extensibility-recommendation.md`. Cited source lives in the
`.worktrees/autonomous-manager-agent` worktree.

## Why these three are arbitrary code execution

- `agents:dispatch` runs a target agent, and Maestro agents run with
  `--dangerously-skip-permissions`. So handing a plugin the ability to dispatch
  a prompt is handing it the ability to make an unsandboxed agent do anything the
  agent can do. The capability description already warns this "can run code an
  agent is allowed to run" (`src/shared/plugins/permissions.ts:286-287`).
- `process:spawn` runs a binary. Without a host-owned allowlist, "spawn" is
  "execute anything," including a shell or interpreter that re-executes arbitrary
  code. The capability description is bluntly "Run shell commands"
  (`permissions.ts:304-305`).
- `cue:emit` is RCE BY TRANSITIVITY: a cue trigger's action may be `dispatch`
  with an `agentId` (`src/shared/plugins/contributions.ts:70-82`, validator at
  lines 504-529). A plugin that can emit/fire a cue can therefore cause a
  dispatch, i.e. cause agent execution, without holding `agents:dispatch`
  directly. It must be gated as if it were dispatch.

Therefore none of the three may be presented to the user as "send prompts" or
"run commands." Per the contract, the consent surface MUST state true blast
radius: these are arbitrary code execution.

## Hard precondition: Phase 3 must be resolved first

These verbs only execute inside the plugin child. If a tier-1 code plugin can
escape the `vm` realm into ambient OS privilege (the unresolved Phase 3 problem),
then a plugin does not even NEED these verbs to do harm, and any gating here is
moot. So:

- Wire these ONLY after Phase 3 chooses Option A (real OS sandbox) or Option B
  (full-trust, trusted-to-run). Under Option B, these verbs are
  trusted-publisher-only.
- The realm-escape regression test from Phase 3 must be green.

## The shared gating model (applies to ALL three)

Every one of the three verbs MUST satisfy ALL of the following before it can run.
These are not per-verb niceties; they are the invariants restated as a checklist.

1. SEPARATE, NON-BUNDLED consent, framed as arbitrary code execution. The
   high-risk verb gets its own consent step that is NOT bundled into a "grant all
   requested permissions" click. The wording states the true blast radius
   ("this plugin can make an agent / a program run arbitrary code on your
   machine"). Do not co-list it with low-risk capabilities where a user trains
   themselves to click through.
2. A real allowlist scope, NEVER `scope:'none'`. In the spine these capabilities
   currently carry ScopeKind `none` (`permissions.ts`: `agents:dispatch` line 91,
   `process:spawn` line 103) because they are inert. Wiring them REQUIRES
   promoting them to an `allowlist` scope kind (a deliberate, Phase-4-gated spine
   change) so each grant names exactly which agents / which own-binaries are
   permitted. A `none`-scoped grant on these verbs is a wildcard and is forbidden.
   Scope kinds stay purely declarative (allowlist / prefix / glob), never
   predicate functions, so the matcher stays exhaustively unit-testable.
3. Host-owned binary allowlist for anything that execs. `binaryName` comes from a
   HOST-OWNED allowlist. No shells, no interpreters, no arg-exec tools (`sh`,
   `bash`, `cmd`, `powershell`, `node`, `python`, `env`, etc.). The plugin never
   supplies an arbitrary path; it selects a host-blessed entry by name.
4. Env allowlist that NEVER inherits `process.env`. The child env is built from a
   closed allowlist of host-chosen keys/values. Maestro's environment (which
   carries tokens and config) is never passed through. This mirrors the existing
   `utilityProcess.fork(..., { env: {} })` discipline in
   `src/main/plugins/plugin-sandbox-host.ts:90-94`.
5. Closed arg/opts schema validated at the broker boundary. The plugin may pass
   only the fields a closed schema permits. It can NEVER set: any
   skip-permissions / dangerous flag, `force`, `concurrency`, `cwd`, env, or any
   permission flag. `cwd` is host-confined; args cannot smuggle a shell
   invocation. Validation happens in the broker/handler, not in consent wording.
6. ActionGuard rate + concurrency caps. Every call goes through
   `src/main/plugins/action-guard.ts` `begin(pluginId, capability, target?)`
   BEFORE the handler executes. These verbs are high-risk, so they get the tight
   `DEFAULT_LIMITS.high` budget (`windowMs: 10_000, maxPerWindow: 10,
maxConcurrent: 2`, lines 29-33) or tighter, so a compromised-but-permitted
   plugin cannot fire them in a storm. The guard does not grant permission; it
   bounds blast radius.
7. Audit BEFORE the action. The audit record is written before the effect runs
   (ActionGuard's `audit` hook, `action-guard.ts:44-45`), as a tripwire, not a
   substitute for the gate. A denied or rate-limited attempt is auditable too.
8. DISTINCT consent for unattended / scheduler-driven invocation. Every entry
   point to these verbs (direct `maestro.*` call, scheduler tick, cue trigger,
   activation event) traverses the IDENTICAL broker + consent + audit pipeline.
   No-user-present (unattended) execution requires its OWN separate, revocable
   consent on top of the interactive grant. A plugin that may dispatch when the
   user clicks must NOT thereby be able to dispatch on a timer at 3am.
9. Bound to code identity. The grant is bound to version + content hash + signer
   key; any change invalidates it and requires re-consent and re-enable
   (`plugin-signature.ts` exact-file-set check; `signing.ts` trust model).
10. Default-deny remains the only path. The broker is the sole route to the
    effect (`permission-broker.ts`); no credential, handle, channel, socket, or
    token is ever handed to the plugin. A method with no descriptor cannot be
    fabricated.

## Per-verb specification

### 1. agents:dispatch

What it does: `maestro.agents.dispatch(agentId, prompt, opts)` sends a prompt to
an existing agent. The SDK shim exists (`plugin-sandbox-entry.ts:88-89`), the RPC
descriptor exists (`rpc-protocol.ts:32`), and the handler is INJECTED so it stays
inert until the integrator provides `deps.dispatch`
(`plugin-host-handlers.ts:31-32, 167-176`).

Gating specifics on top of the shared model:

- Scope: per-agent allowlist. A grant names the exact `agentId`s this plugin may
  dispatch to. Promote `agents:dispatch` from `scope:'none'` to an `allowlist`
  scope keyed on agent id. Never wildcard.
- Closed opts schema: `agentId` and `prompt` only (both already validated as
  strings in the injected handler, `plugin-host-handlers.ts:170-175`). The plugin
  may NOT set model, permission mode, skip-permissions, cwd, or any execution
  flag. The target agent's own configuration decides those; the plugin cannot
  override them.
- Consent framing: "let an agent run arbitrary code on your behalf," not "send a
  prompt."
- Unattended: a scheduler/trigger-driven dispatch (see cue:emit below) requires
  the distinct unattended consent.

### 2. agents:spawn-own (process:spawn)

What it does: `maestro.process.spawn(command, opts)` runs a binary. The SDK shim
exists (`plugin-sandbox-entry.ts:107-108`), the RPC descriptor exists
(`rpc-protocol.ts:45`), and the handler is INJECTED so it stays inert until the
integrator provides `deps.spawn` (`plugin-host-handlers.ts:33-34, 177-183`).
"Spawn-own" means: a plugin may run ONLY a host-blessed helper binary, scoped to
that plugin, never an arbitrary program.

Gating specifics on top of the shared model:

- Binary allowlist (the central control): `command` resolves through a host-owned
  allowlist of specific, non-shell, non-interpreter binaries. The plugin selects
  by allowlisted name; it can never pass a path, a shell, or an interpreter.
  Nothing is ever spawned THROUGH a shell (no `shell: true`).
- Scope: per-binary allowlist, keyed to the plugin's own helper(s). Promote
  `process:spawn` from `scope:'none'` to an `allowlist` scope. Never wildcard,
  never `none`.
- Env: built from a closed allowlist; never inherits `process.env`. Same
  discipline as the sandbox fork's `env: {}`.
- Args/opts: closed schema. No `cwd` from the plugin (host-confined), no `env`
  from the plugin, no `force`/`shell`/`detached`. Args cannot invoke a shell.
- ActionGuard: high-risk caps, ideally tighter than dispatch (spawning processes
  is heavier than a prompt).
- Consent framing: "run a program on your machine," presented as arbitrary code
  execution.

### 3. automation emit (cue:emit)

What it does: lets plugin code fire a cue / automation. This is NOT yet a spine
capability (there is no `cue:emit` capability or `cue.emit` method in
`permissions.ts` / `rpc-protocol.ts`); wiring it is part of Phase 4 and requires a
new descriptor + a new allowlist-scoped capability. The danger is transitive: a
cue trigger may carry `action: 'dispatch'` with an `agentId`
(`contributions.ts:70-82`, validated at lines 504-529), so emitting a cue can
cause a dispatch, i.e. agent execution. The scheduler already refuses to run a
dispatch action unless a dispatch implementation is injected
(`plugin-scheduler-host.ts:10-13, 81-88`); that same discipline must hold for
plugin-emitted cues.

Gating specifics on top of the shared model:

- Treat emit-that-resolves-to-dispatch EXACTLY like `agents:dispatch`. The same
  per-agent allowlist scope, the same closed schema, the same audit-before, the
  same caps. A plugin cannot use cue:emit to reach a dispatch it would not be
  allowed to call directly. The effective permission is the INTERSECTION of the
  plugin's cue:emit grant and its dispatch allowlist.
- Emit-that-resolves-to-notify (a toast) is low-risk and may be gated like
  `notifications:toast`, but the broker must classify the resolved action and
  pick the gate from the RESOLVED effect, not from "it is just a cue."
- Scope: allowlist of cue trigger sources / agent targets the plugin may emit to;
  never `none`, never wildcard.
- Unattended is the DEFAULT here, not the exception: cues are largely
  scheduler/trigger-driven. So a cue:emit grant that can resolve to dispatch
  REQUIRES the distinct unattended consent up front, because it will run with no
  user present. Same broker + consent + audit pipeline as the interactive path
  (invariant: every entry point, including scheduler/trigger/activation,
  traverses the identical pipeline).
- Closed payload schema: the plugin supplies only the fields the cue contribution
  schema permits (`payload`, and for dispatch the allowlisted `agentId`); it can
  never set execution flags, env, or cwd on the downstream dispatch/spawn.

## Inert-until-built: current status to preserve

- `agents:dispatch` and `process:spawn` handlers are INJECTED and omitted by
  default, so they do nothing unless the integrator wires `deps.dispatch` /
  `deps.spawn` (`plugin-host-handlers.ts:167-183`). Keep them omitted until the
  full gating above is in place.
- The cue scheduler SKIPS dispatch actions with a log line when no dispatch
  implementation is wired, instead of silently dropping them
  (`plugin-scheduler-host.ts:81-88`). Preserve that "skip loudly" behavior.
- Both capabilities still carry `scope:'none'` in the spine
  (`permissions.ts:91,103`). Promoting them to an `allowlist` scope kind is a
  REQUIRED, deliberate change at wiring time and must land together with the
  allowlist matcher tests; it is explicitly out of scope for Phases 1-2.
- `cue:emit` has no spine surface yet; do not add it until Phase 3 is resolved
  and the gating model above is implemented.

## Wiring acceptance gate (per verb)

A verb may be wired only when ALL hold:

- [ ] Phase 3 resolved; realm-escape regression test green; (Option B interim:
      trusted-publishers-only).
- [ ] Capability promoted from `scope:'none'` to an `allowlist` scope with
      exhaustive matcher tests (set-membership, no substring wildcarding).
- [ ] Separate, non-bundled consent that states arbitrary-code-execution blast
      radius; plus a DISTINCT unattended/scheduler consent.
- [ ] For spawn: host-owned binary allowlist (no shells/interpreters); env
      allowlist (never `process.env`); no plugin-supplied cwd/env/flags; never via a
      shell.
- [ ] Closed arg/opts schema validated at the broker boundary; no
      skip-permissions/force/concurrency/cwd/env from the plugin.
- [ ] ActionGuard high-risk caps applied; audit written BEFORE the effect.
- [ ] Every entry point (direct, scheduler, trigger, activation) routes through
      the identical broker + consent + audit pipeline.
- [ ] Grant bound to version + content hash + signer key; any change invalidates.
- [ ] Uninstall purges the grant, the allowlist, and any scheduled triggers that
      used the verb.
