# SCAN-WEB-RENDERER

Duplication and boundary analysis between `src/web/` and `src/renderer/` in the Maestro codebase.

Generated: 2026-03-20

---

## Shared Function Names

Functions defined in both `src/web/` and `src/renderer/`:

| Function                | web/ locations                                                                     | renderer/ locations                                                                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `formatTime`            | `src/web/mobile/MessageHistory.tsx:45`, `src/web/mobile/MobileHistoryPanel.tsx:28` | `src/renderer/components/GroupChatHistoryPanel.tsx:572`, `src/renderer/components/History/HistoryEntryItem.tsx:9`, `src/renderer/components/HistoryDetailModal.tsx:158`                                                                                                        |
| `formatTimestamp`       | `src/web/mobile/ResponseViewer.tsx:69`                                             | `src/renderer/components/GroupChatMessages.tsx:162`, `src/renderer/components/InlineWizard/WizardMessageBubble.tsx:59`, `src/renderer/components/Wizard/screens/ConversationScreen.tsx:52`, `src/renderer/utils/groupChatExport.ts:33`, `src/renderer/utils/tabExport.ts:34`   |
| `generateId`            | `src/web/hooks/useCommandHistory.ts:67`, `src/web/hooks/useOfflineQueue.ts:107`    | `src/renderer/hooks/session/useBatchedSessionUpdates.ts:99`, `src/renderer/hooks/ui/useLayerStack.ts:35`, `src/renderer/utils/ids.ts:2`                                                                                                                                        |
| `getSessionDisplayName` | `src/web/mobile/AllSessionsView.tsx:258`                                           | `src/renderer/components/MergeSessionModal.tsx:136`, `src/renderer/components/SendToAgentModal.tsx:105`, `src/renderer/components/UsageDashboard/AgentUsageChart.tsx:143`, `src/renderer/hooks/agent/useMergeSession.ts:115`, `src/renderer/hooks/agent/useSendToAgent.ts:113` |
| `hexToRgb`              | `src/web/components/PullToRefresh.tsx:220`                                         | `src/renderer/components/MermaidRenderer.tsx:17`, `src/renderer/utils/extensionColors.ts:16`                                                                                                                                                                                   |
| `StatusDot`             | Both define a `StatusDot` component                                                | (imported from `Badge.tsx` in web/)                                                                                                                                                                                                                                            |
| `MyComponent`           | Both directories contain this name                                                 | (likely separate implementations)                                                                                                                                                                                                                                              |
| `Tab`                   | Both directories contain this name                                                 | (likely separate implementations)                                                                                                                                                                                                                                              |

**Note:** `formatTime` alone has **5 independent implementations** across web/ and renderer/.

---

## Shared Type/Interface Names

Types and interfaces defined in both `src/web/` and `src/renderer/`:

| Type                     | web/ definition                                                                                                       | renderer/ definition                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `LogEntry`               | `src/web/hooks/useMobileSessionManagement.ts:46`, `src/web/mobile/MessageHistory.tsx:19`                              | `src/renderer/types/index.ts:178`                                                                                         |
| `QuickAction`            | `src/web/mobile/QuickActionsMenu.tsx:20` - `type QuickAction = 'switch_mode'`                                         | `src/renderer/components/QuickActionsModal.tsx:17` - `interface QuickAction { ... }`                                      |
| `Session`                | `src/web/hooks/useSessions.ts:28` - `interface Session extends SessionData`                                           | `src/renderer/types/index.ts` (imported throughout)                                                                       |
| `SessionState`           | `src/web/hooks/useSessions.ts:42` - `'idle' \| 'busy' \| 'error' \| 'connecting'`                                     | `src/renderer/types/index.ts:53` - `'idle' \| 'busy' \| 'waiting_input' \| 'connecting' \| 'error'`                       |
| `SessionStatus`          | `src/web/components/Badge.tsx:234`, `src/web/components/Card.tsx:405` - `'idle' \| 'busy' \| 'error' \| 'connecting'` | `src/renderer/components/SendToAgentModal.tsx:30` - `'idle' \| 'busy' \| 'current'`                                       |
| `SlashCommand`           | `src/web/mobile/SlashCommandAutocomplete.tsx:23`                                                                      | `src/renderer/components/InputArea.tsx:42`, `src/renderer/components/MainPanel.tsx:62`, `src/renderer/slashCommands.ts:6` |
| `UsageStats`             | `src/web/hooks/useWebSocket.ts:29`                                                                                    | `src/renderer/global.d.ts:142`                                                                                            |
| `BaseLogLevel`           | Both directories                                                                                                      | (shared name, separate definitions)                                                                                       |
| `CodeBlockWithCopyProps` | Both directories                                                                                                      | (shared name, separate definitions)                                                                                       |
| `TabBarProps`            | Both directories                                                                                                      | (shared name, separate definitions)                                                                                       |
| `TabProps`               | Both directories                                                                                                      | (shared name, separate definitions)                                                                                       |
| `Window`                 | Both directories                                                                                                      | (shared name, separate definitions)                                                                                       |

### Key Divergence: `SessionState`

The `SessionState` union type differs between web and renderer:

- **web:** `'idle' | 'busy' | 'error' | 'connecting'` (4 states)
- **renderer:** `'idle' | 'busy' | 'waiting_input' | 'connecting' | 'error'` (5 states - includes `'waiting_input'`)

### Key Divergence: `SessionStatus`

- **web:** `'idle' | 'busy' | 'error' | 'connecting'` (defined twice: `Badge.tsx:234` and `Card.tsx:405`)
- **renderer:** `'idle' | 'busy' | 'current'` (different semantics entirely)

### `SessionStatus` Duplicated Within web/

`SessionStatus` is defined identically in two web/ files:

- `src/web/components/Badge.tsx:234` - `export type SessionStatus = 'idle' | 'busy' | 'error' | 'connecting'`
- `src/web/components/Card.tsx:405` - `export type SessionStatus = 'idle' | 'busy' | 'error' | 'connecting'`

### `LogEntry` Duplicated Within web/

`LogEntry` is defined in two web/ files:

- `src/web/hooks/useMobileSessionManagement.ts:46` - `export interface LogEntry`
- `src/web/mobile/MessageHistory.tsx:19` - `export interface LogEntry`

---

## Cross-Boundary Imports

Direct imports from `src/web/` into `src/renderer/` (or vice versa):

| Source file                                 | Import                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `src/web/mobile/App.tsx:26`                 | `import { estimateContextUsage } from '../../renderer/utils/contextUsage'` |
| `src/web/mobile/SessionStatusBanner.tsx:36` | `import { estimateContextUsage } from '../../renderer/utils/contextUsage'` |

**2 cross-boundary imports found.** Both are `src/web/` importing from `src/renderer/`. The imported function `estimateContextUsage` should be moved to `src/shared/` or duplicated into `src/web/`.

No imports from `src/renderer/` into `src/web/` were found.

---

## Session Type Definitions (Combined View)

### src/web/ Session-related types (33 definitions):

- `src/web/components/Badge.tsx:234` - `type SessionStatus`
- `src/web/components/Card.tsx:405` - `type SessionStatus` (duplicate)
- `src/web/components/Card.tsx:408` - `interface SessionCardProps`
- `src/web/hooks/useMobileKeyboardHandler.ts:30` - `type MobileKeyboardSession`
- `src/web/hooks/useMobileSessionManagement.ts:56` - `interface SessionLogsState`
- `src/web/hooks/useMobileSessionManagement.ts:69` - `interface UseMobileSessionManagementDeps`
- `src/web/hooks/useMobileSessionManagement.ts:96` - `interface MobileSessionHandlers`
- `src/web/hooks/useMobileSessionManagement.ts:125` - `interface UseMobileSessionManagementReturn`
- `src/web/hooks/useMobileViewState.ts:62` - `interface SessionSelectionState`
- `src/web/hooks/useSessions.ts:28` - `interface Session extends SessionData`
- `src/web/hooks/useSessions.ts:42` - `type SessionState`
- `src/web/hooks/useSessions.ts:54` - `interface UseSessionsOptions`
- `src/web/hooks/useSessions.ts:80` - `interface UseSessionsReturn`
- `src/web/hooks/useWebSocket.ts:68` - `interface SessionData`
- `src/web/hooks/useWebSocket.ts:179` - `interface SessionsListMessage`
- `src/web/hooks/useWebSocket.ts:187` - `interface SessionStateChangeMessage`
- `src/web/hooks/useWebSocket.ts:200` - `interface SessionAddedMessage`
- `src/web/hooks/useWebSocket.ts:208` - `interface SessionRemovedMessage`
- `src/web/hooks/useWebSocket.ts:217` - `interface ActiveSessionChangedMessage`
- `src/web/hooks/useWebSocket.ts:225` - `interface SessionOutputMessage`
- `src/web/hooks/useWebSocket.ts:237` - `interface SessionExitMessage`
- `src/web/mobile/AllSessionsView.tsx:29` - `interface SessionCardProps`
- `src/web/mobile/AllSessionsView.tsx:35` - `interface MobileSessionCardPropsInternal`
- `src/web/mobile/AllSessionsView.tsx:416` - `interface AllSessionsViewProps`
- `src/web/mobile/App.tsx:48` - `interface SessionCommandDrafts`
- `src/web/mobile/App.tsx:53` - `type CommandDraftStore`
- `src/web/mobile/SessionPillBar.tsx:34` - `interface SessionPillProps`
- `src/web/mobile/SessionPillBar.tsx:240` - `interface SessionInfoPopoverProps`
- `src/web/mobile/SessionPillBar.tsx:727` - `interface SessionPillBarProps`
- `src/web/mobile/SessionStatusBanner.tsx:41` - `interface SessionStatusBannerProps`

### src/renderer/ Session-related types (selected, 30+ definitions):

- `src/renderer/types/index.ts:53` - `type SessionState`
- `src/renderer/components/AgentSessionsBrowser.tsx:53` - `interface AgentSessionsBrowserProps`
- `src/renderer/components/AgentSessionsModal.tsx:19` - `interface AgentSession`
- `src/renderer/components/AgentSessionsModal.tsx:31` - `interface SessionMessage`
- `src/renderer/components/AgentSessionsModal.tsx:40` - `interface AgentSessionsModalProps`
- `src/renderer/components/CuePipelineEditor/PipelineCanvas.tsx:56` - `interface SessionInfo`
- `src/renderer/components/MergeSessionModal.tsx:48` - `interface SessionListItem`
- `src/renderer/components/SendToAgentModal.tsx:30` - `type SessionStatus`
- `src/renderer/components/SendToAgentModal.tsx:35` - `interface SessionOption`

---

## Summary of Duplication

| Category                             | Count         | Risk                                                                     |
| ------------------------------------ | ------------- | ------------------------------------------------------------------------ |
| Shared function names (web/renderer) | 8+            | High - independent implementations can drift                             |
| Shared type names (web/renderer)     | 14            | High - `SessionState` already diverges                                   |
| Cross-boundary imports               | 2             | Medium - architectural boundary violation                                |
| `SessionStatus` defined within web/  | 2 (identical) | Low - simple dedup                                                       |
| `LogEntry` defined within web/       | 2             | Low - simple dedup                                                       |
| `SlashCommand` defined in renderer/  | 3             | Medium - three separate interface definitions                            |
| `getSessionDisplayName` in renderer/ | 5             | High - five independent implementations                                  |
| `formatTime`/`formatTimestamp` total | 8             | High - scattered across both directories                                 |
| `generateId` total                   | 5             | Medium - different implementations (crypto.randomUUID vs Date.now-based) |
