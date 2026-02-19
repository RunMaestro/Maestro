# CLAUDE-PATTERNS.md

Core implementation patterns for the Maestro codebase. For the main guide, see [[CLAUDE.md]].

## 1. Process Management

Each agent runs **two processes** simultaneously:
- AI agent process (Claude Code, etc.) - spawned with `-ai` suffix
- Terminal process (PTY shell) - spawned with `-terminal` suffix

```typescript
// Agent stores both PIDs (code interface: Session object)
session.aiPid       // AI agent process
session.terminalPid // Terminal process
```

## 2. Security Requirements

**Always use `execFileNoThrow`** for external commands:
```typescript
import { execFileNoThrow } from './utils/execFile';
const result = await execFileNoThrow('git', ['status'], cwd);
// Returns: { stdout, stderr, exitCode } - never throws
```

**Never use shell-based command execution** - it creates injection vulnerabilities. The `execFileNoThrow` utility is the safe alternative.

## 3. Settings Persistence

Add new settings in `useSettings.ts`:
```typescript
// 1. Add state with default value
const [mySetting, setMySettingState] = useState(defaultValue);

// 2. Add wrapper that persists
const setMySetting = (value) => {
  setMySettingState(value);
  window.maestro.settings.set('mySetting', value);
};

// 3. Load from batch response in useEffect (settings use batch loading)
// In the loadSettings useEffect, extract from allSettings object:
const allSettings = await window.maestro.settings.getAll();
const savedMySetting = allSettings['mySetting'];
if (savedMySetting !== undefined) setMySettingState(savedMySetting);
```

## 4. Adding Modals

1. Create component in `src/renderer/components/`
2. Add priority in `src/renderer/constants/modalPriorities.ts`
3. Register with layer stack:

```typescript
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

const { registerLayer, unregisterLayer } = useLayerStack();
const onCloseRef = useRef(onClose);
onCloseRef.current = onClose;

useEffect(() => {
  if (isOpen) {
    const id = registerLayer({
      type: 'modal',
      priority: MODAL_PRIORITIES.YOUR_MODAL,
      onEscape: () => onCloseRef.current(),
    });
    return () => unregisterLayer(id);
  }
}, [isOpen, registerLayer, unregisterLayer]);
```

## 5. Theme Colors

Themes have 13 required colors. Use inline styles for theme colors:
```typescript
style={{ color: theme.colors.textMain }}  // Correct
className="text-gray-500"                  // Wrong for themed text
```

## 6. Multi-Tab Agents

Agents support multiple AI conversation tabs:
```typescript
// Each session has an array of tabs
session.aiTabs: AITab[]
session.activeTabId: string

// Each tab maintains its own conversation
interface AITab {
  id: string;
  name: string;
  logs: LogEntry[];           // Tab-specific history
  agentSessionId?: string;    // Provider session continuity
}

// Tab operations
const activeTab = session.aiTabs.find(t => t.id === session.activeTabId);
```

## 7. Execution Queue

Messages are queued when the AI is busy:
```typescript
// Queue items for sequential execution
interface QueuedItem {
  type: 'message' | 'slashCommand';
  content: string;
  timestamp: number;
}

// Add to queue instead of sending directly when busy
session.executionQueue.push({ type: 'message', content, timestamp: Date.now() });
```

## 8. Auto Run

File-based document automation system:
```typescript
// Auto Run state on session
session.autoRunFolderPath?: string;    // Document folder path
session.autoRunSelectedFile?: string;  // Currently selected document
session.autoRunMode?: 'edit' | 'preview';

// API for Auto Run operations
window.maestro.autorun.listDocuments(folderPath);
window.maestro.autorun.readDocument(folderPath, filename);
window.maestro.autorun.saveDocument(folderPath, filename, content);
```

**Worktree Support:** Auto Run can operate in a git worktree, allowing users to continue interactive editing in the main repo while Auto Run processes tasks in the background. When `batchRunState.worktreeActive` is true, read-only mode is disabled and a git branch icon appears in the UI. See `useBatchProcessor.ts` for worktree setup logic.

**Playbook Assets:** Playbooks can include non-markdown assets (config files, YAML, Dockerfiles, scripts) in an `assets/` subfolder. When installing playbooks from the marketplace or importing from ZIP files, Maestro copies the entire folder structure including assets. See the [Maestro-Playbooks repository](https://github.com/RunMaestro/Maestro-Playbooks) for the convention documentation.

```
playbook-folder/
├── 01_TASK.md
├── 02_TASK.md
├── README.md
└── assets/
    ├── config.yaml
    ├── Dockerfile
    └── setup.sh
```

Documents can reference assets using `{{AUTORUN_FOLDER}}/assets/filename`. The manifest lists assets explicitly:
```json
{
  "id": "example-playbook",
  "documents": [...],
  "assets": ["config.yaml", "Dockerfile", "setup.sh"]
}
```

## 9. Tab Hover Overlay Menu

AI conversation tabs display a hover overlay menu after a 400ms delay when hovering over tabs with an established provider session. The overlay includes tab management and context operations:

**Menu Structure:**
```typescript
// Tab operations (always shown)
- Copy Session ID (if provider session exists)
- Star/Unstar Session (if provider session exists)
- Rename Tab
- Mark as Unread

// Context management (shown when applicable)
- Context: Compact (if tab has 5+ messages)
- Context: Merge Into (if provider session exists)
- Context: Send to Agent (if provider session exists)

// Tab close actions (always shown)
- Close (disabled if only one tab)
- Close Others (disabled if only one tab)
- Close Tabs to the Left (disabled if first tab)
- Close Tabs to the Right (disabled if last tab)
```

**Implementation Pattern:**
```typescript
const [overlayOpen, setOverlayOpen] = useState(false);
const [overlayPosition, setOverlayPosition] = useState<{ top: number; left: number } | null>(null);

const handleMouseEnter = () => {
  if (!tab.agentSessionId) return; // Only for tabs with provider sessions

  hoverTimeoutRef.current = setTimeout(() => {
    if (tabRef.current) {
      const rect = tabRef.current.getBoundingClientRect();
      setOverlayPosition({ top: rect.bottom + 4, left: rect.left });
    }
    setOverlayOpen(true);
  }, 400);
};

// Render overlay via portal to escape stacking context
{overlayOpen && overlayPosition && createPortal(
  <div style={{ top: overlayPosition.top, left: overlayPosition.left }}>
    {/* Overlay menu items */}
  </div>,
  document.body
)}
```

**Key Features:**
- Appears after 400ms hover delay (only for tabs with `agentSessionId`)
- Fixed positioning at tab bottom
- Mouse can move from tab to overlay without closing
- Disabled states with visual feedback (opacity-40, cursor-default)
- Theme-aware styling
- Dividers separate action groups

See `src/renderer/components/TabBar.tsx` (Tab component) for implementation details.

## 10. SSH Remote Agents

Agents can execute commands on remote hosts via SSH. **Critical:** There are two different SSH identifiers with different lifecycles:

```typescript
// Set AFTER AI agent spawns (via onSshRemote callback)
session.sshRemoteId: string | undefined

// Set BEFORE spawn (user configuration)
session.sessionSshRemoteConfig: {
  enabled: boolean;
  remoteId: string | null;      // The SSH config ID
  workingDirOverride?: string;
}
```

**Common pitfall:** `sshRemoteId` is only populated after the AI agent spawns. For terminal-only SSH agents (no AI process), it remains `undefined`. Always use both as fallback:

```typescript
// WRONG - fails for terminal-only SSH agents
const sshId = session.sshRemoteId;

// CORRECT - works for all SSH agents
const sshId = session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId;
```

This applies to any operation that needs to run on the remote:
- `window.maestro.fs.readDir(path, sshId)`
- `gitService.isRepo(path, sshId)`
- Directory existence checks for `cd` command tracking

Similarly for checking if an agent is remote:
```typescript
// WRONG
const isRemote = !!session.sshRemoteId;

// CORRECT
const isRemote = !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled;
```

## 11. UI Bug Debugging Checklist

When debugging visual issues (tooltips clipped, elements not visible, scroll behavior):

1. **CSS First:** Check parent container properties before code logic:
   - `overflow: hidden` on ancestors (clipping issues)
   - `z-index` stacking context conflicts
   - `position` mismatches (fixed/absolute/relative)

2. **Scroll Issues:** Use `scrollIntoView({ block: 'nearest' })` not centering

3. **Portal Escape:** For overlays/tooltips that get clipped, use `createPortal(el, document.body)` to escape stacking context

4. **Fixed Positioning:** Elements with `position: fixed` inside transformed parents won't position relative to viewport—check ancestor transforms

**Common fixes:**
```typescript
// Tooltip/overlay escaping parent overflow
import { createPortal } from 'react-dom';
{isOpen && createPortal(<Overlay />, document.body)}

// Scroll element into view without centering
element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
```

## 12. Encore Features (Feature Gating)

Optional features that not all users need should be gated behind Encore Features — disabled by default, completely invisible when off (no shortcuts, menus, or command palette entries).

**Critical architecture detail:** `encoreFeatures` state lives in App.tsx's `useSettings()` and is passed to SettingsModal as **props** (not consumed via SettingsModal's own `useSettings()`). This ensures toggles propagate immediately to App.tsx for gating.

### Gating Checklist

When adding a new Encore Feature, gate **all** access points:

1. **Type flag** — Add to `EncoreFeatureFlags` in `src/renderer/types/index.ts`
2. **Default** — Set to `false` in `DEFAULT_ENCORE_FEATURES` in `useSettings.ts`
3. **Toggle UI** — Add section in SettingsModal's Encore tab (follow Director's Notes pattern)
4. **App.tsx** — Gate modal rendering and callback props on `encoreFeatures.yourFeature`
5. **Keyboard shortcuts** — Guard with `ctx.encoreFeatures?.yourFeature` in `useMainKeyboardHandler.ts`
6. **Hamburger menu** — Make the setter optional, conditionally render the menu item in `SessionList.tsx`
7. **Command palette** — Pass `undefined` for the handler in `QuickActionsModal.tsx` (already conditionally renders based on handler existence)

### Reference Implementation: Director's Notes

Director's Notes is the first Encore Feature and serves as the canonical example:

- **Flag:** `encoreFeatures.directorNotes` in `EncoreFeatureFlags`
- **App.tsx gating:** Modal render wrapped in `{encoreFeatures.directorNotes && directorNotesOpen && (…)}`, callback passed as `encoreFeatures.directorNotes ? () => setDirectorNotesOpen(true) : undefined`
- **Keyboard shortcut:** `ctx.encoreFeatures?.directorNotes` guard in `useMainKeyboardHandler.ts`
- **Hamburger menu:** `setDirectorNotesOpen` made optional in `SessionList.tsx`, button conditionally rendered with `{setDirectorNotesOpen && (…)}`
- **Command palette:** `onOpenDirectorNotes` already conditionally renders in `QuickActionsModal.tsx` — passing `undefined` from App.tsx is sufficient

When adding a new Encore Feature, mirror this pattern across all access points.

See [CONTRIBUTING.md → Encore Features](CONTRIBUTING.md#encore-features-feature-gating) for the full contributor guide.
