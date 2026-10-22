# CLAUDE-PATTERNS.md

Core implementation patterns for the Maestro codebase. For the main guide, see [[CLAUDE.md]].

## 1. Process Management

Each agent runs **two processes** simultaneously:

- AI agent process (Claude Code, etc.) - spawned with `-ai` suffix
- Terminal process (PTY shell) - spawned with `-terminal` suffix

```typescript
// Agent stores both PIDs (code interface: Session object)
session.aiPid; // AI agent process
session.terminalPid; // Terminal process
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

Settings live in the zustand store `src/renderer/stores/settingsStore.ts`, not in component state. A new setting touches four files, and skipping the hydration mapping is the classic "setting resets on restart" bug:

1. `src/shared/settingsMetadata.ts` - the `SETTINGS_METADATA` entry (`description`, `type`, `default`, `category`).
2. `src/renderer/stores/settingsStore.ts` - interface field, setter signature, initial-state default, setter action (which must call `window.maestro.settings.set`), and the `allSettings[...]` hydration mapping.
3. `src/renderer/hooks/settings/useSettings.ts` - the field and setter on `UseSettingsReturn`.
4. `src/main/stores/defaults.ts` - only when `MaestroSettings` requires the key.

The full six-step checklist, with the Settings modal style rules, is [[CLAUDE-SETTINGS.md]] §9.

**MANDATORY: Register the setting with Settings Search.** Every user-facing setting must be findable from the Settings modal search bar (Cmd+F). Two steps, both required:

1. Wrap the rendered control in `<div data-setting-id="<tab>-<slug>">…</div>` inside the appropriate tab file (e.g., `src/renderer/components/Settings/tabs/GeneralTab/GeneralTab.tsx`). The id must be unique and kebab-case.
2. Add a matching entry to the corresponding array in `src/renderer/components/Settings/searchableSettings.ts` (`GENERAL_SETTINGS`, `DISPLAY_SETTINGS`, etc.) with `id`, `tab`, `tabLabel`, `label`, `description`, and `keywords` covering every visible string a user might type after seeing the section in the UI.

The DOM-parity test at `src/__tests__/renderer/components/Settings/searchableSettings.test.ts` enforces both directions (rendered-id ↔ registry-entry). It will fail CI if either is missing. For any new visible string you want guaranteed-findable, add a query to the `it.each` block in that test.

## 4. Adding Modals

1. Create component in `src/renderer/components/`
2. Add priority in `src/renderer/constants/modalPriorities.ts`
3. Register with the layer stack through `useModalLayer()` (`src/renderer/hooks/ui/useModalLayer.ts`). Do NOT hand-roll `registerLayer()` / `unregisterLayer()` in an effect, and do not handle Escape locally:

```typescript
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

function MyModal({ onClose }: { onClose: () => void }) {
	useModalLayer(MODAL_PRIORITIES.MY_MODAL, 'My Modal', onClose);
	return <div>...</div>;
}
```

Pass `{ enabled: isOpen }` in the options to skip registration without unmounting the host, and `blocksAppShortcuts: false` for a passive panel that registers only so Escape closes it. A surface the user opens also needs its hotkey, palette entry, menu item, and `UI_SURFACES` row: see [UI-PATTERNS.md → Every Surface Needs Three Ways In](docs/agent-guides/UI-PATTERNS.md#every-surface-needs-three-ways-in-and-two-ways-out).

**Max size:** The Maestro Cue modal (`90vw x 90vh`) is the maximum modal footprint - no modal, including "expanded"/"fullscreen" states, should exceed it (never `w-screen h-screen`). See [UI-PATTERNS.md → Modal Sizing](docs/agent-guides/UI-PATTERNS.md#modal-sizing-max-footprint).

## 5. Theme Colors

Themes have 13 required colors. Use inline styles for theme colors:

```typescript
style={{ color: theme.colors.textMain }}  // Correct
className="text-gray-500"                  // Wrong for themed text
```

## 6. Multi-Tab Agents & Unified Tab System

Agents support multiple AI conversation tabs and file preview tabs in a unified tab bar.

### Critical Invariant: `unifiedTabOrder` Must Stay in Sync

**Every tab in `aiTabs` or `filePreviewTabs` MUST have a corresponding entry in `unifiedTabOrder`.** The TabBar renders from `unifiedTabOrder` - tabs missing from this array are invisible even if their content renders.

```typescript
// Session tab state (three arrays that MUST stay in sync)
session.aiTabs: AITab[]                    // AI conversation tab data
session.filePreviewTabs: FilePreviewTab[]  // File preview tab data
session.unifiedTabOrder: UnifiedTabRef[]   // Visual order - TabBar source of truth

session.activeTabId: string                // Active AI tab
session.activeFileTabId: string | null     // Active file tab (null if AI tab active)
```

### When Adding Tabs

Always update both the tab array AND `unifiedTabOrder`:

```typescript
// CORRECT - tab appears in TabBar
return {
	...s,
	aiTabs: [...s.aiTabs, newTab],
	activeTabId: newTabId,
	unifiedTabOrder: [...s.unifiedTabOrder, { type: 'ai', id: newTabId }],
};

// WRONG - tab content renders but no tab visible
return {
	...s,
	aiTabs: [...s.aiTabs, newTab],
	activeTabId: newTabId,
	// unifiedTabOrder not updated - ghost tab!
};
```

### When Activating Existing Tabs

Use `ensureInUnifiedTabOrder()` to repair orphaned tabs defensively:

```typescript
import { ensureInUnifiedTabOrder } from '../utils/tabHelpers';

return {
	...s,
	activeFileTabId: existingTab.id,
	unifiedTabOrder: ensureInUnifiedTabOrder(s.unifiedTabOrder, 'file', existingTab.id),
};
```

### Shared Utilities (`tabHelpers`)

- **`buildUnifiedTabs(session)`** - Builds the unified tab list from session data. Follows `unifiedTabOrder` then appends orphaned tabs as a safety net. Single source of truth used by both `useTabHandlers.ts` and `tabStore.ts`.
- **`ensureInUnifiedTabOrder(order, type, id)`** - Returns order unchanged if tab is present, appends it otherwise. Zero-cost no-op when no repair needed (returns same reference).

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

See `src/renderer/components/TabBar/TabBar.tsx` (Tab component) for implementation details.

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

### Spawning an agent on a remote

Any feature that spawns an agent process (context grooming, group chat, batch operations) MUST support SSH remote execution. Without the wrapping the agent always executes locally, which breaks what the user configured.

1. Check whether the session has `sshRemoteConfig` with `enabled: true`.
2. Wrap the spawn config with `wrapSpawnWithSsh()` from `src/main/utils/ssh-spawn-wrapper.ts`.
3. Pass the SSH store (`createSshRemoteStoreAdapter(settingsStore)`).

```typescript
import { wrapSpawnWithSsh } from '../utils/ssh-spawn-wrapper';
import { createSshRemoteStoreAdapter } from '../utils/ssh-remote-resolver';

// Before spawning, wrap the config with SSH if needed
if (sshStore && session.sshRemoteConfig?.enabled) {
	const sshWrapped = await wrapSpawnWithSsh(spawnConfig, session.sshRemoteConfig, sshStore);
	// Use sshWrapped.command, sshWrapped.args, sshWrapped.cwd, etc.
}
```

Also ensure:

- The correct agent type is used (don't hardcode `claude-code`).
- Custom agent configuration (`customPath`, `customArgs`, `customEnvVars`) is passed through.
- The agent's `binaryName` is used for remote execution (not local paths).
- **An unresolvable remote fails loudly instead of silently running locally.** The user explicitly opted into SSH and their prompt must not leak to the local machine. `wrapSpawnWithSsh()` does NOT throw in that case: it hands back the unmodified local config with `sshRemoteUsed: null`, which still carries the REMOTE's `cwd`, so taking it runs the agent on the user's machine against a path that is either missing or (worse) the wrong files. Every caller must check `sshRemoteUsed` and throw `sshUnresolvedRemoteMessage(sshConfig)` from `ssh-spawn-wrapper.ts`. See `groomContext()` and `spawnGroupChatAgent()` for the pattern, and `sshUnresolvedFailure()` in `src/cli/services/agent-spawner.ts` for the CLI's version. Better still, resolve the target BEFORE any side effect: `buildAgentLaunchPlan()` / `resolveSshLaunchTarget()` in `src/shared/maestro-lib/launch/` return an actionable error for a missing, deleted, or disabled remote, which is how desktop, Cue, and the CLI now fail.

**CLI parity:** the CLI (`src/cli/services/agent-spawner.ts`) spawns agent processes for batch and playbook automation and honors the same SSH wrapping and agent-config overrides as the desktop app. A new CLI spawn site threads `sessionSshRemoteConfig`, `customArgs`, `customEnvVars`, `customModel`, and `customEffort` through to `spawnAgent(...)`. The CLI loads `ssh-spawn-wrapper` via dynamic `import()` so the SSH chain stays out of the local hot path.

## 11. Debugging Checklists

Verify the root cause before changing code. Patterns that have wasted time here:

- Tab naming bug: modal coordination was "fixed" when the real issue was an unregistered IPC handler.
- Tooltip clipping: `overflow: visible` was tried on the element while a parent container had `overflow: hidden`.
- Session validation: renderer calls were fixed when the handler was never wired in the main process.

**Focus not working:** add `tabIndex={0}` or `tabIndex={-1}`, add the `outline-none` class, and focus through `useFocusAfterRender()` / `useFocusOnMount()` (`src/renderer/hooks/utils/useFocusAfterRender.ts`).

**Settings not persisting:** check that the setter calls `window.maestro.settings.set()`, and that the store's hydration mapping reads the key back (§3).

**Modal Escape not working:** register through `useModalLayer()` rather than handling Escape locally, and check that its priority is set correctly (§4).

### Visual issues

When debugging visual issues (tooltips clipped, elements not visible, scroll behavior):

1. **CSS First:** Check parent container properties before code logic:
   - `overflow: hidden` on ancestors (clipping issues)
   - `z-index` stacking context conflicts
   - `position` mismatches (fixed/absolute/relative)

2. **Scroll Issues:** Use `scrollIntoView({ block: 'nearest' })` not centering

3. **Portal Escape:** For overlays/tooltips that get clipped, use `createPortal(el, document.body)` to escape stacking context

4. **Fixed Positioning:** Elements with `position: fixed` inside transformed parents won't position relative to viewport - check ancestor transforms

**Common fixes:**

```typescript
// Tooltip/overlay escaping parent overflow
import { createPortal } from 'react-dom';
{isOpen && createPortal(<Overlay />, document.body)}

// Scroll element into view without centering
element.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
```

## 12. Encore Features (Feature Gating)

Optional features that not all users need should be gated behind Encore Features - disabled by default, completely invisible when off (no shortcuts, menus, or command palette entries).

**Critical architecture detail:** `encoreFeatures` state lives in App.tsx's `useSettings()` and is passed to SettingsModal as **props** (not consumed via SettingsModal's own `useSettings()`). This ensures toggles propagate immediately to App.tsx for gating.

### Gating Checklist

When adding a new Encore Feature, gate **all** access points:

1. **Type flag** - Add to `EncoreFeatureFlags` in `src/renderer/types/index.ts`
2. **Default** - Set to `false` in `ENCORE_FEATURE_DEFAULTS` in `src/shared/encoreFeatureDefaults.ts` (the renderer store reads it as `DEFAULT_ENCORE_FEATURES` in `src/renderer/stores/settingsStore.ts`)
3. **Toggle UI** - Add section in SettingsModal's Encore tab (follow Director's Notes pattern)
4. **App.tsx** - Gate modal rendering and callback props on `encoreFeatures.yourFeature`
5. **Keyboard shortcuts** - Guard with `ctx.encoreFeatures?.yourFeature` in `useMainKeyboardHandler.ts`, AND add the shortcut id to `SHORTCUT_ENCORE_FLAGS` in `src/renderer/utils/encoreShortcuts.ts` so it leaves Shortcuts Help, Settings -> Shortcuts, and the mastery count while the feature is off. A native menu item sets `encoreFlag` in `src/main/app-menu.ts`
6. **Hamburger menu** - Make the setter optional, conditionally render the menu item in `SessionList.tsx`
7. **Command palette** - Pass `undefined` for the handler in `QuickActionsModal.tsx` (already conditionally renders based on handler existence)
8. **Settings outside the tile** - A control that configures the feature but lives on another Settings tab is gated on the flag where it renders, and its search entry sets `requiresEncore` (never on the tile's own entry)
9. **Prompts and template variables** - Text that tells an agent to use the feature goes in its own prompt delivered by `systemPromptSection` in `src/shared/plugins/first-party.ts`, never in `maestro-system-prompt.md` (the base prompt reaches every agent, flag or not). Give each of the feature's prompts an `encoreFlag` in `src/shared/promptDefinitions.ts` and each of its template variables an `encoreFlag` in `src/shared/templateVariables.ts` so Settings -> Maestro Prompts and the `{{` pickers leave them out while the feature is off
10. **Left Bar / cycling** - A feature that adds a pinned AGENT (like Pianola) must also be hidden from the keyboard orders: the agent persists in the session store while the flag is off, so add it to `isSessionVisibleInSidebar()` in `src/renderer/utils/sessionVisibility.ts` or `Cmd+[` / `Cmd+]` still lands on it, and run every list that offers agents (palette jump targets, the `@` picker, Send to Agent / Merge targets) through `filterSessionsVisibleInSidebar()`
11. **Usage guide** - Fill in the entry's one-line `description` in `src/shared/plugins/first-party.ts` and its `usage` block. `usage` is REQUIRED (the type rejects a definition without one): it is the details pane's Help tab, which every tile has and which a disabled tile opens on. Sections: `overview` (what it does), `access` (every way in - name a `shortcutId` rather than literal key text so the pane prints the user's LIVE binding), `steps` (an ordered walkthrough when setup takes more than one action), `notes` (guard rails worth stating before someone enables it), `agentCommands`, and `docsSlug`. `UsageGuide.tsx` renders whichever sections exist, so nothing is hard-coded per feature in the view

### Reference Implementations

**Director's Notes** - First Encore Feature, canonical example:

- **Flag:** `encoreFeatures.directorNotes` in `EncoreFeatureFlags`
- **App.tsx gating:** Modal render wrapped in `{encoreFeatures.directorNotes && directorNotesOpen && (…)}`, callback passed as `encoreFeatures.directorNotes ? () => setDirectorNotesOpen(true) : undefined`
- **Keyboard shortcut:** `ctx.encoreFeatures?.directorNotes` guard in `useMainKeyboardHandler.ts`
- **Hamburger menu:** `setDirectorNotesOpen` made optional in `SessionList.tsx`, button conditionally rendered with `{setDirectorNotesOpen && (…)}`
- **Command palette:** `onOpenDirectorNotes` already conditionally renders in `QuickActionsModal.tsx` - passing `undefined` from App.tsx is sufficient

**Maestro Cue** - Event-driven automation, second Encore Feature:

- **Flag:** `encoreFeatures.maestroCue` in `EncoreFeatureFlags`
- **App.tsx gating:** Cue modal, hooks (`useCue`, `useCueAutoDiscovery`), and engine lifecycle gated on `encoreFeatures.maestroCue`
- **Keyboard shortcut:** `ctx.encoreFeatures?.maestroCue` guard in `useMainKeyboardHandler.ts`
- **Hamburger menu:** `setMaestroCueOpen` made optional in `SessionList.tsx`
- **Command palette:** `onOpenMaestroCue` conditionally renders in `QuickActionsModal.tsx`
- **Session list:** Cue status indicator (Zap icon) gated on `maestroCueEnabled`

When adding a new Encore Feature, mirror this pattern across all access points.

See [CONTRIBUTING.md → Encore Features](CONTRIBUTING.md#encore-features-feature-gating) for the full contributor guide.

## 13. Browser Tab Keyboard Interception

When a `<webview>` has focus, keyboard events are trapped in its guest Chromium process - the renderer's `window` keydown handler never sees them. Maestro uses a three-layer approach to ensure app shortcuts (tab cycling, Cmd+L, etc.) still work:

1. **Main process `before-input-event`** - intercepts shortcuts before the guest page sees them, sends via `browser-tab:shortcutKey` IPC
2. **Renderer IPC listener** - blurs the webview and re-dispatches as a native `KeyboardEvent` on `window`
3. **Focus-steal prevention** - `BrowserTabView` blocks auto-focus from page content (autofocus elements, `window.focus()`) so the webview only captures keyboard input after an explicit user click

**Key files:** `window-manager.ts` (before-input-event + guest injection), `preload/system.ts` (IPC bridge), `useMainKeyboardHandler.ts` (IPC → dispatch), `BrowserTabView.tsx` (focus guard)

**Pitfall:** Tab navigation filters (e.g., `showUnreadOnly` in `tabHelpers`) must explicitly handle `browser` type tabs - they are not AI tabs and will be silently skipped if they fall through to the AI tab lookup.

See [[IPC-PATTERNS.md → Browser Tab Shortcut Forwarding]](docs/agent-guides/IPC-PATTERNS.md#browser-tab-shortcut-forwarding) for the full event flow.

## 14. Search / Filter Input ESC Pill

Any search or filter input that is dismissible via Escape **must** display an inline `ESC` pill flush-right inside the input bar, so the user can see that Escape clears or closes it. Escape alone strands users on remote desktop and tablets.

**When this applies:**

- The input is meant for searching, filtering, or fuzzy-matching (not free-form text entry like chat input).
- Pressing Escape clears the query, collapses the search bar, or closes the surrounding modal or panel.

Use `<EscCloseButton>` from `src/renderer/components/ui/EscCloseButton.tsx`. Do NOT hand-roll the pill: the inert copy-pasted version used to exist in nine places.

```tsx
<EscCloseButton theme={theme} onClose={closeSearch} />
```

**Rules:**

1. `onClose` must do **exactly** what the Escape handler does. Extract the body into a shared `useCallback` rather than duplicating it, so the pill can never diverge from the keyboard.
2. For an input inside a modal registered with the layer stack, the pill still belongs: Escape closes the layer, and the pill mirrors that.
3. A text box that narrows a list should be `<FilterInput>` (`src/renderer/components/ui/FilterInput.tsx`), which already carries its own clear control.

Full rules: [UI-PATTERNS.md → Every Modal Needs a Graphical Exit](docs/agent-guides/UI-PATTERNS.md#every-modal-needs-a-graphical-exit-escclosebutton).

## 15. Error Handling & Sentry

Maestro uses Sentry for error tracking. Field data from production crashes is invaluable for improving code quality.

**DO let exceptions bubble up:**

```typescript
// WRONG - silently swallowing errors hides bugs from Sentry
try {
	await riskyOperation();
} catch (e) {
	console.error(e); // Lost to the void
}

// CORRECT - let unhandled exceptions reach Sentry
await riskyOperation(); // Crashes are reported automatically
```

**DO handle expected/recoverable errors explicitly:**

```typescript
// CORRECT - known failure modes should be handled gracefully
try {
	await fetchUserData();
} catch (e) {
	if (e.code === 'NETWORK_ERROR') {
		showOfflineMessage(); // Expected, recoverable
	} else {
		throw e; // Unexpected - let Sentry capture it
	}
}
```

**DO use Sentry utilities for explicit reporting:**

```typescript
import { captureException, captureMessage } from '../utils/sentry';

// Report exceptions with context
await captureException(error, { userId, operation: 'sync' });

// Report notable events that aren't crashes
await captureMessage('Unusual state detected', 'warning', { state });
```

**Key files:** `src/main/utils/sentry.ts`, `src/renderer/components/ErrorBoundary.tsx`
