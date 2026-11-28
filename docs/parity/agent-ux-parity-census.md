---
type: reference
title: Agent UX Parity Census (code-derived checklist)
created: 2026-11-25
tags:
  - parity
  - federation
  - ssh
related:
  - '[[agent-ux-parity]]'
---

# Agent UX Parity Census

The matrix in [[agent-ux-parity]] was written from a list of surfaces. This census was read from the code at commit `4748618469`, so it lists what the code does, not what a person remembered. It finds two classes of difference the matrix does not hold. Fold every row below into the matrix, then keep the matrix as the one record.

Line numbers are from that commit and will move.

This file is the first reading and is kept as it was. The status of each row now lives in the matrix under "Census rows": 25 commits after this reading, the mode labels (class C) and B2.3 and B2.13 were already closed, and the rest were re-checked and folded in as open rows.

## The rule, restated

A local agent, an SSH agent, and a hosted agent look and behave the same. The only visible difference is one small pill: `LOCAL`, `REMOTE`, or `HOSTED`. Where a turn, a file read, or a git command runs is transport, and may differ.

## How a mode difference gets into the code

There are only three ways. Each has one grep that finds every case.

| Class                           | What it is                                                                                                 | Find it with                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Turn does not reach the host | A feature starts a provider process for a hosted agent on this machine.                                    | Callers of `process.spawn`, `spawnAgentForSession`, `spawnBackgroundSynopsis`, `groomContext`, `spawnGroupChatAgent`, and the Cue executor. |
| B. UI reads the mode            | A component or hook shows, hides, disables, or relabels something when `sshRemoteId` or `liftedTo` is set. | `sshRemoteId`, `sessionSshRemoteConfig`, `hostedTargetOf`, `refuseOnHostedAgent`, `liftedTo` in `src/renderer`.                             |
| C. Mode label                   | A badge, pill, icon, or text that names the mode.                                                          | Table C below.                                                                                                                              |

## Class A: turns that do not reach the host

Main refuses a local spawn for a hosted record in one place only: `process:spawn` (`src/main/ipc/handlers/process.ts:278`), and only when the process id starts with the agent id (`liftedOwnerOfProcess`, `lift-pointer.ts`). A path that spawns another way, or with another id, is not refused: it runs from this machine.

### A1. Not in the matrix, no hosted check on the path

| #     | Feature                                       | Entry point                                              | What a hosted agent gets today                                                                                                   |
| ----- | --------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A1.1  | Goal-Driven Auto Run                          | `useBatchProcessor.ts:353` → `useGoalRunner.ts`          | Raw spawn refusal. The Auto Run guard (`useBatchRunner.ts:239`) is on the document branch only.                                  |
| A1.2  | Send to Agent into an existing agent          | `useMergeTransferHandlers.ts:413`, `:686`                | Raw spawn refusal after a local "From:" tab was made.                                                                            |
| A1.3  | Queue drain of an item queued here            | `agentStore.ts:800`, `:895`, `:1010`                     | Raw spawn refusal. Host-queued items are skipped; items queued here (Send to Agent, Quick Chat, remote enqueue) are not.         |
| A1.4  | Send from a web or phone client               | `useRemoteHandlers.ts:751`                               | Raw spawn refusal. No check in main's web-server path.                                                                           |
| A1.5  | Quick Chat                                    | `quickChatEngine.ts:972`, `quickChatRouter.ts:191`       | The routing call runs from here, then the turn is refused.                                                                       |
| A1.6  | Cue AI chat (YAML editor assistant)           | `useCueAiChat.ts:202`                                    | "Failed to start agent."                                                                                                         |
| A1.7  | `@mention` consult of a hosted agent          | `crossAgentMentions.ts:231` → `consult-runner.ts:109`    | Runs from this machine (`cross-agent-` id, direct `processManager.spawn`).                                                       |
| A1.8  | Cue prompt subscription on a hosted agent     | `cue-run-router.ts:437` → `cue-executor.ts:260`          | Runs from this machine (Cue's own child process).                                                                                |
| A1.9  | Group chat participant that is a hosted agent | `router.ts:1238`, `:1740` → `spawnGroupChatAgent.ts:287` | Runs from this machine.                                                                                                          |
| A1.10 | Inline wizard from the Auto Run panel button  | `useWizardHandlers.ts:1091`                              | Runs from this machine (`inline-wizard-` id) and makes a local tab. The composer's `/wizard` refusal does not cover this button. |
| A1.11 | Rename Tab, "Auto" button                     | `useSessionLifecycle.ts:464` → `tabNaming.ts:750`        | Runs from this machine, then pushes the name to the host.                                                                        |
| A1.12 | AI command suggestion (command mode)          | `useInputProcessing.ts:509` → `aiCommand.ts`             | Runs from this machine. It runs before the hosted check at `:559`.                                                               |
| A1.13 | Pianola watchers                              | `pianola-supervisor.ts:292`                              | Not determined.                                                                                                                  |

### A2. In the matrix, refused with a toast

Fork, Merge context, Session recovery, Summarize & Continue, Auto Run (document mode), `/wizard` and the inline wizard from the composer.

### A3. Decision needed for one-shot calls

A hosted record keeps its SSH remote. A one-shot call that writes nothing into the agent's tabs (A1.11, A1.12, the Quick Chat routing call, context grooming) gives the same result when it runs over that SSH remote as an SSH agent's does. Proposed rule: a stateless one-shot may run over the record's SSH remote, and is ✅ once a test shows it does. Only a turn that writes to the agent's tabs, transcript, or queue must go to the host.

## Class B: UI that reads the mode

"SSH+HOSTED" means the branch reads the SSH fields, which a hosted record keeps.

### B1. Controls hidden or disabled for SSH+HOSTED

| #     | Surface                        | File                                                                          | What differs                                                                                                    |
| ----- | ------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| B1.1  | File tab menu                  | `TabBar/FileTab.tsx:568`                                                      | Reveal in Finder hidden.                                                                                        |
| B1.2  | File preview toolbar           | `FilePreview/FilePreviewHeader.tsx:280`, `:368`, `:380`                       | Open in Maestro Browser, Open in Default App, Reveal in Finder hidden.                                          |
| B1.3  | Files panel toolbar            | `FileExplorerPanel.tsx:608`                                                   | "Open" (file manager) hidden.                                                                                   |
| B1.4  | File tree menu                 | `FileTreeContextMenu.tsx:144`, `:216`, `:226`, `:283`, `:400`, `:412`, `:461` | Play, Add to Play Queue, Open in Default App, New Agent Here, Open in Maestro Browser, Reveal in Finder hidden. |
| B1.5  | Chat file-link menu            | `FileContextMenu.tsx:158`, `:195`                                             | Open in Default App and Reveal hidden.                                                                          |
| B1.6  | Quick Actions                  | `commands/navigationCommands.ts:159`                                          | "Open in Finder: Working Directory" hidden.                                                                     |
| B1.7  | Save Markdown modal            | `SaveMarkdownModal.tsx:188`                                                   | Folder-browse button hidden.                                                                                    |
| B1.8  | Auto Run setup modal           | `AutoRun/AutoRunSetupModal.tsx:239`-`:254`                                    | Browse disabled; Cmd+O does nothing.                                                                            |
| B1.9  | Worktree config modal          | `WorktreeConfigModal.tsx:278`-`:384`                                          | Browse disabled; "Remote session" notice.                                                                       |
| B1.10 | Playbook import footer         | `PlaybookImportFooter.tsx:62`                                                 | Browse disabled.                                                                                                |
| B1.11 | Edit Agent modal               | `EditAgentModal.tsx:1147`-`:1194`                                             | Path picker and extra-dirs Browse disabled.                                                                     |
| B1.12 | Agent config panel             | `shared/AgentConfigPanel.tsx:551`-`:900`                                      | Re-detect and install chooser hidden; Claude token source drops options; Maestro-P path hidden.                 |
| B1.13 | Composer permission mode       | `InputArea/InputArea.tsx:199`                                                 | OpenCode "Standard" removed.                                                                                    |
| B1.14 | Agent error modal              | `useAgentErrorRecovery.tsx:127`                                               | Install action withheld.                                                                                        |
| B1.15 | Send menu and queue card Steer | `utils/sendMenu.ts:87`, `utils/executionQueue.ts:889`                         | Steer disabled for SSH Claude TUI (already 🔒 in the matrix).                                                   |

### B2. Different text, extra elements, or different behavior for SSH+HOSTED

| #     | Surface                           | File                                                                          | What differs                                                                          |
| ----- | --------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| B2.1  | File tree menu                    | `FileTreeContextMenu.tsx:424`                                                 | Extra "Download File" item.                                                           |
| B2.2  | File preview, binary fallback     | `FilePreview.tsx:2771`                                                        | "Download & Open" instead of "Open in Default App".                                   |
| B2.3  | Files panel header and loading    | `FileExplorerPanel.tsx:719`, `:760`, `:828`, `FileTreeLoadingProgress.tsx:31` | Server icon, `host:path` tooltip, "Loading remote files...", Cancel only when remote. |
| B2.4  | File tree row                     | `FileTreeRow.tsx:163`                                                         | Double-click on HTML does not open the browser.                                       |
| B2.5  | File drag-out                     | `useOsFileDragOut.ts:79`                                                      | Folders refused; a file needs two drags.                                              |
| B2.6  | Opening PDF and other files       | `useAppHandlers.ts:378`, `useFileExplorerEffects.ts:156`                      | Local asks to open externally; SSH previews or does nothing.                          |
| B2.7  | File tree size                    | `useFileTreeManagement.ts:283`                                                | Smaller entry cap when the SSH-reduce setting is on.                                  |
| B2.8  | Auto Run folder pick              | `useAutoRunHandlers.ts:547`                                                   | Setup modal opens instead of the native picker.                                       |
| B2.9  | Create PR modal                   | `CreatePRModal.tsx:176`                                                       | gh check skipped, so no install or auth warning.                                      |
| B2.10 | Terminal tab exit                 | `TerminalView.tsx:417`                                                        | An exited tab is always kept.                                                         |
| B2.11 | Worktree auto-discovery           | `useWorktreeHandlers.ts:1584`                                                 | Watch has no effect.                                                                  |
| B2.12 | SSH outage dialog                 | `SshUnreachableModal.tsx:55`                                                  | Shared outage dialog instead of the per-agent error modal.                            |
| B2.13 | Terminal cwd and command-mode bar | `InputArea/utils/terminalPath.ts:12`, `CommandModeBar.tsx:70`                 | `REMOTENAME:` prefix on the path.                                                     |

### B3. HOSTED only

| #    | Surface                         | File                                                                     | What differs                                                                                           |
| ---- | ------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| B3.1 | Queue reorder                   | `services/queuedPrompt.ts:574`                                           | A card queued here and a host-queued card cannot be reordered across each other.                       |
| B3.2 | `/btw`                          | `services/sideQuestion.ts:63`                                            | Fails in a tab kept from before the move.                                                              |
| B3.3 | Hosted badge hover card         | `FederationBadge.tsx:76`                                                 | Says "Reconnect from the banner in its view". No such banner exists in `src/renderer`.                 |
| B3.4 | Left Bar menu and Quick Actions | `SessionContextMenu.tsx:412`, `:433`, `federationCommands.ts:76`, `:100` | Move to Host (SSH only) and Move Back from Host (hosted only). One slot; this is the transport toggle. |

### B4. No mode branch found (candidate ✅ once tested)

`useMainKeyboardHandler`, `AITab`, `AITabOverlayMenu`, `ChatComposer/`, `LogItem`, `HistoryPanel`, `GitLogViewer`, `ModelEffortModal`, `QueuedItemEditModal`, `BatchRunnerModal`, `DocumentGraphView`, `AgentSessionsBrowser`. They pass the remote id through and draw the same.

## Class C: mode labels (13 today, 1 wanted)

| #   | Where                                 | File                                  | LOCAL                    | SSH                                        | HOSTED              |
| --- | ------------------------------------- | ------------------------------------- | ------------------------ | ------------------------------------------ | ------------------- |
| C1  | Left Bar badge                        | `SessionList/FederationBadge.tsx:84`  | nothing                  | `SSH`                                      | `Hosted`            |
| C2  | Left Bar location pill                | `SessionItem.tsx:598`-`:647`          | `GIT` / `LOCAL`          | Server icon + `GIT` / `REMOTE`             | as SSH              |
| C3  | Left Bar hover tooltip                | `SessionTooltipContent.tsx:42`-`:121` | `GIT` / `LOCAL`          | Server pill, `REMOTE`, " (SSH)"            | as SSH              |
| C4  | Main header badge                     | `MainPanelHeader.tsx:411`             | nothing                  | `SSH`                                      | `Hosted`            |
| C5  | Main header git pill                  | `MainPanelHeader.tsx:425`-`:469`      | branch / `GIT` / `LOCAL` | purple `REMOTENAME` + a second branch pill | as SSH              |
| C6  | `@`-mention picker                    | `AtMentionPopover.tsx:235`            | nothing                  | `REMOTENAME` pill                          | as SSH              |
| C7  | Group chat participant card           | `ParticipantCard.tsx:182`             | nothing                  | `REMOTENAME` pill                          | as SSH              |
| C8  | Terminal cwd                          | `terminalPath.ts:13`                  | `~/path`                 | `REMOTENAME:~/path`                        | as SSH              |
| C9  | Command-mode bar                      | `CommandModeBar.tsx:70`               | `path`                   | `name:path`                                | as SSH              |
| C10 | Files panel header                    | `FileExplorerPanel.tsx:719`           | nothing                  | Server icon                                | as SSH              |
| C11 | Process Monitor                       | `ProcessListView.tsx:198`             | nothing                  | `SSH: name`                                | as SSH              |
| C12 | Usage dashboard                       | `SessionStats.tsx:135`                | counted local            | "N remote"                                 | counted remote      |
| C13 | Left Bar and Quick Actions menu items | see B3.4                              | none                     | Move to Host                               | Move Back from Host |

A hosted agent can show three labels at once: `Hosted`, a Server or `REMOTE` pill, and the purple remote-name pill. Only C6 and C7 use the shared `SshRemotePill`; the Left Bar, the tooltip, and the header each draw their own.

Target: one component, `LOCAL` / `REMOTE` / `HOSTED`, drawn in the Left Bar row and the Main Window header. The git state (`GIT`, branch) is not a mode label and stays, drawn the same in every mode. The remote's name moves to the pill's tooltip.

## Tiers

| Tier | Meaning                                           | Rows                                                                                                                 |
| ---- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1    | A hosted agent does everything an SSH agent does. | A1, A2, B3.                                                                                                          |
| 2    | One pill.                                         | C.                                                                                                                   |
| 3    | An SSH agent looks like a local agent.            | B1, B2. Older than hosted agents. Each row needs a ruling: make it work (download, then act), or 🔒 with the reason. |

## Test rule

One shared helper builds the same agent in three modes and compares the rendered DOM with the mode pill removed. Ten test files build their own three fixtures today; none share a helper. A row is ✅ only when its surface passes through that helper.
