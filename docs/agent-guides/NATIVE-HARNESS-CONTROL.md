# Native Harness Control

Maestro keeps the current CLI/PTY transport as the default for every agent. **Native** is an explicit per-agent transport selection in the agent configuration. It is local-only: selecting Native for an SSH session is rejected before spawn, so SSH sessions must use the current transport.

## Control plane

`ProcessManager` owns turn lifecycle. A `HarnessControlHandle` exposes only negotiated capabilities and control operations. `InteractionBroker` owns permission, question, and elicitation requests and settles each request once, including cancellation, withdrawal, timeout, and competing responses.

- Desktop requests go to the window that owns the session.
- Web-desktop requests go only to authorized clients subscribed to the owning session; bridge list/respond calls verify the same client/session ownership.
- CLI native turns accept an `onHarnessInteraction` callback with a stable `nativeSessionId`.
- CLI `standard` mode without an owner denies immediately. It never waits for a prompt that nobody owns.
- CLI non-readonly native turns preserve the existing full-access default. `standard` and `readonly` must be selected explicitly per turn.
- Group-chat and background turns use the same session ownership; requests are not broadcast to unrelated sessions.

`delivered` means the native transport accepted a steering request, not that the model consumed it. `queued` means a later user turn was accepted. `absorbed` requires provider-specific evidence.

## Provider support

| Provider      | Native transport                          | Approval and interaction path                                                                                                                         | Steering                                                                                                | Lifecycle and qualification                                                                                                                                                                                                                                                  |
| ------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code   | Claude Agent SDK streaming input          | `canUseTool`, including `AskUserQuestion`                                                                                                             | Follow-up user messages only; `maestro-p` remains the observed in-turn TUI path                         | Resume, images, system prompts, additional directories, model and permission modes are mapped. Local live startup reached the SDK but the installed account returned `auth_expired`; full live tool approval remains unverified.                                             |
| Codex         | `codex app-server`                        | Server approval, user-input, and MCP elicitation requests                                                                                             | Native `turn/steer`; later `userMessage` confirms absorption                                            | Existing per-turn app-server lifecycle and focused/live approval tests.                                                                                                                                                                                                      |
| OpenCode      | `opencode serve` HTTP/SSE                 | Permission reply endpoint                                                                                                                             | No in-turn steering claim from asynchronous prompt submission                                           | Shared server lifecycle; the live probe verifies the provider permission protocol rather than the production spawner end to end.                                                                                                                                             |
| Copilot CLI   | Official Copilot SDK JSON-RPC             | `onPermissionRequest`, `onUserInputRequest`, `onElicitationRequest`                                                                                   | `send({ mode: 'immediate' })`, accepted as delivered; `abort()` is separate                             | Two live turns reused one retained provider session. The keyed lease pool also passed a mocked 100-turn sequential lifecycle smoke run.                                                                                                                                      |
| Grok CLI      | ACP over `grok agent stdio`               | ACP permission requests                                                                                                                               | None in ACP v1                                                                                          | Stable ACP client and provider launch descriptor.                                                                                                                                                                                                                            |
| Qwen3 Coder   | ACP over `qwen --acp`                     | ACP permission requests                                                                                                                               | None in ACP v1                                                                                          | Required ACP session fields are covered. Live now reaches the provider but stops at `Authentication required`; approval is not live-qualified.                                                                                                                               |
| Factory Droid | ACP over `droid exec --output-format acp` | ACP permission requests                                                                                                                               | None in ACP v1                                                                                          | Configurations requiring JSON-RPC-only restrictions must not use this ACP path.                                                                                                                                                                                              |
| Hermes        | `python -m tui_gateway.entry`             | `approval.request`/`approval.respond`, `clarify.request`/`clarify.respond`, matching secret/sudo events, expiry withdrawal, and pending resume replay | `session.steer`; `queued` remains queued across the first completion and runs as Hermes' follow-up turn | Live clarification and queued follow-up verified. The local Hermes terminal environment stalled before tool execution, so shell approval was not live-qualified. Read-only falls back to the current transport because the gateway has no enforceable read-only restriction. |
| Pi            | `pi --mode rpc`                           | Native extension UI requests                                                                                                                          | Native `steer`; `follow_up` remains distinct                                                            | Native RPC conformance tests.                                                                                                                                                                                                                                                |
| OMP           | `omp --mode rpc-ui`                       | Native extension/tool dialogs                                                                                                                         | Native `steer`, abort, and queue controls                                                               | Live steering and file effects verified. Approval mapping is covered by protocol tests; this environment auto-approves tested commands, so live approval is not claimed.                                                                                                     |
| Antigravity   | Python `google-antigravity` sidecar       | `policy.safe_defaults(handler=...)` and `ask_user` policy decisions                                                                                   | None; no SDK resume claim                                                                               | Fake-SDK protocol test verifies approval request/response. Requires a Python environment with `google-antigravity` and provider credentials. This machine has neither, so live SDK behavior is unverified. Current CLI transport remains available.                          |

ACP v1 does not define portable mid-turn steering. No provider gains that capability merely by appearing in the ACP catalog.

Hermes, Copilot, and Antigravity native transports currently accept text-only prompts; image-bearing turns fail explicitly or use the current transport before submission. No attachment is silently dropped.

## Persistent Copilot connections

`CopilotConnectionManager` keys retained sessions by tab, provider session, cwd, executable, model, effort, system prompt, and environment identity.

- A lease is rejected if the previous turn is still active.
- Every lease replaces interaction handlers and every turn unsubscribes its event listener.
- Natural completion releases the lease without disconnecting the session.
- Natural process exit, identity change, agent deletion, and app shutdown close the owned SDK runtime; closing a busy tab leaves its orphaned turn alive.
- A retained session is never shared across tabs, workspaces, accounts, or remote hosts.

The 100-turn smoke test covers repeated lease/release and shutdown with a fake SDK. It is not a claim that 100 live provider turns were run.

## CLI-native scope

`spawnAgent` resolves `harnessControlMode` against provider support before routing. Stale or imported native values on unsupported providers use the current transport, matching desktop behavior. Native SSH fails explicitly before spawn. One supervisor applies `timeoutMs` and external cancellation through startup, provider settlement, and teardown.

Useful API fields on `SpawnAgentOptions`:

- `harnessControlMode: 'native'`
- `permissionMode: 'full' | 'standard' | 'readonly'`
- `onHarnessInteraction(request)`
- `nativeSessionId` and optional `nativeTabId`

## Runtime requirements

- Copilot's optional platform runtime package is used when no executable override exists. Packaged builds unpack that package and resolve it explicitly under `app.asar.unpacked` or `app.asar`; `MAESTRO_COPILOT_RUNTIME` is an optional direct override.
- Claude SDK launches the configured Claude executable and must use a compatible authenticated installation.
- Hermes native mode derives `venv/.../python` from the resolved Hermes installation/profile and sets `HERMES_HOME` and `PYTHONPATH` for `tui_gateway.entry`.
- Antigravity native mode uses `ANTIGRAVITY_PYTHON` when set, otherwise `python`. Install `google-antigravity==0.1.22` (Python 3.10+) and configure its normal `GEMINI_API_KEY` or Vertex credentials. Other SDK versions fail explicitly.

## Verification entry points

Live tests are opt-in and do not run as ordinary CI tests:

```bash
COPILOT_LIVE=1 bunx vitest run --config vitest.integration.config.ts src/__tests__/integration/copilot-native-live.integration.test.ts
COPILOT_LIVE=1 bunx vitest run --config vitest.integration.config.ts src/__tests__/integration/cli-copilot-native-live.integration.test.ts
HERMES_LIVE=1 bunx vitest run --config vitest.integration.config.ts src/__tests__/integration/hermes-native-live.integration.test.ts
HERMES_LIVE=1 bunx vitest run --config vitest.integration.config.ts src/__tests__/integration/cli-hermes-native-live.integration.test.ts
QWEN_LIVE=1 bunx vitest run --config vitest.integration.config.ts src/__tests__/integration/cli-acp-native-live.integration.test.ts
CLAUDE_LIVE=1 bunx vitest run --config vitest.integration.config.ts src/__tests__/integration/claude-native-live.integration.test.ts
```

Focused lifecycle tests:

```bash
bunx vitest run src/__tests__/main/process-manager/CopilotConnectionManager.test.ts src/__tests__/cli/services/native-sdk-agent.test.ts
bunx vitest run src/__tests__/main/process-manager/antigravitySdkSidecar.test.ts
```

Set `ANTIGRAVITY_PYTHON` to a working Python for the sidecar test. The test injects a fake SDK; it does not require provider credentials and is not live SDK evidence.
