# Federation: Agent Guide

How Federation is put together, and what every change to an agent, a tab, or a setting must do so hosted agents keep working. Read it before you add or change an agent setting, a tab setting, an Edit Agent field, a composer chip, or any feature that acts on an agent. The user-facing story is [docs/federation.md](../federation.md).

## The pieces

An **SSH remote agent** runs its provider on a remote over SSH, driven turn by turn by this desktop. A **hosted agent** lives on a **host**: a `maestro-cli host` (or a full Maestro desktop) on the remote that owns the agent, its tabs, its queue, and its turns. A **peer** is a remote that runs a host. A **conductor** is any desktop or CLI that drives a hosted agent; several can drive the same one.

| Piece                    | What it does                                                                                                                                   | Where                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host                     | Owns hosted agents, serves the client protocol, broadcasts every change                                                                        | `src/cli/commands/host.ts`, `src/shared/maestro-lib/runtime/server.ts`                                                                                                                |
| Client                   | The protocol a conductor speaks (`MaestroClient`), over an SSH-forwarded WebSocket                                                             | `src/shared/maestro-lib/client/types.ts`, `src/shared/maestro-lib/client/ws-client.ts`                                                                                                |
| Peer mirror              | The desktop's in-memory copy of every peer's agents, kept live from the host's broadcast                                                       | `src/main/federation/peer-mirror-service.ts`, `src/renderer/stores/peerMirrorStore.ts`                                                                                                |
| Peer actions             | Every input a conductor sends a hosted agent (send, Stop, tabs, queue, settings), CLI and desktop                                              | `src/shared/maestro-lib/client/peer-actions.ts`                                                                                                                                       |
| Lift (Move to Host)      | Moves an SSH agent onto its host; the local agent becomes a pointer                                                                            | `src/shared/maestro-lib/agents/lift-plan.ts`, `src/shared/maestro-lib/agents/lift-run.ts`                                                                                             |
| Settings sync            | Keeps every conductor's copy of a hosted agent's settings in step with the host                                                                | `src/shared/maestro-lib/agents/lift-settings-sync.ts`, `src/renderer/services/liftedAgentSettingsSync.ts`                                                                             |
| Automatic Federation     | Keeps hosts running, installs them, moves SSH agents                                                                                           | `src/main/federation/auto-federation.ts`                                                                                                                                              |
| Mirror UI                | A hosted agent's Left Bar row (a local record with `liftedTo`), the Add Hosted Agent modal, the hosted agent's panel, composer, and Edit Agent | `src/renderer/services/hostedAgents.ts`, `src/renderer/components/AddHostedAgentModal.tsx`, `src/renderer/components/PeerAgentPanel/`, `src/renderer/components/HostedAgentSettings/` |
| CLI `peer:agent` targets | Routes a verb to a host instead of a local agent                                                                                               | `src/cli/services/peer-resolver.ts`                                                                                                                                                   |

The canonical utilities for each are indexed in CLAUDE.md under "Spawning and stopping agents"; read the full entries in [CANONICAL-UTILITIES.md](CANONICAL-UTILITIES.md) before you extend one.

## Who owns a hosted agent's settings

**The host.** A conductor loads the host's records when it connects, and folds in the host's broadcast (`sessions:lifecycleSync` `added` / `updated`) while it stays connected, so a change one conductor makes reaches every other conductor at once. A conductor keeps two kinds of local copy, and the settings sync reconciles both:

- The **pointer** a lift left behind (a `Session` with `liftedTo`). Edit Agent, the bookmark, and `maestro-cli update-agent <local-id>` still edit it, and the sync sends the change.
- **Pending edits** made in a mirrored agent's Edit Agent (`hostedAgentSettingsStore.pending`), held while the peer is down and sent when it reconnects.

The merge is three-way per field against the last value both sides agreed on: a host change is taken, a local change is sent, and both changed (or a first-sync difference) is a **conflict** the person settles: take host, keep mine, or an approved merge. Conflicts surface in the Federation Settings Conflicts modal and `maestro-cli federation conflicts|resolve`. A conductor never pushes a stale copy on its own.

Every setting has one of three scopes, recorded in code:

| Scope      | Meaning                                                                                                | Examples                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `shared`   | On the host; every conductor sees it; the sync sends and takes it                                      | model, effort, nudge, env, working directory, tab name                                   |
| `personal` | Each conductor's own; sent with that conductor's messages as `TurnOverrides`, never stored on the host | a tab's model, effort, read-only, save to History; thinking display, Enter to send, star |
| `machine`  | Means something on one machine only; never sent                                                        | Left Bar group, SSH settings, the maestro-p binary path                                  |

The tables are `AGENT_PATCH_FEDERATION`, `TAB_PATCH_FEDERATION`, and `TURN_OVERRIDE_FIELDS` in `src/shared/maestro-lib/agents/lift-settings-sync.ts`. They are `Record`s over `AgentPatchField`, `keyof TabPatch`, and `keyof TurnOverrides`, so a new field does not compile until someone decides its scope, and a test checks that every `shared` agent field is actually synced. Two more tables cover agent settings with no `AgentPatch` field: `HOSTED_SETTINGS_NOT_YET_SYNCED` (should be shared, the host cannot take it yet) and `CONDUCTOR_ONLY_SETTINGS` (`personal` or `machine` by design, never sent).

**The badges and the CLI read the same tables.** On a hosted agent (a lifted pointer, or a mirror through `HostedAgentSettingsModal`), Edit Agent draws a `FederationFieldBadge` on every field: From host, Yours only, This machine, or Not synced yet, plus Pending (an edit the host has not taken) or Conflict (opens the conflicts modal). `describeFederationField()` turns a field id into that status; the renderer feeds it `hostedFieldState()` and `maestro-cli show agent --json` reads the same answer through `federation_command` `settings-fields` (`readAgentFederation()`). A badge reads a context Edit Agent provides only for a hosted agent, so an ordinary local agent shows nothing.

## Checklist: adding or changing an agent setting

Do this for every new field on `Session` that a person sets (Edit Agent, a toggle, a composer chip, a CLI flag), including ones that look local today.

1. **Decide its scope** with the questions above. "Who should see this change: everyone driving the agent, only me, or only this machine?" If two conductors could reasonably want different values at once, it is `personal`. If it names a path, an ID, or a resource on one machine, it is `machine`.
2. **`shared`**: the host must store it and accept it.
   - Add it to `AgentPatch` (`src/shared/maestro-lib/client/types.ts`), to `buildAgentConfigPatch()` / `applyAgentConfigPatch()` and `AGENT_EDITABLE_KEYS` (`src/shared/maestro-lib/agents/rules.ts`), and to `agentPatchFromConfig()` (`src/shared/maestro-lib/runtime/server-requests.ts`).
   - Validate it in `parsePeerAgentAction()`'s `AGENT_PATCH_CHECKS` (`src/shared/maestro-lib/client/peer-actions.ts`).
   - Add its row to `AGENT_PATCH_FEDERATION` and its spec to `AGENT_FIELDS` (`lift-settings-sync.ts`): how it reads off a record (normalize "unset" to one spelling, or the sync sees a difference that never settles), how it becomes a patch, and whether it is free text two people may both extend (`mergeable`).
   - If a lift must carry it, add it to `planAgentLift()`'s import, or to `IMPORT_GAP_KEYS` so `liftFollowUpPatch()` sends it right after the import.
   - Map the matching `maestro-cli update-agent` flag for `peer:agent` targets (`src/cli/commands/update-agent.ts`).
3. **`personal`**: it rides on each message.
   - Add it to `TurnOverrides` and `normalizeTurnOverrides()` (`client/types.ts`), `TURN_OVERRIDE_FIELDS` and `TAB_PATCH_FEDERATION`, the `send` action parser, and the host's turn assembly (`turns/assemble.ts`, `turns/record-turn.ts`, the queued turn in `runtime/turns.ts`), and the desktop host's queue path (`withQueuedTurnOverrides()` and `queuedItemRunsReadOnly()` in `src/shared/queuedTurnSettings.ts`, `useRemoteIntegration.ts`, and the user entry `markTabRunningQueuedItem()` writes, which the exit synopsis reads).
   - Add the chip to the mirror composer (`PeerAgentComposer.tsx`, stored in `hostedAgentSettingsStore.tabChoices`) and the flag to `maestro-cli send <peer:agent>` (`peerTurnOverrides()` in `src/cli/commands/send.ts`).
4. **`machine`**: record the row with its reason, and keep the field out of `AGENT_FIELDS`. Nothing else. A machine or personal setting with no `AgentPatch` field at all goes in `CONDUCTOR_ONLY_SETTINGS`.
5. **Cannot reach the host yet** (no `AgentPatch` field): list it in `HOSTED_SETTINGS_NOT_YET_SYNCED` with the reason, and in the "Known limits" of [docs/federation.md](../federation.md). A silent gap is a bug.
6. **Its badge comes free from the table.** Put `<FederationFieldBadge field="<id>" />` next to the field's label, or wrap a slot in `<FederatedSetting field="<id>">`; the scope, reason, Pending and Conflict are read from the row you added. Never hand-write a scope in a component. `show agent --json` reports the new field with no change to the CLI.
7. **A new Edit Agent save argument**: name it in `EDIT_AGENT_SAVE_ARG_NAMES` (`NewInstanceModal/types.ts`; its length must match the `onSave` signature) and decide it in `HOSTED_SAVE_ARGS` (`HostedAgentSettingsModal.tsx`, a `Record` over the names). A `host` argument must also be written by `editedHostRecord()`.
8. **Document it**: the "Settings live on the host" list in [docs/federation.md](../federation.md), the parity rows in [CLI-UI-PARITY.md](CLI-UI-PARITY.md), and tests in `src/shared/maestro-lib/agents/__tests__/lift-settings-sync.test.ts`.

## Checklist: a feature that acts on an agent

A hosted agent's state is not in `sessionStore`; it is in the peer mirror, and its turns run on the host. What `sessionStore` holds is its Left Bar row: a local record with a `liftedTo` pointer (a lift leaves one; Add Hosted Agent makes one, `addHostedAgent()`). Only agents with a row show in the Left Bar, the Thinking pill (`liftedAgentKeys()`), and the palette; selecting the row shows the hosted agent (`followLiftedPointer()`). For any new action on an agent (a button, a palette command, a verb):

- **Does it make sense on a hosted agent?** If yes, it needs a peer action (`PeerAgentAction` and `runPeerAgentAction()`), a host-side handler, the mirror UI control, and the CLI's `peer:agent` routing (`routeAgentTarget()`), all the same change. If no, say so where the control would be (greyed, with a tooltip that names why), as the mirror composer does for slash commands and images.
- **Does it read the agent's settings?** Read the host record for a hosted agent, never the pointer's copy.
- **Does it start a turn?** A turn of a hosted agent runs on the host, never here: every local send path refuses a lifted agent (`liftedSendRefusal()`).
- **Does it name another agent by id?** Ids differ across machines: a lifted agent's id on the host is not its local id (`liftedTo.agentId`). See the peers section below.

## acappella: consult, delegation, peers, and the other branch-only settings

acappella carries settings rc does not have yet. Each is decided, and the badge on its Edit Agent field shows the decision:

| Setting                                                                  | Decision                                                                 | Where                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------- |
| `peerAgents`, `groupPeerAccess`, `worktreePeerAccess`, `peerDescription` | `shared`, synced (`AgentPatch`, `applyAgentConfigPatch()`, desktop host) | `AGENT_PATCH_FEDERATION`         |
| `tierTargets`                                                            | Not synced yet: a tier can name this machine's Local Models sources      | `HOSTED_SETTINGS_NOT_YET_SYNCED` |
| `gatewayUrl`, `runOn`                                                    | `machine`: a Local Models server or source as this machine reaches it    | `CONDUCTOR_ONLY_SETTINGS`        |
| `tokenProxyMode`, `backgroundRequests`, `tokenProxyRetrieval`            | `machine`: the token proxy runs in this machine's Maestro                | `CONDUCTOR_ONLY_SETTINGS`        |
| `systemOneOptOut`                                                        | `machine`: a hosted agent's turns ask System One on the host             | `CONDUCTOR_ONLY_SETTINGS`        |
| Voice wake phrase                                                        | `machine`: heard by this machine's microphone                            | `CONDUCTOR_ONLY_SETTINGS`        |
| Provider config options (other than model, effort, context window)       | `machine`: kept per provider on this machine                             | `CONDUCTOR_ONLY_SETTINGS`        |

How the branch-only semantics are met:

- **Peer grants name agent ids.** The sync compares a pointer's rows in the host's ids (`splitPeerRowsForHost()`, `buildLiftPeerIdMap()`): a row for an agent lifted to the same host is rewritten to its host id, a row for an agent the host holds is kept, and a row for any other agent is never sent and stays on the pointer. A pull writes the host's rows back in local ids and keeps those rows (`peerRowsFromHost()`). A lift rewrites the rows in its follow-up patch (`liftFollowUpPatch(agent, peerIds)`); when the other end is lifted later, the next sync sends the row. Edit Agent marks a row the host cannot honor (`PeerAgentsSection` `rowNotice`), and the mirror's Peers picker lists the host's agents.
- **Delegation and consults from a hosted agent's turn.** Both hosts stamp `MAESTRO_HOSTED_TURN=1` on a hosted agent's turn through one helper, `hostedTurnEnv()` (`lift-pointer.ts`): `assembleTurn()` for every turn `maestro-cli host` runs, and the desktop for a turn that arrived over the client protocol (a queued item marked `hostedTurn`). `maestro-cli ask` and `dispatch` inside such a turn refuse a target the host does not hold, or a `peer:agent` route, with `hostedTurnTargetRefusal()` (`TARGET_OFF_HOST`).
- **Model pickers.** The mirror's Edit Agent and composer both discover models on the peer's SSH remote, the host's machine. A lifted pointer still carries its SSH remote, so its Edit Agent lists the same models.
- **Edit Agent save arguments.** `editedHostRecord()` reads them by name (`readEditAgentSaveArgs()`), and `HOSTED_SAVE_ARGS` decides every one.

## Known gaps

- The settings in `HOSTED_SETTINGS_NOT_YET_SYNCED` (extra directories, the Agent Resilience retry switches, Codex auto reset, parked env vars, tier targets) have no host field yet.
- The Federation Settings Conflicts modal has no hotkey on purpose: it is reached from the conflicts toast, the command palette, and the menu, and only while conflicts exist.

## Verifying a change

Unit tests cover the pure pieces (`lift-settings-sync.test.ts`, `peer-actions.test.ts`, `liftedAgentSettingsSync.test.ts`). A change to what crosses the wire also needs one live run: a remote reachable over SSH running `maestro-cli host`, two conductors (two desktops, or a desktop and the CLI), a change on each, and a check that both see it and that the host's record (`maestro-cli show agent <peer:agent> --json`) holds it.
