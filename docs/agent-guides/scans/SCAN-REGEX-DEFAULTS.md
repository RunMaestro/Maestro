# SCAN-REGEX-DEFAULTS

Duplicated regex patterns, magic values, and repeated path constructions in the Maestro codebase.

Generated: 2026-03-20

---

## Duplicated Regex Patterns

Top 30 most-repeated regex patterns across `src/**/*.{ts,tsx}`:

```
 60  /* Header */
 48  /**/
 46  /command.* queued/i
 37  /* Content */
 23  /* Footer */
 17  /Search.*sessions/
 17  /** Current theme for styling */
 16  /Search.*tabs/
 16  /* ignore non-JSON lines */
 15  /** Stable callback - receives tabId */
 14  /Add \d+ file/
 14  /** Theme for styling */
 13  /[.*+?^${}()|[\]\\]/g          <-- escapeRegExp body
 12  /* Error message */
 12  /* Divider */
 11  /-ai-(.+)$/
 10  /^group-chat-(.+)-moderator-\d+$/
 10  /^group-chat-(.+)-moderator-/
 10  /\s+/g
 10  /-synopsis-\d+$/
 10  /-batch-\d+$/
 10  /-ai-.+$/
 10  /** Enable colorblind-friendly colors */
 10  /** Aggregated stats data from the API */
 10  /* Legend */
 10  /* Actions */
  9  /* Timestamp */
  9  /* Keyboard hints */
  9  /* Close button */
  8  /^https?:\/\
```

### Session ID Regex Duplication

Constants defined in `src/main/constants.ts` but inlined elsewhere:

**Centralized definitions:**

- `src/main/constants.ts:27` - `REGEX_AI_SUFFIX = /-ai-.+$/`
- `src/main/constants.ts:28` - `REGEX_AI_TAB_ID = /-ai-(.+)$/`
- `src/main/constants.ts:18` - `REGEX_MODERATOR_SESSION = /^group-chat-(.+)-moderator-/`
- `src/main/constants.ts:19` - `REGEX_MODERATOR_SESSION_TIMESTAMP = /^group-chat-(.+)-moderator-\d+$/`
- `src/main/constants.ts:32` - `REGEX_BATCH_SESSION = /-batch-\d+$/`
- `src/main/constants.ts:33` - `REGEX_SYNOPSIS_SESSION = /-synopsis-\d+$/`

**Inlined duplicates (not using the constants):**

- `src/main/process-listeners/exit-listener.ts:439` - inline combined regex `/-ai-.+$|-terminal$|-batch-\d+$|-synopsis-\d+$/`
- `src/renderer/components/ProcessMonitor.tsx:290` - `/^(.+)-batch-\d+$/`
- `src/renderer/components/ProcessMonitor.tsx:295` - `/^(.+)-synopsis-\d+$/`
- `src/renderer/components/ProcessMonitor.tsx:320` - `/-batch-\d+$/`
- `src/renderer/components/ProcessMonitor.tsx:321` - `/-synopsis-\d+$/`
- `src/renderer/components/ProcessMonitor.tsx:331` - `/-ai-(.+)$/`

---

## escapeRegExp Inline Copies

Two independent implementations of `escapeRegExp`, each with the same `/[.*+?^${}()|[\]\\]/g` pattern:

- `src/renderer/hooks/batch/useAutoRunImageHandling.ts:69` - `const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');`
- `src/renderer/utils/groupChatExport.ts:69` - `function escapeRegExp(string: string): string {`

Usage sites:

- `src/renderer/hooks/batch/useAutoRunImageHandling.ts:77-79` - called 3x (filename, encodedPath, relativePath)
- `src/renderer/utils/groupChatExport.ts:83,88` - called 2x in regex construction

---

## Magic Timeout Values

Frequency of setTimeout delay values across non-test source:

```
239  dynamic/variable )
 33  2000ms
 28  50ms
 28  0ms
  8  100ms
  6  500ms
  6  1500ms
  4  5000ms
  3  3000ms
  3  1000ms
  2  300ms
  1  4000ms
  1  400ms
  1  150ms
  1  10000ms
```

### Copy Notification Timeout (2000ms) - Major Duplication

The `setCopied(true) -> setTimeout(() => setCopied(false), 2000)` pattern is repeated in **25+ locations**:

- `src/renderer/App.tsx:3446` - `setTimeout(() => setSuccessFlashNotification(null), 2000)`
- `src/renderer/components/AchievementCard.tsx:940` - `setTimeout(() => setCopySuccess(false), 2000)`
- `src/renderer/components/AutoRunLightbox.tsx:127` - `setTimeout(() => setCopied(false), 2000)`
- `src/renderer/components/AutoRunLightbox.tsx:156` - `setTimeout(() => setCopiedMarkdown(false), 2000)`
- `src/renderer/components/CollapsibleJsonViewer.tsx:115` - `setTimeout(() => setCopied(false), 1500)` **(note: 1500ms, inconsistent)**
- `src/renderer/components/CueYamlEditor.tsx:251` - `setTimeout(() => setCopied(false), 2000)`
- `src/renderer/components/DirectorNotes/AIOverviewTab.tsx:82` - `setTimeout(() => setCopied(false), 2000)`
- `src/renderer/components/FilePreview.tsx:1117` - `setTimeout(() => setShowCopyNotification(false), 2000)`
- `src/renderer/components/FilePreview.tsx:1487` - `setTimeout(() => setShowCopyNotification(false), 2000)`
- `src/renderer/components/GistPublishModal.tsx:85` - `setTimeout(() => setCopied(false), 2000)`
- `src/renderer/components/HistoryDetailModal.tsx:330` - `setTimeout(() => setCopiedSessionId(false), 2000)`
- `src/renderer/components/LightboxModal.tsx:53` - `setTimeout(() => setCopied(false), 2000)`
- `src/renderer/components/LogViewer.tsx:327` - `setTimeout(() => setCopiedIndex(null), 2000)`
- `src/renderer/components/MainPanel.tsx:876` - `setTimeout(() => setCopyNotification(null), 2000)`
- `src/renderer/components/NewInstanceModal.tsx:1270` - `setTimeout(() => setCopiedId(false), 2000)`
- `src/renderer/components/ParticipantCard.tsx:54` - `setTimeout(() => setCopied(false), 2000)`
- `src/renderer/components/PlaygroundPanel.tsx:434` - `setTimeout(() => setCopySuccess(false), 2000)`
- `src/renderer/components/PlaygroundPanel.tsx:562` - `setTimeout(() => setBatonCopySuccess(false), 2000)`
- `src/renderer/components/StandingOvationOverlay.tsx:344` - `setTimeout(() => setCopySuccess(false), 2000)`
- `src/renderer/hooks/agent/useAgentExecution.ts:645` - `setTimeout(() => setFlashNotification(null), 2000)`
- `src/renderer/hooks/agent/useAgentExecution.ts:656` - `setTimeout(() => setSuccessFlashNotification(null), 2000)`
- `src/renderer/hooks/batch/useAutoRunHandlers.ts:542` - `setTimeout(() => setSuccessFlashNotification(null), 2000)`
- `src/renderer/hooks/cue/usePipelineState.ts:323` - `setTimeout(() => setSaveStatus('idle'), 2000)`
- `src/renderer/hooks/input/useInputHandlers.ts:529,538,577,586` - 4x `setTimeout(() => setSuccessFlashNotification(null), 2000)`
- `src/renderer/hooks/modal/useQuickActionsHandlers.ts:143` - `setTimeout(() => setSuccessFlashNotification(null), 2000)`
- `src/renderer/hooks/remote/useLiveOverlay.ts:93` - `setTimeout(() => setCopyFlashState(null), 2000)`

---

## Port Generation Duplicates

The expression `3000 + Math.floor(Math.random() * 100)` appears in **5 locations**:

- `src/renderer/hooks/session/useSessionCrud.ts:233`
- `src/renderer/hooks/symphony/useSymphonyContribution.ts:158`
- `src/renderer/hooks/wizard/useWizardHandlers.ts:1157`
- `src/renderer/utils/tabHelpers.ts:1899`
- `src/renderer/utils/worktreeSession.ts:95`

---

## `.claude/projects` Path Construction

The expression `path.join(homeDir, '.claude', 'projects')` (or equivalent) is constructed **11 times**:

- `src/main/ipc/handlers/agentSessions.ts:203`
- `src/main/ipc/handlers/claude.ts:163`
- `src/main/ipc/handlers/claude.ts:355`
- `src/main/ipc/handlers/claude.ts:639`
- `src/main/ipc/handlers/claude.ts:811`
- `src/main/ipc/handlers/claude.ts:870`
- `src/main/ipc/handlers/claude.ts:1078`
- `src/main/ipc/handlers/claude.ts:1166`
- `src/main/ipc/handlers/claude.ts:1350`
- `src/main/ipc/handlers/claude.ts:1824`
- `src/main/storage/claude-session-storage.ts:274` - centralized getter `path.join(os.homedir(), '.claude', 'projects')`

Only `claude-session-storage.ts:274` provides a reusable method; the other 10 occurrences are inline constructions.

---

## `app.getPath('userData')` Usage

**39 call sites** across main process source (non-test):

- `src/main/cue/cue-db.ts:104`
- `src/main/debug-package/collectors/group-chats.ts:45`
- `src/main/debug-package/collectors/storage.ts:88`
- `src/main/group-chat/group-chat-storage.ts:152`
- `src/main/history-manager.ts:46`
- `src/main/index.ts:132,144,148`
- `src/main/index.ts:273` - exposed via `getUserDataPath()`
- `src/main/ipc/handlers/attachments.ts:66,113,150,169,196`
- `src/main/ipc/handlers/claude.ts:70`
- `src/main/ipc/handlers/cue.ts:273`
- `src/main/ipc/handlers/marketplace.ts:83,92,968`
- `src/main/ipc/handlers/persistence.ts:210`
- `src/main/ipc/handlers/playbooks.ts:33`
- `src/main/ipc/handlers/symphony.ts:215`
- `src/main/ipc/handlers/system.ts:476,492,495,523`
- `src/main/openspec-manager.ts:89,128`
- `src/main/speckit-manager.ts:118,157,417`
- `src/main/stats/stats-db.ts:67`
- `src/main/storage/codex-session-storage.ts:198`
- `src/main/stores/instances.ts:81,86,89`
- `src/main/utils/statsCache.ts:100,190`

---

## Session ID Regex Definitions

Session-related ID patterns and constants:

- `src/shared/history.ts:26` - `ORPHANED_SESSION_ID = '_orphaned'`
- `src/shared/templateVariables.ts:304` - `AGENT_SESSION_ID: session.agentSessionId || ''`
- `src/shared/templateVariables.ts:314` - `SESSION_ID: session.id`
- `src/main/agents/definitions.ts:91` - `resumeArgs?: (sessionId: string) => string[]`
- `src/main/agents/definitions.ts:139` - Claude Code resume: `['--resume', sessionId]`
- `src/main/agents/definitions.ts:158` - Codex resume: `['resume', sessionId]`
- `src/main/agents/definitions.ts:261` - OpenCode resume: `['--session', sessionId]`
- `src/renderer/utils/sessionIdParser.ts:11` - documents synopsis format `{sessionId}-synopsis-{timestamp}`
- `src/renderer/utils/sessionIdParser.ts:12` - documents batch format `{sessionId}-batch-{timestamp}`
- `src/renderer/utils/sessionIdParser.ts:26` - synopsis matcher regex
- `src/renderer/utils/sessionIdParser.ts:29` - batch matcher regex
