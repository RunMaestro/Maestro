# IPC API Surface

## Adding an IPC Handler

1. Create handler in `src/main/ipc/handlers/{domain}.ts`:
   ```typescript
   export function registerMyHandlers(deps: { getStore: () => Store }) {
     ipcMain.handle('myDomain:myAction', async (_, arg) => {
       return result;
     });
   }
   ```
2. Register in `src/main/index.ts` → `setupIpcHandlers()`
3. Add preload API in `src/main/preload/` (module per namespace)
4. Type the API in preload types

## Handler Pattern

All handlers use dependency injection:
```typescript
registerProcessHandlers({
  getProcessManager: () => processManager,
  getAgentDetector: () => agentDetector,
  agentConfigsStore,
  settingsStore,
  getMainWindow: () => mainWindow,
});
```

Error handling wrapper: `withIpcErrorLogging()` for standardized logging.

## Key Namespaces (40+)

| Namespace | Purpose |
|-----------|---------|
| `settings` | Get/set/getAll app settings |
| `sessions` / `groups` | Agent and group persistence |
| `process` | spawn, write, interrupt, kill, resize |
| `agents` | detect, getCapabilities, discoverModels |
| `agentSessions` | List/read/search provider sessions |
| `git` | status, diff, log, worktrees, createPR |
| `fs` | readDir, readFile, stat |
| `autorun` | Document + image management |
| `playbooks` | Batch run configuration CRUD |
| `stats` | Usage analytics (SQLite + WAL) |
| `groupChat` | Multi-agent coordination |
| `context` | Merge/groom/summarize sessions |
| `documentGraph` | File watching (chokidar) |
| `history` | Per-agent history (5000 entries/agent) |
| `tunnel` | Cloudflare tunnel management |
| `sshRemote` | SSH config management |
| `notification` | Desktop notifications, TTS |
| `web` / `live` / `webserver` | Web interface management |
| `symphony` | Open-source contribution system |

## IPC Handler Count

31 handler files in `src/main/ipc/handlers/` (~18,900 LOC total)

## Service Layer (Renderer)

Services in `src/renderer/services/` wrap IPC with error handling:
```typescript
// Pattern: never throw, return safe defaults
const gitService = {
  async isRepo(cwd: string): Promise<boolean> {
    try { return await window.maestro.git.isRepo(cwd); }
    catch { return false; }
  }
};
```
