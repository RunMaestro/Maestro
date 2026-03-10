# Feature-Specific Notes

## Usage Dashboard (`src/renderer/components/UsageDashboard/`)

- Backend: SQLite (`better-sqlite3`) with WAL mode → `src/main/stats-db.ts`
- Tables: `query_events`, `auto_run_sessions`, `auto_run_tasks`, `_migrations`
- Real-time: backend broadcasts `stats:updated` event, frontend debounces refresh
- Colorblind palettes: Wong-based, 3 variants → `src/renderer/constants/colorblindPalettes.ts`
- Charts wrapped in `ChartErrorBoundary` with retry

## Document Graph (`src/renderer/components/DocumentGraph/`)

- Scans markdown for `[[wiki-links]]` and `[markdown](links)`
- React Flow for visualization
- Force-directed + hierarchical layout (`layoutAlgorithms.ts`)
- File watching via chokidar (NOT available for SSH remotes)
- Large files truncated: >1MB → parse first 100KB only
- Default 50 nodes, "Load more" adds 25

## Group Chat System (`src/main/group-chat/`)

- Moderator AI orchestrates multi-agent conversations
- @mentions route messages to specific agents
- No @mentions in moderator response = conversation complete
- Output buffer: 10MB limit (larger than process-manager's 100KB)
- Storage: `~/Library/Application Support/maestro/group-chats/{chatId}/`

## Auto Run

- File-based document runner: markdown docs with checkbox tasks
- Playbooks: saved configurations for repeated batch runs
- Playbook assets: `assets/` subfolder (config files, YAML, Dockerfiles)
- Worktree support: operates in isolated git directory for true parallelization
- Achievement system: 15 conductor levels (1 min → 200 hours)

## Director's Notes (Encore Feature)

- First Encore Feature — canonical gating example
- Flag: `encoreFeatures.directorNotes`
- Generates AI synopsis of work across sessions
