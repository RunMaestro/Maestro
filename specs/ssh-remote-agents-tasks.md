# SSH Remote Agent Execution - Tasks

## Feature: SSH Remote Agent Execution
## Spec: specs/ssh-remote-agents.md
## Plan: specs/ssh-remote-agents-plan.md
## Branch: 1-ssh-tunnel-agents
## Date: 2025-12-27

---

## User Stories (from spec)

| ID | Story | Priority |
|----|-------|----------|
| US1 | Configure SSH remote globally | P1 (Must Have) |
| US2 | Agent commands execute on remote via SSH | P1 (Must Have) |
| US3 | Per-agent remote override | P2 (Should Have) |
| US4 | Connection test functionality | P2 (Should Have) |
| US5 | Connection status visibility | P2 (Should Have) |

---

## Phase 1: Setup

**Goal**: Project infrastructure and shared types.

- [x] T001 Add SshRemoteConfig interface to src/shared/types.ts
- [x] T002 Add SshRemoteStatus interface to src/shared/types.ts
- [x] T003 Add SshRemoteTestResult interface to src/shared/types.ts
- [x] T004 Add AgentSshRemoteConfig interface to src/shared/types.ts
- [x] T005 [P] Create shellEscape utility function in src/main/utils/shell-escape.ts
- [x] T006 Add sshRemotes and defaultSshRemoteId defaults to store in src/main/index.ts

**Phase 1 Notes (2025-12-27):**
- All SSH-related interfaces added to `src/shared/types.ts` with full JSDoc documentation
- Created `src/main/utils/shell-escape.ts` with `shellEscape`, `shellEscapeArgs`, and `buildShellCommand` functions
- Added `sshRemotes` (empty array) and `defaultSshRemoteId` (null) to MaestroSettings with store defaults
- Added 14 unit tests for shell-escape utility in `src/__tests__/main/utils/shell-escape.test.ts`

---

## Phase 2: Foundational - SSH Remote Manager

**Goal**: Core SSH remote manager with validation and connection testing.

**Prerequisite**: Phase 1 complete.

- [x] T007 Create SshRemoteManager class skeleton in src/main/ssh-remote-manager.ts
- [x] T008 Implement validateConfig method in src/main/ssh-remote-manager.ts
- [x] T009 Implement testConnection method in src/main/ssh-remote-manager.ts
- [x] T010 Implement buildSshArgs helper method in src/main/ssh-remote-manager.ts
- [x] T011 Export SshRemoteManager singleton instance in src/main/ssh-remote-manager.ts

**Phase 2 Notes (2025-12-27):**
- Created `src/main/ssh-remote-manager.ts` with full `SshRemoteManager` class
- Implemented `validateConfig()` for required fields, port range (1-65535), and private key readability
- Implemented `testConnection()` with SSH connection test, hostname retrieval, and optional agent detection
- Implemented `buildSshArgs()` for constructing SSH command-line arguments with security options (BatchMode, StrictHostKeyChecking, ConnectTimeout)
- Added dependency injection pattern (`SshRemoteManagerDeps`) for testability
- Comprehensive SSH error parsing for user-friendly messages (permission denied, connection refused, timeout, hostname resolution, host key changed, passphrase issues)
- Added 38 unit tests in `src/__tests__/main/ssh-remote-manager.test.ts`
- Exported `sshRemoteManager` singleton instance for use throughout the application

---

## Phase 3: User Story 1 - Configure SSH Remote Globally

**Goal**: User can add, edit, delete SSH remote configurations and set a global default.

**Test Criteria**: Can call `window.maestro.sshRemote.saveConfig()`, `getConfigs()`, `setDefaultId()` from devtools.

- [x] T012 [US1] Create IPC handlers file src/main/ipc/handlers/ssh-remote.ts
- [x] T013 [US1] Implement ssh-remote:saveConfig handler in src/main/ipc/handlers/ssh-remote.ts
- [x] T014 [US1] Implement ssh-remote:deleteConfig handler in src/main/ipc/handlers/ssh-remote.ts
- [x] T015 [US1] Implement ssh-remote:getConfigs handler in src/main/ipc/handlers/ssh-remote.ts
- [x] T016 [US1] Implement ssh-remote:getDefaultId handler in src/main/ipc/handlers/ssh-remote.ts
- [x] T017 [US1] Implement ssh-remote:setDefaultId handler in src/main/ipc/handlers/ssh-remote.ts
- [x] T018 [US1] Register SSH remote handlers in src/main/ipc/handlers/index.ts
- [x] T019 [US1] Expose sshRemote API in src/main/preload.ts

**Phase 3 Backend Notes (2025-12-27):**
- Created `src/main/ipc/handlers/ssh-remote.ts` with 6 IPC handlers:
  - `ssh-remote:saveConfig` - Create or update SSH remote configuration with validation
  - `ssh-remote:deleteConfig` - Delete SSH remote by ID, auto-clears default if deleted
  - `ssh-remote:getConfigs` - Get all stored SSH remote configurations
  - `ssh-remote:getDefaultId` - Get the global default SSH remote ID
  - `ssh-remote:setDefaultId` - Set/clear the global default SSH remote ID
  - `ssh-remote:test` - Test SSH connection (accepts config ID or full config object)
- Registered handlers in `src/main/ipc/handlers/index.ts`
- Exposed `window.maestro.sshRemote` API in `src/main/preload.ts` with full TypeScript types
- Updated `MaestroSettings` interface to include `sshRemotes` and `defaultSshRemoteId` fields
- Added 19 unit tests in `src/__tests__/main/ipc/handlers/ssh-remote.test.ts`
- All IPC handlers use `createIpcHandler` pattern for consistent error handling and logging

- [x] T020 [US1] Create useSshRemotes hook in src/renderer/hooks/useSshRemotes.ts
- [x] T021 [US1] Create SshRemoteModal component in src/renderer/components/Settings/SshRemoteModal.tsx
- [x] T022 [US1] Create SshRemotesSection component in src/renderer/components/Settings/SshRemotesSection.tsx
- [x] T023 [US1] Integrate SshRemotesSection into src/renderer/components/Settings/SettingsModal.tsx

**Phase 3 Frontend Notes (2025-12-27):**
- Created `src/renderer/components/Settings/SshRemoteModal.tsx` with form for adding/editing SSH remotes
  - Display name, host, port, username, private key path
  - Optional remote working directory and environment variables
  - Enabled/disabled toggle
  - Connection testing with result display (success/error with hostname)
  - Uses `Modal` and `FormInput` components for consistent UI
- Created `src/renderer/components/Settings/SshRemotesSection.tsx` for the Settings modal
  - Lists all configured SSH remotes with status badges (default, disabled)
  - Inline actions: test connection, set as default, edit, delete
  - Empty state with helpful instructions
  - Add SSH Remote button
  - Integrates with `useSshRemotes` hook for all state management
- Added `SSH_REMOTE` modal priority (460) in `modalPriorities.ts`
- Integrated `SshRemotesSection` into `SettingsModal.tsx` general tab
- Created `src/renderer/components/Settings/index.ts` for exports

---

## Phase 4: User Story 2 - Agent Commands Execute on Remote

**Goal**: When SSH remote is configured, agent spawns execute via SSH on the remote host.

**Test Criteria**: Configure remote via devtools, spawn agent, verify SSH command wraps agent invocation.

**Prerequisite**: US1 complete (need config storage).

- [x] T024 [P] [US2] Create buildSshCommand function in src/main/utils/ssh-command-builder.ts
- [x] T025 [P] [US2] Create buildRemoteCommand function in src/main/utils/ssh-command-builder.ts

**Phase 4 (T024-T025) Notes (2025-12-27):**
- Created `src/main/utils/ssh-command-builder.ts` with:
  - `buildRemoteCommand()`: Constructs escaped shell command string with optional cwd and env vars
  - `buildSshCommand()`: Builds full SSH command with args for spawn(), merging config and command-specific options
- Security considerations:
  - Command name is NOT escaped (trusted, from agent config) to preserve PATH resolution
  - All user-controllable values (args, cwd, env values) ARE escaped via shellEscape
  - Environment variable names are validated (alphanumeric + underscore only)
- Added 29 unit tests in `src/__tests__/main/utils/ssh-command-builder.test.ts`
  - Tests cover: basic command building, cwd handling, env merging, tilde expansion
  - Security tests: injection prevention via args, cwd, env values, invalid env names
- [ ] T026 [US2] Add getSshRemoteConfig helper to resolve effective remote in src/main/process-manager.ts
- [ ] T027 [US2] Modify spawn() to detect SSH remote config in src/main/process-manager.ts
- [ ] T028 [US2] Wrap agent command with buildSshCommand when SSH enabled in src/main/process-manager.ts
- [ ] T029 [US2] Pass agent config env vars to remote command in src/main/process-manager.ts

---

## Phase 5: User Story 3 - Per-Agent Remote Override

**Goal**: User can configure different SSH remotes for different agents.

**Test Criteria**: Set agent-specific remote in UI, verify that agent uses override instead of global default.

**Prerequisite**: US1 and US2 complete.

- [ ] T030 [US3] Add SSH remote dropdown to agent config in src/renderer/components/AgentConfigModal.tsx
- [ ] T031 [US3] Save agent SSH remote selection to agent config store in src/renderer/components/AgentConfigModal.tsx
- [ ] T032 [US3] Update getSshRemoteConfig to check agent override first in src/main/process-manager.ts

---

## Phase 6: User Story 4 - Connection Test Functionality

**Goal**: User can test SSH connection before using it.

**Test Criteria**: Click "Test Connection" in modal, see success/failure result with remote hostname.

**Prerequisite**: US1 complete.

- [ ] T033 [US4] Implement ssh-remote:test handler in src/main/ipc/handlers/ssh-remote.ts
- [ ] T034 [US4] Add test IPC call to sshRemote API in src/main/preload.ts
- [ ] T035 [US4] Add testConnection function to useSshRemotes hook in src/renderer/hooks/useSshRemotes.ts
- [ ] T036 [US4] Add Test Connection button and result display in src/renderer/components/Settings/SshRemoteModal.tsx
- [ ] T037 [US4] Add Test button per remote in list in src/renderer/components/Settings/SshRemotesSection.tsx

---

## Phase 7: User Story 5 - Connection Status Visibility

**Goal**: User sees which remote a session is using and connection status.

**Test Criteria**: Session header shows remote name indicator when using SSH remote.

**Prerequisite**: US2 complete.

- [ ] T038 [US5] Add sshRemoteId field to session state tracking in src/renderer/App.tsx
- [ ] T039 [US5] Add remote indicator component to src/renderer/components/SessionHeader.tsx
- [ ] T040 [US5] Show remote name or "Local" based on session config in src/renderer/components/SessionHeader.tsx
- [ ] T041 [US5] Style indicator with appropriate colors (normal/error) in src/renderer/components/SessionHeader.tsx

---

## Phase 8: Polish

**Goal**: Error handling improvements and edge cases.

- [ ] T042 Add SSH-specific error pattern detection in output parsing in src/main/process-manager.ts
- [ ] T043 Handle "Permission denied" SSH error with user-friendly message
- [ ] T044 Handle "command not found" error for missing agent on remote
- [ ] T045 Handle "Connection refused" error for unreachable host
- [ ] T046 Handle connection drop mid-session with error state

---

## Dependencies

```
Phase 1 (Setup)
    │
    ▼
Phase 2 (Foundational)
    │
    ▼
Phase 3 (US1: Global Config) ◄── Required for all other stories
    │
    ├──────────────────┬──────────────────┐
    ▼                  ▼                  ▼
Phase 4 (US2)      Phase 6 (US4)      (independent)
    │                  │
    ├──────────────────┤
    ▼                  │
Phase 5 (US3)          │
    │                  │
    ▼                  │
Phase 7 (US5) ◄────────┘
    │
    ▼
Phase 8 (Polish)
```

---

## Parallel Execution Opportunities

### Within Phase 1:
- T005 (shell-escape.ts) can run parallel to T001-T004 (types)

### Within Phase 3 (US1):
- T012-T019 (backend) must complete before T020-T023 (frontend)
- T020, T021, T022 can run in parallel (independent React components)

### Within Phase 4 (US2):
- T024, T025 (command builders) can run in parallel
- T026-T029 must be sequential (all modify process-manager.ts)

### Cross-Phase:
- Phase 4 (US2) and Phase 6 (US4) can run in parallel after Phase 3

---

## Task Summary

| Phase | Story | Task Count |
|-------|-------|------------|
| 1 | Setup | 6 |
| 2 | Foundational | 5 |
| 3 | US1 - Global Config | 12 |
| 4 | US2 - Remote Execution | 6 |
| 5 | US3 - Per-Agent Override | 3 |
| 6 | US4 - Connection Test | 5 |
| 7 | US5 - Status Visibility | 4 |
| 8 | Polish | 5 |
| **Total** | | **46** |

---

## MVP Scope

**Recommended MVP**: Phases 1-4 (US1 + US2)

This delivers:
- SSH remote configuration (add/edit/delete)
- Global default remote setting
- Agent execution via SSH
- Basic functionality complete

**Post-MVP**: Phases 5-8 (US3, US4, US5, Polish)
- Per-agent override
- Connection testing UI
- Status indicators
- Error handling polish

---

## Implementation Strategy

1. **Start with Phase 1-2**: Types and core manager (no UI)
2. **Phase 3 backend first**: IPC handlers before React components
3. **Phase 4 early**: Get remote execution working before UI polish
4. **Parallel track**: Phase 6 (connection test) can develop alongside Phase 4
5. **UI polish last**: Phases 5, 7, 8 after core functionality works
