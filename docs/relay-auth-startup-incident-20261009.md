# Headless Codex startup stall, 2026-10-09

## Evidence and limits

The incident report records a GNOME Keyring crash at 12:59 CEST and Codex PID
804542 requesting `org.freedesktop.secrets`, with a password dialog open until
15:38. Mira's agent-specific `-c cli_auth_credentials_store=file` override and
successful login-status check were supplied by the incident reporter. No
credential files, credential contents, or private Relay messages were inspected.

Read-only extraction of the installed app's compiled spawner and timeout module
confirmed the 60-minute run budget from upstream PR
https://github.com/RunMaestro/Maestro/pull/1652. Both spawn paths passed that
budget to Node's `spawn({ timeout })`, then waited for `close` to return a
result. Node's default timeout sends SIGTERM, with no force-kill escalation or
independent completion deadline in these paths. A process ignoring SIGTERM or
retained stdio can therefore leave the result pending beyond 60 minutes. There
was also no short Codex auth/startup deadline; piping/closing stdin cannot stop
an OS credential dialog reached through D-Bus.

This establishes a code path capable of an unbounded wait, not proof of which
signal or pipe specifically caused the historical 159-minute wait. No historical
process trace was available to establish that detail.

## Fix

The shared CLI spawner used by plugin `agents.send` and desktop-backed CLI sends
now supervises process startup and teardown with the existing idle watchdog.
Codex gets 120 seconds to produce structured model text/reasoning, tool activity,
or usage. Session/turn initialization, unstructured stdout, and stderr cannot
release the startup deadline. Once model activity arrives, the original long
run budget remains intact.

Timeout and cancellation reuse `killProcessTreeNow`, the existing host Stop
utility. It snapshots descendants before killing a launcher, then force-kills
the tree and process groups on POSIX, or uses Windows `taskkill /t /f`. A
five-second completion ceiling and pipe disposal release a failed result even
without `close`. Late output cannot become progress or a successful answer.
A startup failure carries static auth/keyring guidance and a retry instruction
through the existing failed Relay result. The host does not change the credential
store, log in, read credentials, or retry potentially delivered tool work.
Remote cleanup over SSH still depends on the remote transport; only the local
SSH process group is supervised here.

[Official Codex authentication documentation](https://developers.openai.com/codex/auth/)
confirms the agent-specific credential-store setting. The existing file-store
mitigation remains a separate operational choice.

## Activation

This change is based on PR #1652's head `9fe58c7ea` and lives on
`fix/relay-auth-startup-timeout`, independently of the original Cue checkout.
No installed files, production settings, Discord messages, or running app
processes were modified.

After review, include the fix in the agreed Relay integration build. Activation
requires a coordinated maintenance window: drain or cancel outstanding Relay
runs, preserve current user work, install the reviewed build and its matching
bundled CLI, then restart Maestro once. Verify Mira's existing credential-store
argument survives, run one ordinary Relay request, and exercise a deliberately
non-authenticated test fixture to confirm a failed result within 125 seconds.
Do not induce a real keyring outage or remove credentials for this test. Verify
that the Relay plugin renders the returned failure as a visible error/recovery
notice. Read-only inspection of the installed Relay entry point confirmed that
it uses `agents.send` and posts a failure to Discord, but currently maps provider
errors to the generic `agent-failed` notice. A targeted Backstage plugin mapping
is needed for the specific auth/retry notice; the host now makes that detail
available through `result.error`. Host contract tests cannot establish live
Discord delivery.
