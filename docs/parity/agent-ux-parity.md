---
type: reference
title: Agent UX Parity Matrix (Local, SSH, Hosted)
created: 2026-11-25
tags:
  - parity
  - federation
  - ssh
related:
  - '[[CLAUDE-PLATFORM]]'
---

# Agent UX Parity Matrix

The rule: a local agent, an SSH agent, and a hosted SSH agent look and behave the same in every surface. Only the transport differs:

| Mode   | Where the AI turn runs                                                         |
| ------ | ------------------------------------------------------------------------------ |
| Local  | A provider process that this Maestro spawns on this machine.                   |
| SSH    | This Maestro spawns the provider over SSH (`wrapSpawnWithSsh()`).              |
| Hosted | The Maestro host on the remote spawns it; this Maestro sends `federation:act`. |

The one permitted visual difference is the **transport label**: the `SSH` / `Hosted` badge (`SessionFederationBadge`) and the location pill (`LOCAL` / `GIT` / remote name). Any other place where SSH or hosted takes its own UI branch is a defect. Fix it by collapsing to the same component and props, and route only the action through the transport.

## Legend

| Mark | Meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| ✅   | Identical in all three modes, with a test that renders or runs each mode.                    |
| 🟢   | Same component and props in the code (read, no mode branch). A three-mode test is still due. |
| ❌   | Defect: a mode takes its own UI branch or loses behavior.                                    |
| 🔒   | Execution-only constraint that cannot be removed. The reason and the code path are given.    |
| ⏳   | Not audited yet.                                                                             |

## Matrix

### Left Bar

| Surface                                                  | Status | Code path                                                       | Test                       | Notes                                                                                                                                                     |
| -------------------------------------------------------- | ------ | --------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent row (name, provider, meta row)                     | 🟢     | `SessionItem.tsx`                                               |                            | One component for all modes.                                                                                                                              |
| Transport badge in the row                               | 🟢     | `SessionList/SessionFederationBadge.tsx`, `FederationBadge.tsx` | `FederationBadge.test.tsx` | The permitted label.                                                                                                                                      |
| Location pill (`LOCAL` / `GIT` / `REMOTE` / server icon) | 🟢     | `SessionItem.tsx` (`showLocationPills`)                         |                            | Keyed on `sessionSshRemoteConfig`, which a hosted record keeps. Permitted label.                                                                          |
| Right-click menu                                         | ❌     | `SessionList/SessionContextMenu.tsx`                            |                            | Move to Host / Move Back from Host are the transport toggle (one slot). Audit the other rows for hosted gating (`duplicateAgentBlocker`, worktree items). |

### Main Window header

| Surface                                               | Status | Code path                       | Test                                                                            | Notes                                                             |
| ----------------------------------------------------- | ------ | ------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Transport badge                                       | ✅     | `MainPanel/MainPanelHeader.tsx` | `MainPanelHeader.test.tsx` "local, SSH, and hosted agents draw the same header" | Was drawn for hosted only; now the Left Bar badge for every mode. |
| Everything else in the header (pills, buttons, menus) | ✅     | `MainPanelHeader.tsx`           | same suite, "draws everything else identically"                                 | DOM compared with the transport label taken out.                  |
| Session id, cost, context pills                       | 🟢     | `MainPanelHeader.tsx`           |                                                                                 |                                                                   |

### Tab bar

| Surface                   | Status | Code path                                                                        | Test | Notes                                              |
| ------------------------- | ------ | -------------------------------------------------------------------------------- | ---- | -------------------------------------------------- |
| New tab                   | 🟢     | `hooks/tabs/internal/useAITabHandlers.ts` → `openHostedTab()`                    |      | Action routes to the host; the tab draws the same. |
| Close / rename / star     | 🟢     | `services/hostedTurns.ts` (`closeHostedTab`, `renameHostedTab`, `starHostedTab`) |      | Transport only.                                    |
| Tab chip and overlay menu | ⏳     | `TabBar/AITab.tsx`, `TabBar/AITabOverlayMenu.tsx`                                |      |                                                    |

### Composer

| Surface                                                                | Status | Code path                                                                                                             | Test                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Send button (Enter) column                                             | 🟢     | `ChatComposer/ComposerSendColumn.tsx`                                                                                 |                                                                                          | No mode branch in the column. The "missing Enter button" report is not reproduced in code yet; needs a live check.                                                                                                                                                                                                                               |
| Image paste / drop / attach                                            | 🟢     | `hooks/input/useInputHandlers.ts` (`handlePaste`, `handleDrop`), `ChatComposer/capabilities.ts` (`aiCanAttachImages`) |                                                                                          | Same staging path in all modes.                                                                                                                                                                                                                                                                                                                  |
| Images on send                                                         | ✅     | `main/ipc/handlers/federation.ts` (`inlineSendImageRefs`)                                                             | `federation.test.ts` "sends a stored image ref as the data URL a local spawn would read" | Defect fixed: a staged image the store had relocated (`maestro-image://store/...`, after a restart or a replay) was sent as a ref, and `parsePeerAgentAction` refused it ("images must be a list of data URLs"). Local and SSH resolve refs at spawn (`launch/image-refs.ts` `parseDataUrl`); hosted now resolves them before the action leaves. |
| Send menu: Queue, Force Send                                           | 🟢     | `utils/sendMenu.ts`                                                                                                   |                                                                                          |                                                                                                                                                                                                                                                                                                                                                  |
| Send menu: Steer, Queue Held                                           | ❌     | `utils/sendMenu.ts` (`HOSTED_ROW_REASON`)                                                                             |                                                                                          | WIP disables both on hosted. `enqueue_command` already takes `held`, so Queue Held can route to the host. Steer needs a host action.                                                                                                                                                                                                             |
| Slash commands `/history`, `/wizard`, `/skills`, `/btw`, inline wizard | ❌     | `hooks/input/useInputProcessing.ts` (`hostedLocalOnlyAction`)                                                         |                                                                                          | Refused with a toast on hosted.                                                                                                                                                                                                                                                                                                                  |
| Model / effort / read-only / save to History                           | 🟢     | `hostedTurns.ts` (`hostedTurnOverrides`)                                                                              |                                                                                          | Same pills; values travel with each turn.                                                                                                                                                                                                                                                                                                        |
| Thinking pill                                                          | 🟢     | `InputArea/hooks/useAiTabToolbarBinding.ts` → `updateHostedTab()`                                                     |                                                                                          | Same pill; setting pushed to the host tab.                                                                                                                                                                                                                                                                                                       |
| Repeat-submit guard                                                    | 🟢     | `useInputProcessing.ts` (`composerSubmitsInFlight`)                                                                   |                                                                                          | Hosted now uses the same guard as local.                                                                                                                                                                                                                                                                                                         |
| Design Mode chips                                                      | 🟢     | `useInputProcessing.ts` (`expandDesignPicks`)                                                                         |                                                                                          | Expanded as a local send expands them.                                                                                                                                                                                                                                                                                                           |
| Interrupt / Stop                                                       | 🟢     | `services/turnInterrupt.ts` → `interruptHostedTurn()`                                                                 |                                                                                          | Transport only.                                                                                                                                                                                                                                                                                                                                  |

### Queue

| Surface                           | Status | Code path                                           | Test                             | Notes                                               |
| --------------------------------- | ------ | --------------------------------------------------- | -------------------------------- | --------------------------------------------------- |
| Queued cards under the transcript | ❌     | `QueuedItemsList.tsx` (`hostOnly`)                  |                                  | Hosted cards drop Force Send, Steer, Edit, drag.    |
| Execution Queue browser           | ❌     | `ExecutionQueueBrowser.tsx` (`hostOnly`)            | `ExecutionQueueBrowser.test.tsx` | Hosted items drop Edit, Merge, Force Send, reorder. |
| Remove, Hold / Resume             | 🟢     | `services/queuedPrompt.ts` (`hostQueuedItemTarget`) |                                  | Transport only.                                     |

### Actions refused on hosted agents (WIP `refuseOnHostedAgent`)

Each is a visible difference (a toast where local and SSH act). Each needs a host route, or a 🔒 entry with its reason.

| Action                      | Status | Code path                                |
| --------------------------- | ------ | ---------------------------------------- |
| Fork conversation           | ❌     | `hooks/agent/useForkConversation.ts`     |
| Merge context into this tab | ❌     | `hooks/agent/useMergeSession.ts`         |
| Session recovery            | ❌     | `hooks/agent/useSessionRecovery.ts`      |
| Summarize & Continue        | ❌     | `hooks/agent/useSummarizeAndContinue.ts` |
| Auto Run                    | ❌     | `hooks/batch/internal/useBatchRunner.ts` |

### Transcript and panels

| Surface                                   | Status | Code path                                                                                                    | Test | Notes                                                                                                                                 |
| ----------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Message rendering, tool cards, formatting | 🟢     | `utils/hostedSession.ts` folds host entries into `session.aiTabs[].logs`; drawn by the same `TerminalOutput` |      |                                                                                                                                       |
| Transcript images moved by Move to Host   | ❌     | `main/federation/lift.ts`                                                                                    |      | Logs and queued items carry `maestro-image://` refs into this machine's store; the host cannot read them. Same fix shape as the send. |
| History panel                             | 🟢     | `HistoryPanel.tsx`, `History/historySource.ts`                                                               |      | Same panel; the source is the host's history.                                                                                         |
| Files panel                               | ⏳     | `FileExplorerPanel/`                                                                                         |      |                                                                                                                                       |
| Terminal tabs                             | ⏳     | `TerminalView.tsx`, `XTerminal.tsx`                                                                          |      |                                                                                                                                       |
| Auto Run panel                            | ⏳     | `AutoRun/`                                                                                                   |      |                                                                                                                                       |
| Error cards                               | ⏳     | `MainPanel/AgentErrorBanner.tsx`                                                                             |      |                                                                                                                                       |

### Connection prompts

| Surface                                   | Status | Code path                                       | Test                       | Notes                                                                                                                                                      |
| ----------------------------------------- | ------ | ----------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSH unreachable dialog and restored toast | 🟢     | `main/ssh-reachability.ts` (`hasLiveTransport`) | `ssh-reachability.test.ts` | WIP: a 255 while Federation holds a live connection to the remote costs no probe, so a hosted agent's remote stops cycling the dialog. Needs a live check. |
| Host reconnect banner                     | ⏳     |                                                 |                            |                                                                                                                                                            |

### Other surfaces

| Surface                     | Status | Code path                             |
| --------------------------- | ------ | ------------------------------------- |
| Settings / Edit Agent modal | ⏳     | `NewInstanceModal/EditAgentModal.tsx` |
| Quick Actions (Cmd+K)       | ⏳     | `QuickActionsModal/`                  |
| Keyboard shortcuts          | ⏳     | `useMainKeyboardHandler`              |
| Hamburger menu              | ⏳     | `HamburgerMenuContent.tsx`            |
| Restore prompts on launch   | ⏳     |                                       |
