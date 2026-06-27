# Plugin Phase 3: the sandbox decision (gates ALL code-execution power)

Status: DECISION REQUIRED. This is the single pivotal choice in the whole plugin
plan. It is not an API question; it is a trust-boundary question. Nothing in
Phase 4 (the RCE-grade verbs) may be wired until this is resolved, because every
one of those verbs is only as safe as the realm a plugin's code runs in.

Grounded in `Plans/plugin-build-contract.md` (NON-NEGOTIABLE invariants) and
`maestro-extensibility-recommendation.md` (phased plan). Cited source lives in
the `.worktrees/autonomous-manager-agent` worktree.

## TL;DR for the decision-maker

Enabling ANY tier-1 plugin that runs code is, today, a full-trust decision. Two
isolation layers exist, and neither is an OS sandbox:

1. The plugin runs in an Electron `utilityProcess` (process + crash isolation),
   but that child still has the user's ambient OS privileges: it can touch the
   filesystem, the network, and spawn processes directly through Node, entirely
   outside the broker.
2. Plugin code runs inside a `vm` context (realm isolation), but a `vm` context
   is defense-in-depth only and is realm-escapable. A successful escape reaches
   full Node inside that child process, i.e. ambient OS privilege.

So the broker (default-deny) only constrains a plugin that PLAYS BY THE RULES and
calls `maestro.*`. It does not constrain code that escapes the `vm` realm, because
once escaped the code no longer needs the broker. The broker is a UX/abuse gate
for honest plugins, not a containment boundary for hostile ones.

There are exactly two honest ways forward. Pick one:

- Option A: build a REAL OS sandbox so a realm escape gains nothing beyond the
  broker, then treat code plugins like any other scoped-capability feature.
- Option B: formally accept that code-tier = full trust, and require signed +
  trusted distribution to RUN code, presenting "enable" as a full-trust act.

Recommendation: Option A is the correct long-term answer and unblocks an open
plugin ecosystem; Option B is the correct interim answer and can ship now. They
are not mutually exclusive: ship B as the gate today, build A to relax it later.

## Why this decision exists (the threat, precisely)

### The utilityProcess is process isolation, not an OS sandbox

`src/main/plugins/plugin-sandbox-host.ts` forks one `utilityProcess` per running
tier-1 plugin and is the only path the child can affect the host THROUGH THE
BROKER (`start()` at lines 77-113; every child message is authorized by
`this.deps.broker.authorize(...)` before a handler runs, lines 213-224). The fork
is deliberately stripped of inherited secrets:

```
const proc = utilityProcess.fork(sandboxModule, [], {
	serviceName: `maestro-plugin-${pluginId}`,
	// No extra env: the child should not inherit Maestro secrets.
	env: {},
});
```

That `env: {}` is good and load-bearing (it denies the child Maestro's tokens and
config via the environment), but it is NOT confinement. The child is still a
normal OS process running as the user. Nothing stops native `fs`, `net`, or
`child_process` if code reaches them. The host caps message size, rate, and
concurrency (lines 42-49, 181-211), which bounds a flooding child but not a child
that simply ignores the message channel and acts locally.

### The vm context is defense-in-depth and realm-escapable

`src/main/plugins/plugin-sandbox-entry.ts` runs plugin code with `vm` and a
curated global (`runPluginCode`, lines 119-156). The hardening already present is
real and should be preserved:

- `vm.createContext(sandboxGlobal, { codeGeneration: { strings: false, wasm: false } })`
  (lines 140-142): disables `eval`/`new Function` string compilation and WASM
  compilation inside the realm.
- No host intrinsics are injected onto the plugin global (lines 123-138). The
  context gets its OWN native intrinsics from `vm.createContext`, so plugin code
  cannot reach the host `Object`/`Array`/`URL`/`Function` and pollute this
  process's prototypes.
- Timers are wrapped, not passed by reference (lines 136-137), so plugin code
  cannot do `setTimeout.constructor` to reach the host `Function`.
- `require` / `process` / `Buffer` / module loading / `globalThis` are absent.
- The SDK and its sub-objects are `Object.freeze`d (lines 75-110).

The file's own header is explicit that this is not airtight (lines 19-24):

> "...escape is not 'harmless'. Treat closing escape vectors here as
> load-bearing, not cosmetic."

`vm` is documented by Node itself as not a security mechanism against untrusted
code. New escape primitives appear over time (prototype reaches through error
stacks, async stack frames, host callbacks, etc.). Therefore we MUST assume a
determined plugin CAN escape the realm, and design so that escape buys nothing.

### Net effect

Combine the two: a tier-1 code plugin that escapes the `vm` realm lands in a
normal OS process with the user's ambient privileges and direct Node access. It
can read the user's home directory, exfiltrate over the network, and spawn
processes, all without ever calling a broker method. The default-deny broker, the
capability scopes, the userData exclusion, and the net egress policy are all
bypassed for escaped code, because escaped code does not route through them.

Conclusion (unanimous red-team finding, restated in the contract invariants): the
`vm` context is defense-in-depth ONLY; the `utilityProcess` is NOT an OS sandbox;
so today, enabling any tier-1 plugin that runs code is a full-trust decision and
every new verb must be priced accordingly.

## What the spine already ships (so we cost only the delta)

- Process isolation per plugin, empty env, message-size/rate/concurrency caps
  (`plugin-sandbox-host.ts`).
- `vm` realm with `codeGeneration` disabled, no host intrinsics, wrapped timers,
  frozen SDK (`plugin-sandbox-entry.ts`).
- Default-deny broker as the only brokered path to host effects
  (`permission-broker.ts`); live grant re-read for instant revoke (lines 33-39).
- A signature + trust pipeline:
  - `src/shared/plugins/signing.ts` defines the on-disk `signature.json` shape,
    the deterministic ed25519 payload, and the trusted-key membership check.
    It separates integrity ("files match what was signed") from trust ("the
    signer key is one Maestro recognizes"); statuses are
    `unsigned | invalid | untrusted | trusted` (lines 35-44).
  - `src/main/plugins/plugin-signature.ts` `verifyPluginSignature` hashes the
    whole tree, requires the on-disk file set to EXACTLY match the signed set
    (no added, missing, or altered files, lines 145-156), verifies the ed25519
    signature, and resolves trust against the trusted key set.
  - `src/main/plugins/plugin-manager.ts` `isRunnable` (lines 212-221) refuses to
    run a plugin whose signature is `invalid` (tampered code never runs), while
    allowing `unsigned`/`untrusted` to run once the user has enabled it.

The gap is precisely: no OS-level confinement of the child, and no regression
test pinning the realm-escape invariant. Both options below close part of that
gap; Option A closes all of it.

## Option A: real OS sandbox + finish the vm hardening

Goal: make a realm escape worthless. Drop the `utilityProcess` to no ambient
filesystem, network, or process-exec ability and reduced credentials, so that
even fully-escaped code has nothing beyond what the broker would have granted
anyway. Then the broker becomes a true containment boundary, not just an honest-
plugin gate.

### What changes

- OS confinement of the child process (platform-specific, applied at/just after
  fork in `plugin-sandbox-host.ts`):
  - macOS: a Seatbelt/`sandbox-exec` profile (or App Sandbox entitlements for
    the helper) that denies file-read/write outside an explicit per-plugin
    scratch dir, denies all network, denies process-exec.
  - Linux: a seccomp-bpf filter plus a user namespace / `no_new_privs`, denying
    the `socket`/`connect`, `execve`/`execveat`, and `open` outside the
    per-plugin dir families.
  - Windows: an AppContainer / low-integrity token (restricted SID, no network
    capability SID, job-object limits) so the child cannot reach the network
    stack, the broad filesystem, or create arbitrary processes.
  - Reduced credentials everywhere: the child runs with the minimum token/uid
    capabilities the platform allows; it keeps only the parent message channel.
- Finish and PIN the vm hardening (most is already in place):
  - Keep `codeGeneration: { strings: false, wasm: false }` (already present).
  - Keep zero host intrinsics on the plugin global; everything reachable from
    plugin code must be constructed INSIDE the vm realm from JSON-only data
    (already the design; audit every property added to `sandboxGlobal`).
  - Add a REALM-ESCAPE REGRESSION TEST that fails the build if the invariant
    regresses: from inside the context,
    `(reachable).constructor.constructor('return process')()` MUST throw, for
    every value reachable on the plugin global (the SDK, `module`, `exports`,
    `console`, the wrapped timers). This is the canonical escape primitive and
    the contract names it explicitly.

### What it unlocks

- Enabling a code plugin stops being a full-trust decision. A realm escape gains
  nothing beyond the broker, so code plugins can run with the SAME scoped,
  default-deny capability model as everything else.
- An OPEN ecosystem: unsigned/untrusted community plugins can be allowed to run
  with bounded blast radius (still gated by per-capability consent), because the
  worst case is "what you granted," not "full machine."
- Phase 4's RCE-grade verbs become defensible: even they execute inside a
  confined child, so a bug in one verb cannot be parlayed into ambient access.

### Tradeoffs

- Cost: three separate platform sandbox implementations, each with its own
  failure modes, plus CI coverage on all three. This is the expensive option.
- Fragility: OS sandbox profiles drift with OS updates and with Electron's own
  helper-process model; they need ongoing maintenance and per-platform testing.
- Functionality limits: a fully network-denied child means net:fetch (and any
  future verb that needs IO) MUST be performed BY THE HOST on the plugin's
  behalf through the broker, never by the child directly. That is already the
  intended design (the broker does the fetch with the egress policy), so this is
  a constraint to enforce, not new work, but it forecloses any "let the child do
  its own IO for speed" shortcut.
- Effort: LARGE. Realistically a multi-week, multi-platform effort with a long
  hardening tail. The vm regression test itself is small (hours); the OS sandbox
  is the bulk.

## Option B: accept code-tier = full trust (require signed + trusted to run)

Goal: stop pretending the boundary contains hostile code. Formally classify
"enable a tier-1 code plugin" as a full-trust action, and only let code RUN when
it is signed by a trusted key. Declarative breadth (Phase 1) and brokered read/
act verbs (Phase 2) are unaffected; this gates code execution only.

### What changes

- Gate RUNNING code on trust, not just on "not invalid". Today `isRunnable`
  (`plugin-manager.ts:212-221`) lets `unsigned`/`untrusted` code run once
  enabled. Under Option B, RUNNING code requires `signature.status === 'trusted'`
  (signed by a key in the trusted set per `signing.ts` / `plugin-signature.ts`).
  `unsigned` and `untrusted` code stay DISABLED for execution; they may still
  register declarative contributions (themes, prompts, UI slots) which carry no
  code-execution power.
- Make the consent surface tell the truth. Enabling a code plugin must be
  presented as a FULL-TRUST action ("this plugin's code will run with your
  account's privileges on this machine"), not as a list of innocuous-sounding
  capabilities. This matches the invariant that consent must state true blast
  radius and must not train users to approve RCE as routine.
- Bind the trust decision to code identity. Per the contract, grants and the
  run/enable decision are bound to version + content hash + signer key; the
  exact-file-set check in `verifyPluginSignature` already makes any tampering
  `invalid` (never runs), and a signer-key change is a NEW trust decision that
  invalidates the prior enable.
- Keep the existing vm hardening and the realm-escape regression test from
  Option A's vm half. Even with trusted-only execution, defense-in-depth still
  matters (a trusted-but-buggy plugin should not trivially escape), and the test
  is cheap.

### What it unlocks

- We can proceed to Phase 4 SOON, for trusted publishers only, without building
  three OS sandboxes first. The blast-radius honesty plus signed distribution is
  a coherent, shippable security story.
- A clear upgrade path: when Option A lands, untrusted/unsigned execution can be
  re-enabled with bounded blast radius, and the trusted-only gate relaxes into a
  scoped-capability gate.

### Tradeoffs

- No open execution ecosystem: community/unsigned plugins cannot run code, only
  contribute declaratively. That is a real product limitation.
- Trust is binary and human-mediated: the trusted-key set becomes a curation
  responsibility (who gets a key, how revocation works). Key compromise = RCE
  for everyone who trusts that key, so key custody and a revocation path must be
  taken seriously.
- The boundary is still soft for trusted code: a malicious update from a trusted
  signer is full trust by definition. The exact-file-set + signer-key binding
  mitigates silent tampering, but trust is only as good as the signer.
- Effort: SMALL to MEDIUM. The signature/trust pipeline already exists; the work
  is tightening `isRunnable` to require `trusted`, building the full-trust
  consent surface, wiring key custody/revocation, and adding the vm regression
  test.

## Side-by-side

| Dimension                       | Option A: real OS sandbox          | Option B: full-trust, signed-to-run |
| ------------------------------- | ---------------------------------- | ----------------------------------- |
| Contains hostile escaped code   | Yes (escape gains nothing)         | No (trusted code is full trust)     |
| Unsigned/community code may RUN | Yes, bounded blast radius          | No, declarative only                |
| Consent framing                 | Scoped capabilities                | Full-trust action                   |
| Unblocks Phase 4                | Yes, for everyone, safely          | Yes, for trusted publishers         |
| Ongoing maintenance             | High (3 OS profiles)               | Low/medium (key custody)            |
| Effort                          | Large (multi-week, multi-platform) | Small/medium (reuse trust pipeline) |
| Reuses existing spine           | vm hardening; adds OS layer        | signature/trust pipeline as-is      |

## Recommendation

Adopt BOTH in sequence:

1. NOW: ship Option B as the execution gate. Require `trusted` to run code,
   present enable as a full-trust action, keep unsigned/untrusted code disabled
   for execution (declarative still allowed), and land the realm-escape
   regression test. This is cheap, honest, and lets trusted-publisher Phase 4
   work proceed without waiting on three OS sandboxes.
2. LATER: build Option A (the real OS sandbox). When it lands, a realm escape
   gains nothing beyond the broker, and the trusted-only gate can relax to a
   scoped-capability gate so an open execution ecosystem becomes safe.

Do NOT ship any Phase 4 verb under "unsigned code may run" until Option A exists.
Until then, Phase 4 is "trusted publishers only," gated by Option B.

## Decision gate: nothing tier-1-code runs until ALL of these hold

- [ ] The chosen option (A, B, or A-after-B) is explicitly recorded and approved.
- [ ] Realm-escape regression test is green:
      `(reachable).constructor.constructor('return process')()` throws for every
      value reachable on the plugin global.
- [ ] `vm` context keeps `codeGeneration: { strings: false, wasm: false }` and
      zero host intrinsics on the plugin global (audited, not assumed).
- [ ] If Option B (or interim): `isRunnable` requires `signature.status ===
'trusted'` to RUN code; unsigned/untrusted are execution-disabled; enable is
      presented as a full-trust action; key custody + revocation path defined.
- [ ] If Option A: child has no ambient fs/net/exec and reduced credentials on
      every supported OS, with CI coverage per platform; host performs all IO on the
      plugin's behalf through the broker.
- [ ] Grants + the run/enable decision are bound to version + content hash +
      signer key; any change invalidates and requires re-consent and re-enable.
