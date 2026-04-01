# SCAN-STATE.md - State Management Duplicates

Generated via `grep -rn` on `src/`. All matches are file:line verified. Tests excluded.

---

## setSessions calls in src/renderer/ (463 total, non-test)

### Definition and store plumbing

```
src/renderer/stores/sessionStore.ts:51      setSessions type signature
src/renderer/stores/sessionStore.ts:61      doc comment: "More efficient than setSessions for single-session updates"
src/renderer/stores/sessionStore.ts:100     setSessionsLoaded signature
src/renderer/stores/sessionStore.ts:164     setSessions implementation
src/renderer/stores/sessionStore.ts:240     setSessionsLoaded implementation
src/renderer/stores/sessionStore.ts:419     getSessionActions helper (exports setSessions)
src/renderer/stores/sessionStore.ts:424     setSessions in getSessionActions
src/renderer/stores/sessionStore.ts:435     setSessionsLoaded in getSessionActions
```

### Heavy callers (by file, sorted by count)

| File                                                  | setSessions calls | Notes                       |
| ----------------------------------------------------- | ----------------- | --------------------------- |
| `src/renderer/hooks/wizard/useWizardHandlers.ts`      | ~35               | Wizard state updates        |
| `src/renderer/hooks/worktree/useWorktreeHandlers.ts`  | ~18               | Worktree session management |
| `src/renderer/App.tsx`                                | ~15               | Main app coordinator        |
| `src/renderer/components/FileExplorerPanel.tsx`       | ~14               | File tree mutations         |
| `src/renderer/components/QuickActionsModal.tsx`       | ~7                | Quick actions               |
| `src/renderer/hooks/tabs/useTabHandlers.ts`           | ~6                | Tab operations              |
| `src/renderer/hooks/ui/useAppHandlers.ts`             | ~8                | App-level handlers          |
| `src/renderer/stores/agentStore.ts`                   | ~5                | Agent store bridging        |
| `src/renderer/stores/tabStore.ts`                     | ~4                | Tab store bridging          |
| `src/renderer/components/AppModals.tsx`               | ~6                | Modal state updates         |
| `src/renderer/components/SessionList/SessionList.tsx` | ~5                | Session list operations     |

### Type signature prop-drilling (setSessions passed as props)

```
src/renderer/components/AppModals.tsx:435       setSessions prop in interface
src/renderer/components/AppModals.tsx:767       setSessions prop in second interface
src/renderer/components/FileExplorerPanel.tsx:338   setSessions in function params
src/renderer/components/FileExplorerPanel.tsx:344   setSessions in function params
src/renderer/components/FileExplorerPanel.tsx:348   setSessions in function params
src/renderer/components/FileExplorerPanel.tsx:352   setSessions in function params
src/renderer/components/FileExplorerPanel.tsx:355   setSessions in interface
src/renderer/components/QuickActionsModal.tsx:27    setSessions prop in interface
src/renderer/components/RenameSessionModal.tsx:13   setSessions prop in interface
src/renderer/components/RightPanel.tsx:58           setSessions in function params
src/renderer/components/RightPanel.tsx:64           setSessions in function params
src/renderer/components/RightPanel.tsx:68           setSessions in function params
src/renderer/components/RightPanel.tsx:72           setSessions in function params
src/renderer/hooks/agent/useAgentExecution.ts:33    setSessions in hook interface
```

### Components accessing store directly vs receiving as prop

Many components both receive `setSessions` as a prop AND access it via `useSessionStore`:

```
src/renderer/components/RightPanel.tsx:121          useSessionStore access
src/renderer/components/AppModals.tsx:2124          useSessionStore access
src/renderer/components/SessionList/SessionList.tsx:150   useSessionStore.getState()
```

---

## sessions.find calls in src/renderer/ (71 total, non-test)

### Pattern: `sessions.find(s => s.id === activeSessionId)` (most common)

```
src/renderer/components/AppModals.tsx:2127
src/renderer/components/BatchRunnerModal.tsx:106
src/renderer/components/ExecutionQueueBrowser.tsx:118
src/renderer/components/QuickActionsModal.tsx:231
src/renderer/components/RightPanel.tsx:119
src/renderer/hooks/modal/useModalHandlers.ts:179
src/renderer/hooks/tabs/useTabHandlers.ts:414
src/renderer/hooks/tabs/useTabHandlers.ts:514
src/renderer/hooks/tabs/useTabHandlers.ts:556
src/renderer/hooks/tabs/useTabHandlers.ts:652
src/renderer/hooks/tabs/useTabHandlers.ts:711
src/renderer/hooks/tabs/useTabHandlers.ts:769
src/renderer/hooks/tabs/useTabHandlers.ts:832
src/renderer/hooks/tabs/useTabHandlers.ts:904
src/renderer/hooks/tabs/useTabHandlers.ts:931
src/renderer/hooks/tabs/useTabHandlers.ts:971
src/renderer/hooks/tabs/useTabHandlers.ts:1069
src/renderer/hooks/tabs/useTabHandlers.ts:1309
src/renderer/stores/sessionStore.ts:320
src/renderer/stores/sessionStore.ts:331
src/renderer/stores/agentStore.ts:132
```

Note: `useTabHandlers.ts` alone has 13 `sessions.find` calls, all using the same `s.id === activeSessionId` pattern. The store has a `getActiveSession` selector (`sessionStore.ts:320`) and a `getSessionById` selector (`sessionStore.ts:331`) that should be used instead.

### Pattern: `sessions.find(s => s.id === <other-id>)`

```
src/renderer/components/AgentSessionsBrowser.tsx:448     activeAgentSessionId
src/renderer/components/AppModals.tsx:336                mapping over IDs
src/renderer/components/AppModals.tsx:2443               duplicatingSessionId
src/renderer/components/QuickActionsModal.tsx:314         parentSessionId
src/renderer/components/RenameSessionModal.tsx:42         sessionIdToRename
src/renderer/components/SessionList/SessionList.tsx:254   contextMenu.sessionId
src/renderer/components/SessionList/SessionList.tsx:292   sessionId param
src/renderer/components/SymphonyModal.tsx:2120            contribution.sessionId
src/renderer/components/UsageDashboard/AgentUsageChart.tsx:148   sessionId prefix
src/renderer/hooks/agent/useMergeSession.ts:616                 targetSessionId
src/renderer/hooks/agent/useMergeTransferHandlers.ts:304        targetSessionId
src/renderer/hooks/batch/useAutoRunHandlers.ts:329              worktreeTarget sessionId
src/renderer/hooks/batch/useBatchHandlers.ts:596                sessionId param
src/renderer/hooks/batch/useBatchProcessor.ts:623               sessionId param
src/renderer/hooks/git/useFileTreeManagement.ts:272             sessionId param
src/renderer/hooks/git/useFileTreeManagement.ts:376             activeSessionId
src/renderer/hooks/git/useFileTreeManagement.ts:570             activeSessionId
src/renderer/hooks/git/useFileTreeManagement.ts:582             activeSessionId
src/renderer/hooks/groupChat/useGroupChatHandlers.ts:385        groupChatId match
src/renderer/hooks/session/useSessionCrud.ts:286                id param
```

### Pattern: `sessions.find(s => s.id === activeSession?.id)` in wizard

```
src/renderer/hooks/wizard/useWizardHandlers.ts:181
src/renderer/hooks/wizard/useWizardHandlers.ts:386
src/renderer/hooks/wizard/useWizardHandlers.ts:494
src/renderer/hooks/wizard/useWizardHandlers.ts:677
src/renderer/hooks/wizard/useWizardHandlers.ts:783
src/renderer/hooks/wizard/useWizardHandlers.ts:853
src/renderer/hooks/wizard/useWizardHandlers.ts:935
src/renderer/hooks/wizard/useWizardHandlers.ts:1005
```

These 8 wizard calls all re-look-up the active session from the store, even though `activeSession` is already available.

---

## getSshRemoteById - definitions (6 total) and usage

### Definitions

```
src/main/stores/getters.ts:115                   Canonical export from stores
src/main/ipc/handlers/agentSessions.ts:82        Local re-definition
src/main/ipc/handlers/agents.ts:202              Local re-definition (different signature: takes settingsStore)
src/main/ipc/handlers/autorun.ts:43              Local re-definition (different signature: takes settingsStore)
src/main/ipc/handlers/git.ts:54                  Local re-definition (returns null instead of undefined)
src/main/ipc/handlers/marketplace.ts:66          Local re-definition
```

### Usage sites

**agentSessions.ts** (4 usages):

```
src/main/ipc/handlers/agentSessions.ts:402
src/main/ipc/handlers/agentSessions.ts:433
src/main/ipc/handlers/agentSessions.ts:465
src/main/ipc/handlers/agentSessions.ts:502
```

**agents.ts** (3 usages):

```
src/main/ipc/handlers/agents.ts:314
src/main/ipc/handlers/agents.ts:417
src/main/ipc/handlers/agents.ts:822
```

**autorun.ts** (10 usages):

```
src/main/ipc/handlers/autorun.ts:267
src/main/ipc/handlers/autorun.ts:338
src/main/ipc/handlers/autorun.ts:414
src/main/ipc/handlers/autorun.ts:510
src/main/ipc/handlers/autorun.ts:588
src/main/ipc/handlers/autorun.ts:649
src/main/ipc/handlers/autorun.ts:787
src/main/ipc/handlers/autorun.ts:917
src/main/ipc/handlers/autorun.ts:993
(+2 more)
```

**filesystem.ts** (8 usages, imports from stores):

```
src/main/ipc/handlers/filesystem.ts:35     import { getSshRemoteById } from '../../stores'
src/main/ipc/handlers/filesystem.ts:97
src/main/ipc/handlers/filesystem.ts:135
src/main/ipc/handlers/filesystem.ts:188
src/main/ipc/handlers/filesystem.ts:227
src/main/ipc/handlers/filesystem.ts:300
src/main/ipc/handlers/filesystem.ts:325
src/main/ipc/handlers/filesystem.ts:353
src/main/ipc/handlers/filesystem.ts:383
```

**git.ts** (7 usages):

```
src/main/ipc/handlers/git.ts:103
src/main/ipc/handlers/git.ts:117
src/main/ipc/handlers/git.ts:130
src/main/ipc/handlers/git.ts:148
src/main/ipc/handlers/git.ts:161
src/main/ipc/handlers/git.ts:179
src/main/ipc/handlers/git.ts:197
```

**index.ts** (1 usage, imports from stores):

```
src/main/index.ts:25      import { getSshRemoteById } from stores
src/main/index.ts:620     usage
```

---

## Summary

| Pattern                        | Count | Concern                                                    |
| ------------------------------ | ----- | ---------------------------------------------------------- |
| `setSessions` calls            | 463   | Prop-drilling, should use store directly                   |
| `sessions.find` lookups        | 71    | Should use `getActiveSession` / `getSessionById` selectors |
| `getSshRemoteById` definitions | 6     | 5 local copies of a function already exported from stores  |
| Wizard re-lookups              | 8     | Re-finds session that's already in scope                   |
