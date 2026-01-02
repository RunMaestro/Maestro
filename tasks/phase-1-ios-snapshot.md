# Phase 1: ios.snapshot - Stop Flying Blind

**Goal**: Implement the first "close the loop" capability - capturing screenshot, logs, and crash data as artifacts that the AI agent can analyze.

**Deliverable**: `ios.snapshot` slash command and Auto Run step that captures current app state.

**Dependency**: Phase 0 (ios-tools module)

---

## Snapshot Service

- [x] Create `src/main/ios-tools/snapshot.ts` - snapshot orchestration service
  - [x] Implement `SnapshotOptions` interface
    ```typescript
    interface SnapshotOptions {
      simulatorUdid: string;
      bundleId?: string;        // Optional: filter logs to specific app
      outputDir: string;        // Where to save artifacts
      includeSystemLog?: boolean;  // Default: true
      includeCrashLogs?: boolean;  // Default: true
      logDuration?: number;     // Seconds of recent logs to capture (default: 60)
    }
    ```
    **Note (2026-01-01)**: Implementation uses `udid` instead of `simulatorUdid`, adds `sessionId` for artifact organization, and `snapshotId` for custom naming. See `src/main/ios-tools/snapshot.ts` for full interface.
  - [x] Implement `SnapshotResult` interface
    ```typescript
    interface SnapshotResult {
      screenshotPath: string;
      systemLogPath?: string;
      crashLogPaths?: string[];
      timestamp: Date;
      simulatorName: string;
      bundleId?: string;
      metadata: {
        screenSize: { width: number; height: number };
        deviceType: string;
        osVersion: string;
      };
    }
    ```
    **Note (2026-01-01)**: Implementation groups data under `simulator`, `screenshot`, `logs`, and `crashes` objects. Logs include counts by level (error, fault, warning, info, debug). See `src/main/ios-tools/snapshot.ts` for full interface.
  - [x] Implement `captureSnapshot(options)` - main snapshot function
    - [x] Validate simulator is booted
    - [x] Create output directory with timestamp subfolder
    - [x] Capture screenshot
    - [x] Capture recent system logs (filtered by bundleId if provided)
    - [x] Check for and copy any crash logs
    - [x] Generate metadata JSON
    - [x] Return structured result
    **Note (2026-01-01)**: All subtasks implemented. Unit tests added in `src/__tests__/main/ios-tools/snapshot.test.ts` (21 tests).

## Artifact Management

- [x] Create `src/main/ios-tools/artifacts.ts` - artifact storage management
  - [x] Implement `getArtifactDirectory(sessionId)` - get/create session artifact dir
  - [x] Implement `createSnapshotBundle(result)` - package all artifacts
    **Note (2026-01-01)**: Implemented as `getSnapshotDirectory()` + automatic bundling during capture.
  - [x] Implement `listSnapshots(sessionId)` - list all snapshots for session
    **Note (2026-01-01)**: Implemented as `listSessionArtifacts()`.
  - [x] Implement `cleanupOldSnapshots(sessionId, keepCount)` - prune old artifacts
    **Note (2026-01-01)**: Implemented as `pruneSessionArtifacts()` with default keepCount of 50.
  - [x] Define artifact directory structure:
    ```
    ~/.maestro/ios-artifacts/{sessionId}/
    ├── snapshots/
    │   ├── 2024-01-15T10-30-00/
    │   │   ├── screenshot.png
    │   │   ├── syslog.txt
    │   │   ├── crash.log (if present)
    │   │   └── metadata.json
    │   └── ...
    └── recordings/
    ```
    **Note (2026-01-01)**: Directory structure uses `~/Library/Application Support/Maestro/ios-artifacts/{sessionId}/{snapshotId}/`. Logs saved as `logs.json`. Unit tests added in `src/__tests__/main/ios-tools/artifacts.test.ts` (23 tests).

## IPC Handlers

- [x] Add snapshot IPC handlers to `src/main/ipc/handlers/ios.ts`
  - [x] Register `ios:snapshot:capture` handler
  - [x] Register `ios:snapshot:list` handler
  - [x] Register `ios:snapshot:cleanup` handler
  - [x] Register `ios:artifacts:getDir` handler (as `ios:artifacts:getDirectory`)
  **Note (2026-01-01)**: All IPC handlers implemented. Additional handlers also available:
  - `ios:snapshot:format` - Format snapshot for agent output
  - `ios:snapshot:formatJson` - Format snapshot as JSON
  - `ios:artifacts:list` - List session artifacts
  - `ios:artifacts:prune` - Prune old artifacts
  - `ios:artifacts:size` - Get total size of artifacts
  Unit tests added in `src/__tests__/main/ipc/handlers/ios.test.ts` (16 tests).

## Slash Command Integration

- [x] Create `src/main/slash-commands/ios-snapshot.ts` - slash command handler
  - [x] Implement `/ios.snapshot` command
  - [x] Parse command arguments:
    - `--simulator <name|udid>` - target simulator (default: first booted)
    - `--app <bundleId>` - filter logs to app
    - `--output <path>` - custom output directory
    - `--duration <seconds>` - log duration (default: 60)
    - `--include-crash` - include full crash log content
  - [x] Display snapshot result in AI terminal output
  - [x] Format screenshot path as clickable link
  - [x] Include log summary (error count, last N lines)
  **Note (2026-01-02)**: Implemented with argument parsing supporting both long and short forms. Includes simulator name-to-UDID resolution. Exposes via IPC at `ios:slashCommand:snapshot`. Unit tests in `src/__tests__/main/slash-commands/ios-snapshot.test.ts` (35 tests).

- [x] Register command in slash command registry
  - [x] Add to `src/main/slash-commands/index.ts`
  - [x] Add command metadata for autocomplete
  **Note (2026-01-02)**: Command already registered in `src/renderer/slashCommands.ts` for autocomplete. Added `snapshotCommandMetadata` with usage, options, and examples for help display.

## Agent-Consumable Output

- [x] Create `src/main/ios-tools/snapshot-formatter.ts` - format output for AI
  - [x] Implement `formatSnapshotForAgent(result)` - returns structured text
    ```
    ## iOS Snapshot Captured

    **Timestamp**: 2024-01-15T10:30:00
    **Simulator**: iPhone 15 Pro (iOS 17.2)
    **App**: com.example.myapp

    ### Screenshot
    Saved to: /path/to/screenshot.png

    ### System Log Summary
    - Total lines: 245
    - Errors: 3
    - Warnings: 12
    - Last error: "Failed to load resource at..."

    ### Crash Logs
    No crash logs found (or: 1 crash log captured)

    ### Artifacts
    All artifacts saved to: /path/to/artifacts/
    ```
    **Note (2026-01-01)**: Returns `FormattedSnapshot` with `summary`, `sections`, and `fullOutput`. Also includes `formatSnapshotAsJson()` for structured JSON output.
  - [x] Implement `summarizeLog(logContent, maxLines)` - extract key info from logs
    **Note (2026-01-01)**: Takes `LogEntry[]` and returns counts, top errors/warnings.
  - [x] Implement `detectLogErrors(logContent)` - find error patterns
    **Note (2026-01-01)**: Integrated into `summarizeLog()` - filters by level='error' or 'fault'.
  - [x] Implement `detectLogWarnings(logContent)` - find warning patterns
    **Note (2026-01-01)**: Integrated into `summarizeLog()` - checks message content for 'warning'/'warn'. Unit tests added in `src/__tests__/main/ios-tools/snapshot-formatter.test.ts` (26 tests).

## Auto Run Integration

- [x] Create Auto Run step type for ios.snapshot
  - [x] Add to available Auto Run actions
  - [x] Support in playbook YAML format
  - [x] Example:
    ```yaml
    - action: ios.snapshot
      simulator: "iPhone 15 Pro"
      app: com.example.myapp
      store_as: snapshot_result
    ```
  **Note (2026-01-01)**: Implemented a new YAML-based playbook action system in `src/cli/services/playbook-actions/`. The system provides:
  - **Action Registry** (`action-registry.ts`) - Central registry for all playbook actions
  - **YAML Parser** (`yaml-parser.ts`) - Parses YAML playbooks with step validation
  - **Executor** (`executor.ts`) - Executes playbooks with variable substitution, conditions, and error handling
  - **ios.snapshot Action** (`actions/ios-snapshot.ts`) - Full implementation with all input options

  The action supports:
  - `simulator` - Simulator name or UDID (resolves names to UDIDs automatically)
  - `app` - Bundle ID to filter logs
  - `output` - Custom output directory
  - `duration` - Log duration in seconds (default: 60)
  - `include_crash` - Include full crash log content
  - `store_as` - Store result in variables for subsequent steps

  Unit tests: 92 tests in `src/__tests__/cli/services/playbook-actions/` covering types, registry, parser, executor, and ios-snapshot action.

## UI Components (Optional Phase 1 Stretch)

- [x] Create `src/renderer/components/iOSSnapshot/` directory
- [x] Create `SnapshotViewer.tsx` - display captured screenshot
  **Note (2026-01-01)**: Implemented with:
  - Image display with fit-to-container sizing
  - Click-to-zoom lightbox modal using existing LightboxModal component
  - Error state handling for missing/invalid images
  - Theme-aware styling
  - External viewer button (opens in system image viewer)
  - Metadata display (file size, timestamp)
- [x] Create `IOSLogViewer.tsx` - display and search logs
  **Note (2026-01-01)**: Implemented with:
  - Log level filtering (error, fault, warning, info, debug, default)
  - Full-text search across log messages with Cmd+F keyboard shortcut
  - Expandable log entries with full details (message, subsystem, category, PID)
  - Color-coded log levels matching theme colors
  - Copy log entry to clipboard
  - Scrollable log list with pagination
- [x] Create `iOSSnapshotPanel.tsx` - main panel combining SnapshotViewer and IOSLogViewer
  **Note (2026-01-01)**: Unified panel component with:
  - Screenshot display with zoom capability
  - Log viewer with filtering and search
  - Crash log alert section with expandable details
  - Capture new snapshot button with loading state
  - Snapshot history dropdown with cleanup option
  - Simulator info header showing device name, iOS version, and relative time
- [x] Create `index.ts` - exports all components
  **Note (2026-01-01)**: Exports SnapshotViewer, IOSLogViewer, iOSSnapshotPanel with types
- [ ] Add snapshot tab to Right Bar for iOS sessions
  **Note (2026-01-01)**: Left as optional stretch - requires iOS session detection and RightPanel modification. The `iOSSnapshotPanel` component is ready for integration.

## Error Handling

- [x] Handle "no simulator booted" gracefully with helpful message
  **Note (2026-01-01)**: Implemented centralized error handling module `src/main/ios-tools/errors.ts` with:
  - User-friendly error messages with troubleshooting hints for all error codes
  - `noBootedSimulatorError()` helper for consistent "no simulator booted" errors
  - `validateSimulatorBooted()` helper to check simulator state
  - Error messages include simulator name and actionable hints (e.g., "Start a simulator with: xcrun simctl boot...")
- [x] Handle "no app installed" when bundleId specified
  **Note (2026-01-01)**: `appNotInstalledError()` helper with bundle ID in message. Existing detection in `simulator.ts` uses `APP_NOT_INSTALLED` error code.
- [x] Handle permission errors on artifact directory
  **Note (2026-01-01)**: `permissionDeniedError()` helper. `snapshot.ts` now detects EACCES/permission patterns and provides path in error message.
- [x] Handle screenshot timeout (simulator frozen)
  **Note (2026-01-01)**: `screenshotTimeoutError()` helper. `capture.ts` now detects timeout patterns in output and suggests restarting Simulator.app.
- [x] Handle log parsing errors
  **Note (2026-01-01)**: `logParsingWarning()` helper logs malformed entries without failing. `logs.ts` gracefully skips malformed JSON lines. Added `ERROR_PATTERNS` for detecting common error types from command output.

## Testing

- [x] Write unit tests for snapshot-formatter.ts
  **Note (2026-01-01)**: 26 tests in `src/__tests__/main/ios-tools/snapshot-formatter.test.ts`
- [x] Write unit tests for artifacts.ts
  **Note (2026-01-01)**: 23 tests in `src/__tests__/main/ios-tools/artifacts.test.ts`
- [x] Write unit tests for snapshot.ts
  **Note (2026-01-01)**: 21 tests in `src/__tests__/main/ios-tools/snapshot.test.ts` - covers captureSnapshot with mocked dependencies
- [ ] Write integration test for full snapshot flow
- [x] Test with various log sizes (small, large, empty)
  **Note (2026-01-01)**: Covered in snapshot.test.ts and snapshot-formatter.test.ts
- [x] Test crash log detection
  **Note (2026-01-01)**: Covered in snapshot.test.ts - tests hasCrashes, crash reports, includeCrashContent option

## Documentation

- [ ] Document `/ios.snapshot` command in README
- [ ] Add usage examples
- [ ] Document artifact directory structure
- [ ] Document integration with Auto Run

## Acceptance Criteria

- [ ] `/ios.snapshot` captures screenshot of running simulator
- [ ] Command captures recent system logs (last 60 seconds)
- [ ] Command captures crash logs if any exist
- [ ] All artifacts saved to organized directory structure
- [ ] Agent receives structured summary it can reason about
- [ ] Command works with or without bundleId filter
- [ ] Screenshot path is usable by agent for further analysis
- [ ] Log summary highlights errors and warnings
- [ ] Works in Auto Run document steps
