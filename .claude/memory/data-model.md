# Data Model & State Management

## Zustand Stores (11 total, `src/renderer/stores/`)

| Store | Purpose | Key state |
|-------|---------|-----------|
| `sessionStore` | Sessions, groups, active session | `sessions[]`, `groups[]`, `activeSessionId` |
| `settingsStore` | User preferences | themes, fonts, agent config, SSH remotes |
| `modalStore` | 50+ modal visibility + data | Registry pattern, not 50 fields |
| `tabStore` | Tab management | unified tab order, closed tab history |
| `agentStore` | Agent detection/capabilities | detected agents, capabilities map |
| `uiStore` | UI toggles | right panel tab, focus area |
| `batchStore` | Batch runner state | progress, docs, tasks |
| `groupChatStore` | Group chat | messages, participants |
| `notificationStore` | Toast queue | notifications[] |
| `operationStore` | Long-running ops | merge/transfer progress |
| `fileExplorerStore` | File tree | expansion state, scroll |

## Session Interface (key fields)

```typescript
interface Session {
  id: string;
  name: string;
  toolType: ToolType;           // 'claude-code' | 'codex' | 'opencode' | 'factory-droid'
  state: SessionState;          // 'idle' | 'busy' | 'connecting' | 'error'
  inputMode: 'ai' | 'terminal';
  cwd: string;                  // Changes via cd
  projectRoot: string;          // Never changes (used for session storage)
  aiTabs: AITab[];
  activeTabId: string;
  filePreviewTabs: FilePreviewTab[];
  activeFileTabId: string | null;
  unifiedTabOrder: UnifiedTabRef[];  // TabBar source of truth
  executionQueue: QueuedItem[];
}
```

## Critical Invariant: unifiedTabOrder

**Every tab MUST have an entry in `unifiedTabOrder`.** Tabs missing from this array are invisible in TabBar even if content renders.

- When adding tabs: update both tab array AND `unifiedTabOrder`
- When activating: use `ensureInUnifiedTabOrder()` from `tabHelpers.ts`
- `buildUnifiedTabs(session)` is the canonical tab list builder

## Settings Persistence

Settings stored via `electron-store` at platform-specific paths:
- macOS: `~/Library/Application Support/maestro/`
- Windows: `%APPDATA%/maestro/`
- Linux: `~/.config/maestro/`

Files: `maestro-settings.json`, `maestro-sessions.json`, `maestro-groups.json`, `maestro-agent-configs.json`

## State Management Pattern

- **Zustand** for persistent/large state (selector-based subscriptions)
- **React Context** for transient UI state (LayerStack, Input, GitStatus, InlineWizard)
- Minimal prop drilling — components read directly from stores
