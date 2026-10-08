# Relay conversation topic veto: implemented host correction

## Outcome

Implemented the user clarification in the Backstage handoff: an authorized conversation through the exact trusted `sh.maestro.relay` plugin is delivered through `agents.send` without a free-text topic keyword veto. The original German question and full current Relay wrapper reach the send sink unchanged. Release, deployment and secrets discussions, as well as ordinary direct work requests, use the agent's existing execution configuration. There is no question classifier, per-question approval, discussion-only mode or plugin-selectable bypass.

Also corrected the second content veto on authenticated outbound Relay MCP replies. A response discussing `Release` now passes the host reply gate, while Relay's existing caller/destination authorization and brokered network permissions remain enforced.

This supersedes this document's initial diagnostic-only proposal. The earlier category/error-string refactor was withdrawn to preserve the existing Relay error contract. **The running installed application is unchanged and still rejects the original question.** No package, install, restart, upstream push/merge, live Discord send, release or deployment was performed.

## Exact implemented boundary

### Inbound conversation

`src/main/plugins/plugin-host-handlers.ts` retains the closed schema, prompt bounds, exact-agent broker authorization, separate unattended consent and trusted-signature checks. Only after those checks, the exact host-known caller ID `sh.maestro.relay` skips `assertLowOrMediumRisk(prompt)` in **`agents.send` only**.

Provider-session ownership and binding-store availability, ActionGuard audit/rate/concurrency controls, abort handling, live grant/unattended checks during progress, Relay history attribution and provider-session persistence follow the existing path. The prompt is not stripped, reworded, translated or parsed for “safe question” intent. Caller identity comes from the sandbox host, not a prompt marker or an `opts` value. `skipRisk`, `force`, `origin` and permission-mode fields still fail the closed schema. Relay-like IDs and other trusted plugins do not acquire this treatment.

Trust uses the existing host trust machinery: `isPluginTrusted` is wired in `index.ts` to the current plugin record's `signature.status === 'trusted'`. Exact-agent and unattended grants come from the existing live/sealed grant policy. No new hard-coded publisher key, trust entry, capability or broad grant was introduced. Missing trust/consent wiring fails closed. The trusted Relay plugin continues validating allowed Discord users and guild/channel/thread ownership before issuing its host call; the host does not infer sender authorization from the textual wrapper.

No provider-spawn or permission-mode implementation was changed. Existing headless custom arguments, environment, directories, model, effort, SSH and Maestro-P settings are retained. Tests verify the existing configuration reaches the spawner and that no read-only override is added. A full-access configured run remains tool-capable; this patch does not promise per-action confirmation that its existing mode does not provide. Delivering test prompt strings to a fake sink does not execute any requested publishing/destructive action.

### Authenticated outbound replies

`src/main/web-server/handlers/messageHandlers/plugins.ts` previously rated tool name/description plus serialized arguments, so `Release` in reply text was also blocked. The exception is now limited to the **declared** tool ID `sh.maestro.relay/send` with matching `pluginId` and `localId` metadata.

That tool requires a live valid host-issued run proof resolving to a caller agent, and a currently active Relay record with trusted signature status, before invocation. Forged model `callerAgentId`, `agentId`, tab IDs or bypass arguments cannot supply the host context. Missing, forged, expired or revoked proofs are rejected. Other tools, including other Relay tools, retain the risk ceiling.

The verified context and full tool arguments are forwarded unchanged. Backstage's actual `createOutbound` handler continues checking the bound thread's agent and guild, parent channel binding, optional permitted foreign-channel policy, live revalidation, active Relay state and bot credential before `DiscordRest.sendMessage`. That implementation still checks REST target metadata and disables mentions. Network calls still use host-brokered `net.fetch`; the host patch grants no additional outbound authority. A refused destination returns a failure, never a claimed delivery receipt.

The exemption allows conversational text from any valid caller already authorized by Relay's binding/outbound policy; it is not a scheduler or Pianola input-risk exemption.

### Automatic paths and error compatibility

`agents.dispatch` from Relay, other-plugin `agents.send`, scheduler/Cue dispatch, Pianola and `process.spawn` retain their risk ceilings. Both `src/shared/pianola/pianola-risk.ts` and `src/shared/plugins/plugin-dispatch-gate.ts` are byte-identical to this branch's committed base; no keyword or classifier policy was relaxed globally.

Blocked paths retain the exact legacy error:

```text
high-risk prompt: auto-dispatch blocked, surfaced for review
```

Backstage's `message-queue.ts` recognizes that exact value as `risk-blocked`. The paired verification runs the real queue mapping and confirms it stays `risk-blocked`, not generic `agent-failed`. No structured fields, SDK contract or API version change is required. Unattended errors and ordinary successful response shapes remain unchanged. Relay's static public messages are untouched, and no raw host diagnostics are sent to Discord.

The wording “surfaced for review” still does not create a pending approval request. That is a legacy compatibility string; this patch does not claim an approval UI exists. The scheduler separately emits notifications for blocked triggers.

## Changes and verification

Production changes:

- `src/main/plugins/plugin-host-handlers.ts`: the exact trusted Relay conversation send policy.
- `src/main/web-server/handlers/messageHandlers/plugins.ts`: the authenticated, trusted, declared Relay reply policy.
- `CLAUDE-PLUGINS.md`: documents both boundaries and the retained error contract.

Tests/artifacts:

- Existing host-handler tests: unchanged original/full-wrapper delivery, German/English and high-topic direct requests, Relay origin, progress, history and owned provider sessions; other-plugin/automatic risk blocks; exact-agent/unattended grant matrices; trust/schema/session negatives; ActionGuard audit ordering/rate/concurrency; revocation, cancellation, late results and restarted runs.
- Existing headless-runner tests: retain configured execution options and normal Relay attribution.
- Existing WebSocket handler tests: reply text, receipts, valid/forged/expired/revoked proofs, trust negatives, other tools/identity mismatches and destination failures.
- Shared gate and scheduler regressions: legacy error contract and an explicit Relay scheduler trigger remain blocked.
- `src/__tests__/shared/plugins/fixtures/relay-release-question.json`: original question plus the actual Backstage wrapper evaluated with synthetic routing IDs and no attachments. No original Discord message was fetched.
- `scripts/verify-relay-reply-path.mjs`: reproducible paired source verification with the real host MCP bridge/handlers/proof registry and real Backstage outbound/Discord REST/message queue code, bundled only in memory.

Run the paired check from this worktree, replacing the example path with the actual Backstage checkout:

```bash
node scripts/verify-relay-reply-path.mjs /path/to/backstage-checkout
```

It verifies release text and a nonempty receipt at a fake network sink, preserves text and disabled mentions, rejects missing/foreign/revoked proof and foreign/rebound/guild-mismatched destinations/untrusted plugin, and checks the real Relay risk-error mapping. Result: one successful **fake** message, zero live network calls. Backstage files are read only; no plugin runtime/source/settings were changed there.

Verification receipts:

- **629 distinct targeted tests passed across 14 files**: the 626-test focused suite, then the three added exact-identity/missing-wiring regressions in a passing 140-test host-handler/scheduler run. No runtime code changed between those runs.
- `tsc --noEmit` for `tsconfig.main.json`, `tsconfig.cli.json` and `tsconfig.lint.json`: all passed.
- Production-file ESLint and the separate test/script ESLint configuration: passed.
- Prettier checks and `git diff --check`: passed.
- Full wrapper fixture matches the current Backstage `formatPrompt` expression with synthetic metadata: passed.
- Paired host/Backstage reply-path harness: passed unchanged release text, authorization negatives, receipt/mention behavior and the legacy `risk-blocked` mapping; **zero live network calls**.

The targeted files cover host handlers, headless runner, sandbox RPC, ActionGuard, permission broker/signatures, run identity, WebSocket handlers, MCP bridge, dispatch gate, exact/unattended permissions and Pianola classifier/policy. Test sinks and configuration are synthetic; no actual release, destructive command, provider turn or Discord message was executed.
