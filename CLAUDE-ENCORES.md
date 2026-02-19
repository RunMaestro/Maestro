# CLAUDE-ENCORES.md

Encore Features architecture and development guide. For the main guide, see [[CLAUDE.md]].

---

## Overview

**Encore Features** are Maestro's extension system. The Encore tab in Settings presents a flat list of optional features — both built-in features (like Director's Notes) and installable encores (like Agent Status Exporter, Notification Webhook). Every item in the list is a peer: same card UI, same toggle pattern, same permission badges.

Installable encores are sandboxed JavaScript modules that run in the main process. They can read process events, send webhooks, write files, and register UI surfaces — all scoped by a permission model.

Encores are discovered from `userData/encores/` at startup. First-party encores ship bundled in `src/encores/` and are bootstrapped (copied) to userData on version mismatch.

---

## Architecture

```
src/encores/                    # Bundled first-party encore source
  ├── agent-status-exporter/    # Exports agent status to JSON
  └── notification-webhook/     # Sends webhooks on agent events

src/main/
  ├── encore-loader.ts          # Discovery, manifest validation, bootstrap
  ├── encore-manager.ts         # Lifecycle orchestration (singleton)
  ├── encore-host.ts            # API creation, activation, sandboxing
  ├── encore-storage.ts         # Per-encore file storage
  ├── encore-ipc-bridge.ts      # Main↔renderer encore communication
  ├── ipc/handlers/encores.ts   # IPC handlers for renderer
  └── preload/encores.ts        # Preload bridge (window.maestro.encores)

src/shared/encore-types.ts      # All encore type definitions
src/renderer/
  ├── components/EncoreManager.tsx  # Encore UI (list, detail, settings)
  ├── hooks/useEncoreRegistry.ts    # React hook for encore state
  └── global.d.ts                   # Encore IPC type declarations
```

### Lifecycle Flow

```
Bootstrap → Discover → Validate → Auto-enable (first-party) → Activate
                                                                  ↓
                                                         Encore receives EncoreAPI
                                                         (scoped by permissions)
```

1. **Bootstrap** (`bootstrapBundledEncores`): Copies `dist/encores/` → `userData/encores/` on version mismatch
2. **Discover** (`discoverEncores`): Reads each subdirectory's `manifest.json` + `README.md`
3. **Validate**: Schema validation of manifest fields, permission checking
4. **Auto-enable**: First-party encores activate unless user explicitly disabled them
5. **Activate** (`EncoreHost.activateEncore`): Loads module, creates scoped API, calls `activate(api)`

---

## Encore Manifest

Every encore requires a `manifest.json`:

```json
{
  "id": "my-encore",
  "name": "My Encore",
  "version": "1.0.0",
  "description": "What this encore does",
  "author": "Author Name",
  "firstParty": true,
  "main": "index.js",
  "permissions": ["process:read", "storage"],
  "settings": [
    { "key": "outputPath", "type": "string", "label": "Output Path", "default": "" },
    { "key": "enabled", "type": "boolean", "label": "Feature Enabled", "default": true }
  ],
  "tags": ["monitoring", "automation"]
}
```

### Permission Model

| Permission | Grants | Risk |
|------------|--------|------|
| `process:read` | Subscribe to agent data, exit, usage, tool events | Low |
| `process:write` | Kill/write to agent processes | High |
| `stats:read` | Query usage statistics database | Low |
| `settings:read` | Read encore-scoped settings | Low |
| `settings:write` | Read and write encore-scoped settings | Medium |
| `storage` | File I/O in encore's data directory | Medium |
| `notifications` | Show desktop notifications, play sounds | Low |
| `network` | HTTP requests (implicit, not enforced yet) | Medium |
| `middleware` | Reserved for v2 — intercept/transform data | High |

Permissions are color-coded in the UI: green (read), yellow (write), red (middleware).

---

## Encore API Surface

Encores receive a scoped `EncoreAPI` object in their `activate(api)` call. Namespaces are only present when the encore has the required permission.

### `api.maestro` (always available)

```typescript
{
  version: string;      // Maestro app version
  platform: string;     // 'darwin' | 'win32' | 'linux'
  encoreId: string;     // This encore's ID
  encoreDir: string;    // Absolute path to encore directory
  dataDir: string;      // Absolute path to encore's data/ directory
}
```

### `api.process` (requires `process:read`)

```typescript
{
  getActiveProcesses(): Promise<Array<{
    sessionId: string;
    toolType: string;    // Agent type: 'claude-code', 'codex', etc.
    pid: number;
    startTime: number;
    name: string | null; // User-assigned agent name
  }>>;
  onData(cb: (sessionId, data) => void): () => void;
  onExit(cb: (sessionId, code) => void): () => void;
  onUsage(cb: (sessionId, stats) => void): () => void;
  onToolExecution(cb: (sessionId, tool) => void): () => void;
  onThinkingChunk(cb: (sessionId, text) => void): () => void;
}
```

### `api.settings` (requires `settings:read` or `settings:write`)

```typescript
{
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;  // requires settings:write
  getAll(): Promise<Record<string, unknown>>;
}
```

Settings are namespaced to `encore:<id>:<key>` in electron-store.

### `api.storage` (requires `storage`)

```typescript
{
  read(filename: string): Promise<string | null>;
  write(filename: string, data: string): Promise<void>;
  list(): Promise<string[]>;
  delete(filename: string): Promise<void>;
}
```

Files stored in `userData/encores/<id>/data/`.

### `api.notifications` (requires `notifications`)

```typescript
{
  show(title: string, body: string): Promise<void>;
  playSound(sound: string): Promise<void>;
}
```

### `api.ipcBridge` (always available if EncoreIpcBridge is wired)

```typescript
{
  onMessage(channel: string, handler: (...args) => unknown): () => void;
  sendToRenderer(channel: string, ...args): void;
}
```

---

## Settings Persistence

Encore settings flow through two paths:

1. **Runtime API** (`api.settings.get/set`): Used by the encore code at runtime. Keys are stored as `encore:<id>:<key>` in the main settings store via `EncoreHost.createSettingsAPI()`.

2. **Renderer IPC** (`encores:settings:get/set`): Used by the EncoreManager UI. Calls through to `EncoreManager.getAllEncoreSettings()` / `setEncoreSetting()`.

**Critical:** `EncoreManager.setSettingsStore(store)` must be called during initialization, or settings silently no-op (both methods have early returns when `settingsStore` is null).

---

## Build Pipeline

Encores in `src/encores/` are plain JavaScript (not TypeScript) and need to be copied to `dist/encores/` for the main process to find them at runtime.

```bash
npm run build:encores  # Copies src/encores/ → dist/encores/
```

This runs as part of `build:main`, `dev:main`, and `dev:main:prod-data`. The Windows `start-dev.ps1` also includes it.

**Why not TypeScript?** Encores are loaded via `require()` at runtime from userData. They must be self-contained `.js` files without a compile step. The manifest and README are JSON/Markdown.

---

## Bootstrap and Deprecation

`bootstrapBundledEncores()` in `encore-loader.ts`:

1. Reads `dist/encores/` (or `resources/encores/` in production)
2. Removes any deprecated encore directories (hardcoded list: `['agent-dashboard']`)
3. For each bundled encore:
   - If destination doesn't exist → copy (install)
   - If version differs → overwrite (update)
   - If version matches → skip (preserve user modifications)

**To rename an encore:** Add the old ID to the `deprecatedEncores` array and bump the new encore's version.

---

## IPC Handlers

All encore IPC is registered in `src/main/ipc/handlers/encores.ts`:

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `encores:getAll` | Renderer → Main | Get all discovered encores |
| `encores:enable` | Renderer → Main | Enable/activate an encore |
| `encores:disable` | Renderer → Main | Disable/deactivate an encore |
| `encores:refresh` | Renderer → Main | Re-run discovery |
| `encores:getDir` | Renderer → Main | Get encores directory path |
| `encores:settings:get` | Renderer → Main | Get all settings for an encore |
| `encores:settings:set` | Renderer → Main | Set a single encore setting |
| `encores:bridge:invoke` | Renderer → Main | Call an encore's registered handler |

Preload bridge: `window.maestro.encores.*` (see `src/main/preload/encores.ts`).

---

## UI Integration

### Encore Tab (Settings → Encore Features)

The Encore tab renders a **flat list of feature cards**. Each card uses the shared `EncoreFeatureCard` component with a toggle switch, permission badges, and expandable settings content. The keyboard shortcut `Ctrl+Shift+X` opens the Encore tab directly.

**Built-in features** (like Director's Notes) are gated by `EncoreFeatureFlags` — a boolean per feature in the settings store, defaulting to `false`. Toggling enables/disables the feature globally (shortcuts, menus, command palette).

**Installable encores** appear as individual cards in the same flat list, one per encore. Each card shows:
- Name, version, author
- Description and permission badges (color-coded: green/read, yellow/write, red/middleware)
- Toggle switch to enable/disable the encore
- Expandable settings editor when enabled (via `EncoreSettings` component)

The `EncoreFeatureCard` component (`src/renderer/components/Settings/EncoreFeatureCard.tsx`) is the shared wrapper. Children unmount when disabled, ensuring cleanup of effects.

### Key UI Components

| Component | File | Role |
|-----------|------|------|
| `EncoreFeatureCard` | `Settings/EncoreFeatureCard.tsx` | Shared toggle card with permission badges |
| `DirectorNotesSettings` | `Settings/DirectorNotesSettings.tsx` | Self-contained DN settings (provider, lookback) |
| `EncoreSettings` | `EncoreManager.tsx` | Per-encore settings editor (string, number, boolean, select) |
| `EncoreManager` | `EncoreManager.tsx` | Full encore list/detail view (used standalone via Modal, or embedded) |

### Settings Editor

`EncoreSettings` validates path-like keys (absolute path) and URL-like keys (valid URL). Text inputs save on blur with a "Saved" flash indicator.

---

## Writing a New Encore

### Minimal Encore

```
my-encore/
  ├── manifest.json
  ├── index.js
  └── README.md    (optional, displayed in UI)
```

**manifest.json:**
```json
{
  "id": "my-encore",
  "name": "My Encore",
  "version": "1.0.0",
  "description": "Does something useful",
  "author": "You",
  "main": "index.js",
  "permissions": ["process:read"]
}
```

**index.js:**
```javascript
let unsubscribers = [];

async function activate(api) {
  const unsub = api.process.onExit((sessionId, code) => {
    console.log(`[my-encore] Agent ${sessionId} exited with code ${code}`);
  });
  unsubscribers.push(unsub);
}

async function deactivate() {
  for (const unsub of unsubscribers) unsub();
  unsubscribers = [];
}

module.exports = { activate, deactivate };
```

### First-Party Encore Checklist

- [ ] Place in `src/encores/<id>/`
- [ ] Set `"firstParty": true` in manifest
- [ ] Write a README.md (shown in encore detail view)
- [ ] Add tests in `src/__tests__/main/encore-reference.test.ts`
- [ ] Bump version on any change (triggers bootstrap re-copy)
- [ ] Clean up timers/subscriptions in `deactivate()`

---

## Bundled Encores

### Agent Status Exporter (`agent-status-exporter`)

Writes a `status.json` file with real-time agent state. Heartbeat every 10 seconds ensures the file stays fresh even when idle.

**Permissions:** `process:read`, `storage`, `settings:read`
**Settings:** `outputPath` — custom absolute path for status.json (defaults to encore data dir)

### Notification Webhook (`notification-webhook`)

Sends HTTP POST webhooks on agent exit and error events. Includes agent name, type, exit code, and last ~1000 chars of output.

**Permissions:** `process:read`, `settings:write`, `notifications`, `network`
**Settings:** `webhookUrl`, `notifyOnCompletion`, `notifyOnError`

**IPv6 note:** The encore resolves `localhost` to `127.0.0.1` explicitly to avoid `ECONNREFUSED ::1` on Linux systems where Node prefers IPv6.

---

## Common Gotchas

1. **Settings not persisting**: Ensure `encoreManager.setSettingsStore(store)` is called in `index.ts`
2. **Encores not bootstrapping in dev**: `dist/encores/` must exist — run `npm run build:encores` or restart with `npm run dev`
3. **Stale encore in userData after rename**: Add old ID to `deprecatedEncores` array in `bootstrapBundledEncores()`
4. **Session ID format**: Process manager uses `{baseId}-ai-{tabId}`. Strip suffix with `/-ai-.+$|-terminal$|-batch-\d+$|-synopsis-\d+$/` to match against sessions store
5. **Shortcut opens wrong tab**: `openEncores` must use `openModal('settings', { tab: 'encore' })` directly, not `setSettingsModalOpen(true)`

---

## Key Files

| File | Purpose |
|------|---------|
| `src/main/encore-loader.ts` | Discovery, validation, bootstrap |
| `src/main/encore-manager.ts` | Lifecycle, settings, singleton |
| `src/main/encore-host.ts` | API creation, sandboxing, activation |
| `src/main/encore-storage.ts` | Per-encore file I/O |
| `src/main/encore-ipc-bridge.ts` | Main↔renderer communication |
| `src/main/ipc/handlers/encores.ts` | IPC handler registration |
| `src/main/preload/encores.ts` | Preload bridge |
| `src/shared/encore-types.ts` | All type definitions |
| `src/renderer/components/Settings/EncoreFeatureCard.tsx` | Shared toggle card for Encore tab |
| `src/renderer/components/Settings/DirectorNotesSettings.tsx` | DN settings panel |
| `src/renderer/components/EncoreManager.tsx` | Encore UI (list, detail, settings) |
| `src/renderer/hooks/useEncoreRegistry.ts` | React state management |
| `src/encores/` | Bundled first-party encores |
| `src/__tests__/main/encore-reference.test.ts` | Encore integration tests |
