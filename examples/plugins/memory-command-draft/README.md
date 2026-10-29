---
type: reference
title: Memory command draft plugin
created: 2026-10-28
tags:
  - plugins
  - memory
related:
  - '[[CLI-UI-PARITY]]'
---

# Memory command draft

Installable source example for Host API 1.31.0. This folder is not bundled,
installed or enabled automatically. Installation uses the existing plugin
installer; trusted publisher signing and explicit capability consent are required.
See [plugin development](../../../docs/agent-guides/PLUGIN-DEVELOPMENT.md).

Grant `memory:selected`, `commands:preview`, and `agents:dispatch` restricted to
exact chosen Codex agent IDs, with separate unattended consent. Before installation, replace `REPLACE_WITH_CODEX_AGENT_ID` in `plugin.json` with
the exact generator ID (or comma-separated exact IDs). This source template grants
no access to existing agents. Wildcards are rejected by the manifest validator.
No filesystem, settings, network or general memory-read permission is requested.

In the Codex Memory Viewer, prepare a snapshot and explicitly generate. The host
passes only an opaque request ID to `generate`. This command fetches only that
request's released text, drafts through the selected existing Codex agent, and
returns the host-validated fields through `commands.openDraft`. It never saves a
command. Before the explicit save commit point, host cancellation, viewer closure,
replacement, permission revocation and plugin shutdown invalidate the request;
late output cannot revive it. An already authorized settings write retains its
confirmed `saved` receipt even if cleanup happens while it is pending.

The existing Plugins feature flag controls both Viewer and Settings draft controls
and subscriptions. Turning it off cancels active and staged drafts through the same
host path; turning it on does not restore them. Reading Codex memory and managing
ordinary global commands remain available.

The host uses the existing awaited sandbox command handler transport (`invokeTool`)
so failures and its existing timeout are observable. This adds no contributed tool,
provider, agent or spawn path. Status/errors contain no source or generated text;
the validated draft goes only to its authenticated owner or the native editor
explicitly requested by that owner. The existing global command form and CLI Save
share the host request checks and normal settings persistence. Native Codex
sandbox/network behavior requires separate runtime acceptance.

## Local CLI workflow

The matching CLI and running desktop build expose `memory-command select`,
`generate`, `status`, `cancel`, `preview`, and `save`. They require the per-boot local
CLI secret and the same active plugin, trust, exact generator grants and
unattended consent as the Viewer. Browser connections cannot use this entry.

```bash
maestro-cli memory-command select --file ./selection.json --viewer draft-work --json
maestro-cli memory-command generate <draftRequestId> --viewer draft-work --json
maestro-cli memory-command status <draftRequestId> --viewer draft-work --json
maestro-cli memory-command preview <draftRequestId> --viewer draft-work --background --json
# Optional editable delivery; background stages it under Settings > AI Commands.
maestro-cli memory-command preview <draftRequestId> --viewer draft-work --editor --background --json
# Only when asked to show the editor:
maestro-cli memory-command preview <draftRequestId> --viewer draft-work --editor --focus --json
# Or edit a JSON draft and explicitly save through the same host request:
maestro-cli memory-command preview <draftRequestId> --viewer draft-work --json | jq '.draft' > ./edited-draft.json
maestro-cli memory-command save <draftRequestId> --viewer draft-work --file ./edited-draft.json --json
maestro-cli memory-command status <draftRequestId> --viewer draft-work --json
maestro-cli memory-command cancel <draftRequestId> --viewer draft-work --json
```

`selection.json` is the explicit `MemoryCommandSelection` object defined in
[src/shared/memoryCommandDraft.ts](../../../src/shared/memoryCommandDraft.ts):
`sourceRef`, `textSnapshot`, `dirty`, optional UTF-16 `selection`, provisional
`requestId`, `status: "selected"`, and `generator`. Source identity must match the
stored Codex source agent. Generator model/effort hints confer no authority;
the host resolves its stored configuration. The JSON envelope is bounded to
1 MiB and the snapshot to 128 KiB of UTF-8. No native memory is read implicitly
by the CLI command.

`select` registers only; its returned `draftRequestId` is the ID for later verbs.
`generate` acknowledges dispatch without waiting for completion. Poll `status`
until `preview`, `cancelled`, or `error`; status contains no source or reply.
`preview` still reads the validated fields as JSON with no UI effect by default.
`--editor` additionally delivers them to the existing global command form in
Settings > AI Commands. Its default `--background` stages the preview without
opening Settings, changing its current section, or moving the active agent/tab.
Open Settings > AI Commands later and choose **Review draft**. Finish or cancel any
normal Create/Edit form first; delivery preserves its unsaved fields. Repeating
`preview --editor --focus` opens closed Settings at AI Commands; already open
Settings keep their current section. Repeated delivery preserves the same staged
or active draft and its edits. Delivery never writes settings. One live CLI editor
is supported at a time; another request cannot replace its edits. Closing Settings
discards staged and active requests; cancelling a normal form leaves the staged
draft available, while cancelling the adopted draft discards that request.

`save --file` accepts exactly `{ "command": "...", "description": "...", "prompt": "..." }`,
including edits, with the shared UTF-8 limits. A preview JSON response is an
envelope: extract `.draft` before editing/saving. The CLI reads only the explicit
file and never writes settings directly or opens a file dialog. Both CLI Save
and the native form use the same live owner/request checks, slash/collision rules,
and awaited settings writer. Only `status: "saved"` is success; collisions and
failed writes exit nonzero and leave the preview retryable. Rename a collision
and retry with the same request. A confirmed save cannot be replayed; `status`
remains readable as `saved`. Revoke/cancel/plugin stop/client loss before the
save commit point prevents a write. An already authorized write may finish, as
in the native form. CLI saves notify all desktop windows and existing web peers;
no command is executed by saving it.

The save commit point is the host's final live request/owner/permission check,
immediately followed by claiming `saving` and invoking the existing settings
writer, with no asynchronous gap between those operations. A false or rejected
write remains retryable while the request is live; cleanup during a failed write
discards it instead. Cleanup during a successful write cannot turn its receipt
into `cancelled` or permit a replay.

The local CLI secret authenticates one same-user host principal across command
reconnections. Use a distinct `--viewer` for each independent workflow and reuse
it on subsequent verbs (default `cli`). A new selection cancels that viewer’s
previous active request; cancellation, host navigation/loss and plugin shutdown
clear transient text/drafts. Socket close alone preserves the job so later
commands can poll or cancel it. At most 32 active requests share the existing
service bound. No request survives a desktop restart; cancel an unused preview.

## Acceptance limits

The source package includes synthetic coverage for the real plugin module, authenticated
CLI handler, request lifecycle, editor integration and shared settings writer.
They do not establish a native Electron/Codex/WebSocket run. The Codex memory
reader currently rejects SSH sources explicitly; it does not read a local fallback.
Native sandbox enforcement, MCP/network isolation and a generator's actual
model/effort/completion still require an authorized isolated runtime acceptance.
