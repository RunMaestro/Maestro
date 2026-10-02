# Maestro Lite mode

Status: agreed delivery complete, with native macOS verification deferred at
the user's request. Windows and Linux Lite scenarios have been exercised.
The design and acceptance criteria below remain the implementation record;
current usage is documented in [Remote Control](../docs/remote-control.md).

## Implementation verification

- Ran native Windows Lite over managed SSH and authenticated HTTPS, and native
  Linux Lite over SSH to a Windows full host, using isolated test profiles.
- Compared host and client agent/chat inventories; exercised host agent commands,
  terminal resize and interrupt, files, uploads/downloads, Git, and Auto Run.
- Verified canonical transcript row identities across the full host, Lite, and
  an independent HTTPS browser; client navigation and drafts remain independent.
- Restarted Lite and recovered the same profile's draft and selected chat.
  Restarted the host without resubmitting work; a startup read failure kept saved
  agents untouched and recovered through the visible Retry control.
- Exercised real host-owned browser pixels and input. A Linux client reattached
  to the same incognito page after Windows Lite disconnected, preserving its
  page identity and form data. Copy/paste landed on Linux, not the host clipboard.
- Verified rejection of revoked access, changed SSH keys, invalid TLS identity,
  and changed Maestro host identity. Lite loaded no local execution backend.
- Built main/preload, CLI tools, and both UI bundles; ran the three TypeScript
  checks, focused regression suites, and both native browser E2E scenarios.
  UI builds used source maps disabled for the constrained verification disk.
- Native macOS verification is deferred at the user's explicit request and does
  not block this delivery. It has not been represented as passing.
- Installer packaging and the entire repository test suite were not exercised.
  This is a launch-ready worktree, not an all-platform release certification.

### Observed startup comparison

A fresh paired Windows run used the same Electron installation and isolated
profiles, with `NODE_ENV=test` and `ELECTRON_DISABLE_GPU=1`. Full mode was sampled
when its seeded chat tab became visible; Lite was sampled when its disconnected
connection control became visible.

| Measurement                          | Full mode | Lite, disconnected |
| ------------------------------------ | --------- | ------------------ |
| Launch to the stated visible control | 1,775 ms  | 364 ms             |
| Electron processes in the snapshot   | 4         | 3                  |
| Sum of Electron process working sets | 572.3 MiB | 228.6 MiB          |
| Local execution backend imports      | Present   | Absent             |

Working sets are the sum of `app.getAppMetrics().memory.workingSetSize`; shared
pages may be counted more than once. Lite's aggregate was about 60% lower in
these snapshots. This is one startup comparison, not a connected/steady-state
benchmark or a claim about installer size. Both isolated applications exited
after measurement.

## Goal

Maestro Lite is a thin client for an existing, running Maestro instance. It is
not a light theme, a separate collection of chats, or another way to launch an
individual agent over SSH.

Connect to a host and see that host's Maestro chats, history, installed agent
CLIs, projects, and running work. Agent processes, terminals, Git operations,
workspace access, and automation execute on the host, using its environment and
credentials. Disconnecting Lite must not stop accepted work.

This matches the remote-backend model described by
[Hermes Desktop's remote gateway documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard#connecting-hermes-desktop-to-a-remote-backend):
the desktop client attaches to an already-running backend. Hermes distinguishes
that dashboard backend from its messaging gateway process; Maestro should reuse
the product model, not assume protocol compatibility.

## Recommended design

Implement a **Lite startup mode in the existing desktop application**, using
Maestro's existing browser-compatible renderer and remote bridge. Offer two
connection methods:

- **SSH, recommended:** Lite manages a loopback-only SSH port forward to the
  host's existing Remote Control server.
- **Direct connection:** an authenticated HTTPS/WSS endpoint, normally reached
  through a private network, VPN, or correctly configured reverse proxy.

Do not create another renderer, another agent runner, or a competing remote API.
The host serves its matching web-desktop assets. A sandboxed view in Lite loads
those assets without the local desktop preload or Node access.

```text
Client machine                              Host machine

Trusted connection picker                   Full Maestro instance
  saved profiles                              Remote Control server
  SSH tunnel lifecycle     SSH or HTTPS       authentication + existing bridge
           |               <---------->       sessions, history, agent discovery
Sandboxed remote UI                           processes, files, Git, automation
  host-served renderer                        existing owning desktop renderer
```

The local shell may store connection preferences, authentication material, and
UI state. It must not initialize a local Maestro execution backend. UI rendering,
SSH transport, and explicitly requested file uploads/downloads are local client
activities, not remote workload execution.

Start with a runtime mode, not a separate installer. Avoiding backend startup is
meaningfully different from reducing Electron's installer size; this plan does
not promise a smaller download.

## Existing implementation to build on

| Area                    | Current implementation                                                                                                                                                                                                                                                | Consequence for Lite                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Shared UI               | [`src/web-desktop/bootstrap.ts`](../src/web-desktop/bootstrap.ts) loads the existing preload through an Electron shim and then the main renderer.                                                                                                                     | Reuse the browser build of the same React UI.                                                                                             |
| Remote bridge           | [`src/web-desktop/electron-shim.ts`](../src/web-desktop/electron-shim.ts) translates IPC to WebSocket messages and already handles heartbeat, sequence/epoch tracking, and reconnect behavior.                                                                        | Extend the existing connection lifecycle instead of replacing it.                                                                         |
| Host server             | [`src/main/web-server/WebServer.ts`](../src/main/web-server/WebServer.ts) serves the desktop UI, API, and WebSocket endpoint.                                                                                                                                         | Attach to the existing instance; do not start a second server against its data directory.                                                 |
| Session loading         | [`src/main/ipc/handlers/persistence.ts`](../src/main/ipc/handlers/persistence.ts) and the [web architecture guide](../docs/agent-guides/WEB-MOBILE.md) describe bootstrap metadata and deferred transcript loading.                                                   | Show the complete host session list without transferring every transcript at connect time.                                                |
| Session synchronization | [`src/renderer/hooks/session/useSessionLifecycleSync.ts`](../src/renderer/hooks/session/useSessionLifecycleSync.ts) and [`activeSessionPersistence.ts`](../src/renderer/utils/activeSessionPersistence.ts) cover lifecycle synchronization and client-specific focus. | Preserve independent navigation; address remaining shared-write races rather than duplicating stores.                                     |
| SSH                     | [`src/shared/sshConnection.ts`](../src/shared/sshConnection.ts), [`src/shared/sshOptions.ts`](../src/shared/sshOptions.ts), and [`src/main/ssh-remote-manager.ts`](../src/main/ssh-remote-manager.ts).                                                                | Reuse SSH option/config resolution. Existing per-agent SSH execution is not a remote-Maestro connection.                                  |
| Backend startup         | [`src/main/index.ts`](../src/main/index.ts) eagerly imports full-backend modules.                                                                                                                                                                                     | Select Lite before importing or initializing that backend. Hiding UI panels after startup is insufficient.                                |
| Host ownership          | [`useOwnedSessionGate.ts`](../src/renderer/hooks/agent/internal/useOwnedSessionGate.ts) gates side effects to the owning desktop renderer; [`remoteRequest.ts`](../src/main/web-server/callbacks/remoteRequest.ts) routes remote requests through the main window.    | The full host application and its owning renderer must remain alive. Lite is not a headless-host implementation.                          |
| Native browser views    | [`BrowserTabView.tsx`](../src/renderer/components/MainPanel/BrowserTabView.tsx) currently shows a desktop-only placeholder in web-desktop mode.                                                                                                                       | A web wrapper alone does not deliver complete desktop parity. Remote browser interaction needs host-side support.                         |
| Bridge security         | [`bridgeDenyList.ts`](../src/main/web-server/handlers/bridgeDenyList.ts) currently denies `webLogin:*`; [`bridgeHandlers.ts`](../src/main/web-server/handlers/bridgeHandlers.ts) otherwise dispatches registered IPC handlers/listeners.                              | Do not mistake the current bridge for a narrowly allowlisted public API. Audit its exposed surface before promoting direct remote access. |

## Product and ownership contract

### Connecting

1. Launch Lite through a proposed `--lite` option, shortcut, or a saved startup
   preference. A connection picker appears without local agent discovery or
   local session-store initialization.
2. Select a saved host or add a connection. An SSH profile contains the SSH
   destination/config alias and the Remote Control endpoint on that destination;
   a direct profile contains its HTTPS URL. Reuse existing SSH key/agent/config
   handling rather than inventing a second SSH credential system.
3. Establish transport, authenticate to Maestro, and verify host identity,
   protocol compatibility, capabilities, and readiness to accept remote actions.
4. Load the host's UI and session inventory. Display the host name and connection
   state persistently so remote destructive actions are not mistaken for local
   ones.

Use connection information explicitly supplied by the host's Remote Control UI.
Do not discover hosts by guessing user-data paths, auto-install software, or
silently launch another Maestro instance. Starting/stopping the host itself is
outside this attach-client feature.

### Data and execution

| State or operation                                                  | Owner                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Chats, transcripts, history, workspace configuration, shared queues | Host                                                              |
| Agent availability, executable resolution, provider credentials     | Host                                                              |
| Agent/terminal processes, Git, automation, browser workloads        | Host                                                              |
| Selected chat, local layout, unsent draft, connection profile       | Individual client                                                 |
| SSH keys and SSH-agent access                                       | Client transport; not copied to the host                          |
| Uploaded/downloaded files                                           | Explicit user-directed transfer; otherwise files stay on the host |

Keep connection profiles, cookies, cached UI state, and drafts isolated by
profile and validated host identity. A reused `localhost` tunnel port must never
attach another host's state. Do not merge remote sessions into local Maestro's
session store. Do not fetch host secrets merely to populate settings screens.

The initial UI has one active host per Lite window; it does not aggregate several
hosts into a synthetic session list. Saved profiles may target multiple hosts.
Existing host-side per-agent SSH configurations continue to work: execution is
owned by the host, even when it delegates to another configured machine.

### Disconnection and host lifetime

- States distinguish connecting, authenticating, connected, reconnecting,
  disconnected, and an actionable failure such as an incompatible host.
- Closing Lite or disconnecting closes only its connection and owned SSH tunnel.
  It does not send stop commands to remote sessions.
- The existing bridge's event replay/reload behavior remains the foundation.
  Rebootstrap on host epoch changes or unrecoverable event gaps and invalidate
  obsolete process/session state.
- Never blindly resend a prompt, process launch, or file mutation after losing an
  acknowledgement. Reconcile host state and tell the user when submission is
  uncertain rather than risking duplicate work.
- Never fall back to local execution when transport, authentication, or host
  readiness fails.
- The supported host is a running full Maestro with its owning renderer alive.
  Minimized/background operation must be exercised. Quitting the host, closing
  its last owning window, or logging out of its OS session is not equivalent to
  disconnecting Lite and is not promised to preserve jobs.

A host that runs without Electron or an owning desktop renderer is a separate
architectural effort. It is not required to attach to the full client requested
here, and must not be implied by calling Lite a gateway client.

## Implementation phases

### 1. Establish the host contract and remote capability inventory

- Inventory UI-to-host commands and events through the existing bridge. Classify
  each as host workload/state, client-local presentation, explicit file transfer,
  or host-only administration.
- Add an authenticated handshake to the existing server that reports stable host
  identity, host version, bridge protocol compatibility, capabilities, and owning
  renderer readiness. An HTTP response alone does not establish operational
  readiness.
- Specify which shared writes need revision/conflict checks or host-owned commands.
  Existing lifecycle synchronization is useful, but last-writer-wins transcript,
  read-state, or queue writes must not overwrite newer host work or unloaded data.
- Audit bridge methods, events, and response fields. Establish an explicit allowed
  remote surface, preserve legitimate existing web clients, and keep credential
  disclosure and security administration out of ordinary remote responses.
- Reuse existing web-login/session handling. Require Maestro authentication even
  through SSH; require the existing login/session mechanism for direct access in
  addition to its connection URL. Verify session revocation reaches live sockets.
  Do not add a loopback authentication exemption.
- Validate WebSocket origin/session checks and reverse-proxy behavior. Treat this
  as access to a trusted owner's machine, not as tenant isolation or a public
  multi-user hosting service.

**Gate:** an authenticated remote client can identify the intended instance,
retrieve its session/agent inventory, and distinguish an unavailable owning
renderer from an empty host. Unauthorized clients cannot invoke commands or
subscribe to session events. Existing supported web access remains functional.

### 2. Add a genuinely thin startup path

- Refactor the main entry into early mode selection followed by mode-specific
  imports. Preserve the full application's current startup behavior.
- Implement the trusted local connection picker and minimal profile storage.
  Lite must not open local chat databases, discover agent CLIs, or start process,
  automation, plugin, or web-server subsystems for a local backend.
- Load host-served web-desktop assets in a separate sandboxed view with context
  isolation, no Node integration, and no privileged local Maestro preload.
  Restrict navigation and new windows so remote content cannot reach local APIs.
- Keep startup mode preferences separate from the full session store. Do not
  implement an implicit live mode switch that kills local sessions.
- Integrate connection actions with the project's existing UI/menu/shortcut
  conventions, including a visible close/disconnect action and Escape behavior
  for the connection dialog.

**Gate:** on a machine with no agent CLIs installed, Lite reaches its connection
picker and connects to a host without creating a local execution backend. Full
mode still starts and operates normally. Remote content cannot access local
privileged IPC.

### 3. Implement connection management and managed SSH

- Add saved SSH and HTTPS profiles with connect, disconnect, and edit actions.
- Build SSH forwarding from canonical SSH options/config resolution. Use a
  loopback-only local listener, forward to the selected host endpoint, detect
  forwarding failures, and manage tunnel readiness and process exit explicitly.
- Preserve host-key verification and support normal SSH-config aliases, keys,
  agent authentication, ports, and supported jump-host settings. Never suppress
  changed-host-key or certificate errors to make a connection succeed.
- Distinguish transport failures from Maestro authentication, compatibility, and
  host-readiness errors. Do not collect an SSH password in a newly invented
  credential store; use the repository's supported SSH authentication path.
- Support direct HTTPS/WSS with certificate validation. Plain HTTP may be the
  loopback endpoint inside an SSH tunnel, not an internet-facing connection mode.
- Own only the tunnel created for that connection; release it on disconnect or
  application exit without touching remote processes or unrelated SSH sessions.

**Gate:** both SSH and direct HTTPS connect to the same existing host state;
wrong credentials, unreachable endpoints, changed host keys, and invalid
certificates produce useful errors and no local fallback. Disconnect removes
the owned tunnel and leaves host work running.

### 4. Complete remote workflows and multi-client behavior

- Use existing session bootstrap/deferred loading and host-side agent detection.
  Browse, create, resume, rename, and delete chats against the host; display the
  host's agent capabilities and stream real process output.
- Keep client navigation independent while reconciling shared session mutations.
  Make queue consumption and completion side effects execute once on the host.
  Do not move history/statistics/automation ownership into every connected client.
- Exercise simultaneous full-host and Lite use. Where current shared persistence
  permits stale overwrites, replace the affected writes with host-owned operations
  or explicit revision/conflict handling, using the existing persistence seam.
- Finish a parity matrix for agent prompts, terminal input/resize/interrupt,
  remote directory selection, Git, attachments, file upload/download, automation,
  previews, browser/coworking views, clipboard, and external links.
- Directory pickers for workspaces must browse the host filesystem. An attachment
  picker may select a local file only as an explicit upload. A download must be
  an explicit transfer rather than a mirrored workspace.
- Resolve host-local preview URLs on the host side; `localhost` on Lite must not
  accidentally point at the client machine. Any preview relay must have explicit
  permitted targets, rather than becoming an arbitrary network proxy.
- Complete host-owned browser/view interaction where a workflow requires it.
  Today's web-desktop placeholder is not parity. Use an authenticated host-side
  view/input relay for that surface, not a local Electron webview executing the
  workload on the Lite machine. Verify this path separately because it is a
  substantial addition beyond the existing IPC bridge.
- Keep intentionally host-only security administration visibly labeled. Do not
  silently disable requested workload features and call the result complete.

**Gate:** the user can operate the host's chats, agents, terminals, files, and
relevant browser/automation workflows from Lite. Another client does not steal
focus, lose newer transcript data, resurrect deleted sessions, or run a queued
prompt twice. All workload execution is observed on the host.

### 5. Prove reconnect behavior and release the mode

- Exercise network loss while streaming, while submitting a prompt, and while
  queued work is pending. Reconnect to the same session without restarting work
  or fabricating an acknowledgement.
- Exercise host restart, missing replay history, revoked credentials, and an
  incompatible host. Require a clean rebootstrap or explicit reconnect/login
  instead of displaying stale live state.
- Exercise the full host minimized/backgrounded and with Lite closed. Confirm
  which host close/quit paths end availability and document that behavior.
- Update the remote-access documentation and affected UI-surface documentation
  with setup, trust model, lifecycle, connection errors, and the completed parity
  matrix. Align reconnect documentation with the current bridge implementation.
- Compare full-mode and Lite startup/process/memory behavior. Report measured
  runtime savings without presenting shared Electron packaging as a small client
  download.

**Gate:** the acceptance scenarios below pass on supported client/host platforms,
with no regression to full Maestro or the existing web-desktop client.

## Verification and acceptance criteria

Use the existing bridge and web-desktop tests where they cover observable
contracts. Add focused regression coverage for isolation, authorization,
reconnect ambiguity, and shared-write races; avoid tests of forwarding alone.
Relevant existing suites include
[`electron-shim.test.ts`](../src/__tests__/web-desktop/electron-shim.test.ts) and
[`bridgeHandlers.test.ts`](../src/__tests__/main/web-server/handlers/bridgeHandlers.test.ts).
Run the affected tests, `npm run lint`, and the affected main/renderer/web-desktop
builds after implementation.

Tests are not a substitute for a real host-plus-client smoke run:

1. **Remote inventory:** use a Lite machine with no agent CLIs installed. Its
   visible sessions, history, available agents, and running status match the
   selected host, not any local Maestro installation.
2. **Remote execution:** submit a task and open a terminal. Observe the host's
   hostname, working directory, process, and resulting file change. Confirm no
   corresponding agent/terminal workload starts on Lite.
3. **Workflow parity:** exercise host workspace selection, Git, attachments,
   terminal interaction, automation, localhost previews, and host-owned browser
   interaction. Check both rendering and actual execution location.
4. **Durability:** close Lite during active and queued work. Reconnect and see
   the work continue or complete with one history/completion effect.
5. **Concurrency:** operate the full host and two remote clients concurrently.
   Navigate independently; update/delete a session; submit queued work. Verify
   no stale overwrite, resurrection, duplicate execution, or focus hijack.
6. **Reconnect:** drop the network before and after prompt acceptance, then
   restart the host. Verify honest submission state, event reconciliation, and
   no accidental resubmission.
7. **Security:** reject unauthorized access, revoked sessions, host-key changes,
   invalid TLS, and disallowed remote methods. Verify host A and host B retain
   separate auth/UI state even when tunnels reuse the same local port.
8. **Transports/platforms:** run SSH and direct HTTPS scenarios, including a
   cross-OS client/host pairing. Cover supported Windows, macOS, and Linux
   startup, SSH authentication, and tunnel shutdown behavior.
9. **Host lifetime:** prove minimized/background operation; closing Lite does not
   stop the host. Host shutdown produces a clear disconnected/unavailable state.
10. **Full-mode regression:** launch ordinary Maestro and the existing browser
    client and exercise session creation, execution, and reconnect after the
    startup/bridge changes.

## Principal risks and scope boundaries

- **Renderer-owned host work:** the current full client is part of the runtime,
  not merely an optional visual frontend. Do not promise unattended headless
  hosting without a separate ownership/lifecycle redesign.
- **Desktop-only surfaces:** browser/view relay and host filesystem interaction
  are the largest parity risks. Validate their design early; shipping the web
  wrapper alone would not satisfy an unqualified remote-workflow promise.
- **Shared-state races:** multiple clients make existing last-writer-wins paths
  more consequential. Fix the affected ownership/write contracts, not every store
  in the application.
- **Broad bridge exposure:** SSH encrypts transport; it does not make every IPC
  method appropriate for remote invocation. Authentication, method exposure,
  event filtering, and secret handling require explicit review.
- **Version mismatch:** host-served renderer assets reduce renderer/backend drift,
  but the native shell still needs a compatible connection contract and a clear
  upgrade error.
- **Meaning of lite:** this is less local execution and simpler setup. A separate
  small binary, cloud account service, public multi-tenant gateway, merged
  multi-host workspace, offline remote execution, and host auto-installation are
  not part of the requested attach-to-full-Maestro mode.

Recommended order: establish the contract and native-only parity design first;
then deliver the isolated Lite startup and SSH/HTTPS connection path; complete
shared-state and workflow behavior; finally prove interruption, security, and
cross-platform operation. Intermediate gates are implementation checkpoints,
not a redefinition of the finished feature.
