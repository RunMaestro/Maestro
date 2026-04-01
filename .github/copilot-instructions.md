# Copilot Instructions for Maestro

Maestro is an Electron desktop app for orchestrating multiple AI coding agents (Claude Code, Codex, OpenCode, Factory Droid) with a keyboard-first interface. It uses a dual-process architecture (main + renderer) with strict context isolation.

## Build, Test, and Lint

```bash
npm run dev              # Dev with hot reload (isolated data, safe alongside production)
npm run build            # Full production build (main + renderer + web + CLI)
npm run lint             # TypeScript type checking (renderer, main, cli configs)
npm run lint:eslint      # ESLint code quality
npm run test             # Run all unit tests (vitest)
npm run test:watch       # Watch mode
npm run format:check     # Check Prettier formatting
npm run validate:push    # Full pre-push validation (format + lint + eslint + test)
```

Run a single test file:
```bash
npx vitest run src/__tests__/path/to/file.test.ts
```

Run tests matching a name pattern:
```bash
npx vitest run -t "pattern"
```

Other test suites:
```bash
npm run test:e2e           # Playwright end-to-end (requires build first)
npm run test:integration   # Integration tests
npm run test:performance   # Performance tests
```

## Architecture

### Dual-Process (Electron)

- **Main process** (`src/main/`): Node.js backend — process spawning (PTY via `node-pty`), IPC handlers, agent detection, session storage, SQLite via `better-sqlite3`.
- **Renderer** (`src/renderer/`): React frontend — no Node.js access. Communicates via `window.maestro.*` IPC bridge defined in `preload.ts`.
- **Preload** (`src/main/preload.ts`): Secure IPC bridge via `contextBridge`. All new IPC must go through here.
- **Shared** (`src/shared/`): Types and utilities shared across processes.
- **CLI** (`src/cli/`): Standalone CLI tool (`maestro-cli`) for headless batch automation.
- **Web** (`src/web/`): Mobile-optimized React app for remote control.

### Agent Model

Each agent runs **two processes simultaneously**: an AI process (suffixed `-ai`) and a terminal process (suffixed `-terminal`). The `Session` interface in code represents an agent (historical naming). Use "agent" in user-facing language; reserve "session" for provider-level conversation contexts.

### IPC Pattern

To add a new IPC capability:
1. Add handler in `src/main/index.ts` via `ipcMain.handle('namespace:action', ...)`
2. Expose in `src/main/preload.ts` via `ipcRenderer.invoke()`
3. Add types to `MaestroAPI` interface in preload.ts

### Key Entry Points

| Task | Files |
|------|-------|
| IPC handlers | `src/main/index.ts`, `src/main/preload.ts` |
| Keyboard shortcuts | `src/renderer/constants/shortcuts.ts`, `App.tsx` |
| Settings | `src/renderer/hooks/useSettings.ts` |
| Themes | `src/renderer/constants/themes.ts`, `src/shared/theme-types.ts` |
| Modal priorities | `src/renderer/constants/modalPriorities.ts` |
| Agent definitions | `src/shared/agentIds.ts`, `src/main/agents/definitions.ts`, `src/main/agents/capabilities.ts` |
| Output parsers | `src/main/parsers/`, `src/main/parsers/index.ts` |
| System prompts | `src/prompts/*.md` |

## Code Conventions

### Formatting & Style

- **Tabs for indentation** in TypeScript/JavaScript (not spaces). JSON/YAML use 2-space indent.
- Prettier config: tabs, single quotes, trailing commas (es5), 100 char print width.
- Husky pre-commit hooks auto-format staged files.

### TypeScript

- Strict mode enabled across all configs (`tsconfig.json`, `tsconfig.main.json`, `tsconfig.cli.json`).
- Three separate tsconfig files: renderer/web/shared, main process, and CLI.
- `@typescript-eslint/no-explicit-any` is currently `off` (legacy; avoid adding new `any`).
- `react-hooks/exhaustive-deps` is intentionally `off` — this codebase uses refs to access latest values without causing re-renders.

### React & UI

- Functional components with hooks only.
- Use Tailwind for layout, **inline styles for theme colors** (e.g., `style={{ color: theme.colors.textMain }}`). Never hardcode hex colors for themed elements.
- Modals must register with the LayerStack system (don't handle Escape locally).
- Focus management: use `tabIndex={-1}` + `outline-none` for programmatic focus.

### Settings Pattern

New settings follow a wrapper function pattern:
1. State with `useState` in `useSettings.ts`
2. Wrapper function that updates state AND calls `window.maestro.settings.set()`
3. Load in `useEffect` from `window.maestro.settings.get()`

### Error Handling

- Let unexpected exceptions bubble up — Sentry captures them automatically.
- Handle only expected/recoverable errors explicitly; re-throw unexpected ones.
- Use `captureException`/`captureMessage` from `src/main/utils/sentry.ts` for explicit reporting.
- Use `execFileNoThrow` for external commands (never shell-based execution).
- Always `spawn()` with `shell: false`.

### SSH Remote Execution

Any feature spawning agent processes **must** support SSH remote execution:
1. Check `session.sshRemoteConfig?.enabled`
2. Use `wrapSpawnWithSsh()` from `src/main/utils/ssh-spawn-wrapper.ts`
3. Use agent's `binaryName` for remote execution (not local paths)
4. Don't hardcode `claude-code` — respect the configured agent type

### Commit Messages

Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

### Branching

- `main` = stable (odd minor versions, e.g., 0.15.x)
- `rc` = pre-release (even minor versions, e.g., 0.16.x)
- Bug fixes → `main`. New features → `rc`.

## Performance

- Memoize expensive computations with `useMemo`; use Maps for O(1) lookups instead of `Array.find()`.
- Batch IPC calls; use `useBatchedSessionUpdates` for high-frequency updates.
- Prefer 3-second intervals over 1-second for non-critical polling. Use event-driven updates via IPC when possible.
- Clean up all timers, event listeners, and subscriptions in `useEffect` cleanup.

## Encore Features (Feature Gating)

Optional features disabled by default. When disabled, they must be completely invisible (no shortcuts, no menu items). Pattern: add flag to `EncoreFeatureFlags` in `src/renderer/types/index.ts`, default to `false` in `useSettings.ts`, gate all UI access points.
