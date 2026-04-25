<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# Shared Utilities Reference

All utilities in Maestro organized by category. Each entry lists the file path, function name, signature, purpose, and which process it runs in (Main, Renderer, or Both via `src/shared/`).

---

## IDs & UUIDs

| Function       | File                        | Signature      | Process  | Purpose                                                                                    |
| -------------- | --------------------------- | -------------- | -------- | ------------------------------------------------------------------------------------------ |
| `generateUUID` | `src/shared/uuid.ts`        | `() => string` | Both     | RFC 4122 v4 UUID via Math.random(). Used for session IDs, history entry IDs.               |
| `generateId`   | `src/renderer/utils/ids.ts` | `() => string` | Renderer | Wrapper around `crypto.randomUUID()`. Cryptographically secure. Used for UI-generated IDs. |

---

## Agent IDs & Metadata

| Function / Constant       | File                           | Signature                                 | Process | Purpose                                                                                                                                                  |
| ------------------------- | ------------------------------ | ----------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_IDS`               | `src/shared/agentIds.ts`       | `readonly string[]`                       | Both    | Single source of truth: `['terminal', 'claude-code', 'codex', 'gemini-cli', 'qwen3-coder', 'opencode', 'factory-droid', 'copilot-cli']`                  |
| `AgentId`                 | `src/shared/agentIds.ts`       | Type derived from `AGENT_IDS`             | Both    | Union type of all valid agent IDs.                                                                                                                       |
| `isValidAgentId`          | `src/shared/agentIds.ts`       | `(id: string) => id is AgentId`           | Both    | Type guard for agent ID validation.                                                                                                                      |
| `AGENT_DISPLAY_NAMES`     | `src/shared/agentMetadata.ts`  | `Record<AgentId, string>`                 | Both    | Internal constant backing `getAgentDisplayName`. **Prefer `getAgentDisplayName()`** for external use — it falls back to the raw id for unknown agents.   |
| `getAgentDisplayName`     | `src/shared/agentMetadata.ts`  | `(agentId: AgentId \| string) => string`  | Both    | Get display name, falls back to raw id.                                                                                                                  |
| `BETA_AGENTS`             | `src/shared/agentMetadata.ts`  | `ReadonlySet<AgentId>`                    | Both    | Internal constant backing `isBetaAgent`. Currently contains `opencode`, `factory-droid`, and `copilot-cli`. **Prefer `isBetaAgent()`** for external use. |
| `isBetaAgent`             | `src/shared/agentMetadata.ts`  | `(agentId: AgentId \| string) => boolean` | Both    | Check if an agent is in beta.                                                                                                                            |
| `DEFAULT_CONTEXT_WINDOWS` | `src/shared/agentConstants.ts` | `Partial<Record<AgentId, number>>`        | Both    | Default context window sizes per agent (e.g., claude-code: 200000).                                                                                      |
| `FALLBACK_CONTEXT_WINDOW` | `src/shared/agentConstants.ts` | `number` (200000)                         | Both    | Fallback when agent has no entry in DEFAULT_CONTEXT_WINDOWS.                                                                                             |
| `COMBINED_CONTEXT_AGENTS` | `src/shared/agentConstants.ts` | `ReadonlySet<AgentId>`                    | Both    | Agents with combined input+output context windows (currently: codex).                                                                                    |

---

## Platform Detection

### Main Process (`src/shared/platformDetection.ts` - usable in both processes)

| Function            | Signature       | Purpose                                                                |
| ------------------- | --------------- | ---------------------------------------------------------------------- |
| `isWindows()`       | `() => boolean` | Returns `process.platform === 'win32'`. Reads at call time (mockable). |
| `isMacOS()`         | `() => boolean` | Returns `process.platform === 'darwin'`.                               |
| `isLinux()`         | `() => boolean` | Returns `process.platform === 'linux'`.                                |
| `getWhichCommand()` | `() => string`  | Returns `'where'` on Windows, `'which'` on Unix.                       |

### Renderer Process (`src/renderer/utils/platformUtils.ts`)

| Function                   | Signature                      | Purpose                                                        |
| -------------------------- | ------------------------------ | -------------------------------------------------------------- |
| `isWindowsPlatform()`      | `() => boolean`                | Uses `window.maestro.platform` (from preload bridge).          |
| `isMacOSPlatform()`        | `() => boolean`                | Uses `window.maestro.platform`.                                |
| `isLinuxPlatform()`        | `() => boolean`                | Uses `window.maestro.platform`.                                |
| `getRevealLabel(platform)` | `(platform: string) => string` | Platform-appropriate "Reveal in Finder/Explorer/File Manager". |
| `getOpenInLabel(platform)` | `(platform: string) => string` | Platform-appropriate "Open in Finder/Explorer/File Manager".   |

### WSL Detection (`src/main/utils/wslDetector.ts` - Main only)

| Function                       | Signature                       | Purpose                                               |
| ------------------------------ | ------------------------------- | ----------------------------------------------------- |
| `isWsl()`                      | `() => boolean`                 | Cached detection via `/proc/version`.                 |
| `isWindowsMountPath(filepath)` | `(filepath: string) => boolean` | Checks if path is `/mnt/[a-z]/...`.                   |
| `checkWslEnvironment(cwd)`     | `(cwd: string) => boolean`      | Log warning if running from Windows mount in WSL.     |
| `getWslWarningMessage()`       | `() => string`                  | User-friendly warning about WSL+Windows mount issues. |

---

## Path & Version Utilities (`src/shared/pathUtils.ts` - Both)

| Function                               | Signature                                       | Purpose                                                                  |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| `expandTilde(filePath, homeDir?)`      | `(string, string?) => string`                   | Expand `~` to home directory. Node fs doesn't handle tilde.              |
| `encodeClaudeProjectPath(projectPath)` | `(string) => string`                            | Replace non-alphanumeric chars with `-`. Matches Claude Code's encoding. |
| `parseVersion(version)`                | `(string) => number[]`                          | Parse `"v22.10.0"` or `"0.15.0-rc.1"` to `[22, 10, 0]`.                  |
| `compareVersions(a, b)`                | `(string, string) => number`                    | Semver comparison. Returns 1, -1, or 0. Handles pre-release tags.        |
| `detectNodeVersionManagerBinPaths()`   | `() => string[]`                                | Find nvm, fnm, volta, mise, asdf, n bin paths on Unix.                   |
| `buildExpandedPath(customPaths?)`      | `(string[]?) => string`                         | Build PATH with platform-specific binary locations added.                |
| `buildExpandedEnv(customEnvVars?)`     | `(Record<string,string>?) => NodeJS.ProcessEnv` | Copy of process.env with expanded PATH + custom vars.                    |

---

## String Utilities

### Shared (`src/shared/stringUtils.ts` - Both)

| Function               | Signature            | Purpose                                                                                                     |
| ---------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `stripAnsiCodes(text)` | `(string) => string` | Remove ANSI escape codes, OSC sequences, iTerm2/VSCode shell integration sequences. Handles SSH edge cases. |

### Main Process (`src/main/utils/stripAnsi.ts`)

| Function         | Signature            | Purpose                                                                            |
| ---------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `stripAnsi(str)` | `(string) => string` | Similar ANSI stripping with regex constants. Used for SSH command output cleaning. |

---

## Formatting (`src/shared/formatters.ts` - Both)

| Function                               | Signature                              | Purpose                                                       |
| -------------------------------------- | -------------------------------------- | ------------------------------------------------------------- |
| `formatSize(bytes)`                    | `(number) => string`                   | File size: `"1.5 MB"`, `"256 KB"`. Auto-scales B/KB/MB/GB/TB. |
| `formatNumber(num)`                    | `(number) => string`                   | Large numbers: `"1.5k"`, `"2.3M"`.                            |
| `formatTokens(tokens)`                 | `(number) => string`                   | Token counts with `~` prefix: `"~1K"`, `"~2M"`.               |
| `formatTokensCompact(tokens)`          | `(number) => string`                   | Token counts without `~`: `"1.5K"`, `"2.3M"`.                 |
| `formatRelativeTime(dateOrTimestamp)`  | `(Date \| number \| string) => string` | `"just now"`, `"5m ago"`, `"2h ago"`, `"Dec 3"`.              |
| `formatActiveTime(ms)`                 | `(number) => string`                   | Duration: `"1D"`, `"2H 30M"`, `"<1M"`.                        |
| `formatElapsedTime(ms)`                | `(number) => string`                   | Precise: `"500ms"`, `"30s"`, `"5m 12s"`, `"1h 10m"`.          |
| `formatElapsedTimeColon(seconds)`      | `(number) => string`                   | Timer style: `"5:12"`, `"1:30:45"`.                           |
| `formatCost(cost)`                     | `(number) => string`                   | USD: `"$1.23"`, `"<$0.01"`, `"$0.00"`.                        |
| `estimateTokenCount(text)`             | `(string) => number`                   | Estimate at ~4 chars/token.                                   |
| `truncatePath(path, maxLength?)`       | `(string, number?) => string`          | `".../parent/current"` format. Default max 35 chars.          |
| `getParentDir(path)`                   | `(string) => string`                   | Return the parent directory segment of a path.                |
| `truncateCommand(command, maxLength?)` | `(string, number?) => string`          | Single-line with ellipsis. Default max 40 chars.              |

---

## Emoji Utilities (`src/shared/emojiUtils.ts` - Both)

| Function                           | Signature                    | Purpose                                         |
| ---------------------------------- | ---------------------------- | ----------------------------------------------- |
| `stripLeadingEmojis(str)`          | `(string) => string`         | Remove leading emojis for alphabetical sorting. |
| `compareNamesIgnoringEmojis(a, b)` | `(string, string) => number` | Compare names ignoring leading emojis.          |

---

## Git Utilities (`src/shared/gitUtils.ts` - Both)

| Function                           | Signature                      | Purpose                                              |
| ---------------------------------- | ------------------------------ | ---------------------------------------------------- |
| `parseGitStatusPorcelain(stdout)`  | `(string) => GitFileStatus[]`  | Parse `git status --porcelain` output.               |
| `countUncommittedChanges(stdout)`  | `(string) => number`           | Count from porcelain output.                         |
| `hasUncommittedChanges(stdout)`    | `(string) => boolean`          | Quick check from porcelain output.                   |
| `parseGitNumstat(stdout)`          | `(string) => GitNumstatFile[]` | Parse `git diff --numstat` into additions/deletions. |
| `parseGitBehindAhead(stdout)`      | `(string) => GitBehindAhead`   | Parse `git rev-list --left-right --count`.           |
| `parseGitBranches(stdout)`         | `(string) => string[]`         | Parse branch list, dedup remote/local, filter HEAD.  |
| `parseGitTags(stdout)`             | `(string) => string[]`         | Parse `git tag --list`.                              |
| `cleanBranchName(stdout)`          | `(string) => string`           | Trim branch name from `git rev-parse`.               |
| `cleanGitPath(stdout)`             | `(string) => string`           | Trim path from git output.                           |
| `remoteUrlToBrowserUrl(remoteUrl)` | `(string) => string \| null`   | Convert SSH/HTTPS git URLs to browser-friendly URLs. |
| `isImageFile(filePath)`            | `(string) => boolean`          | Check extension against known image types.           |
| `getImageMimeType(ext)`            | `(string) => string`           | Get MIME type for image extension.                   |

---

## Template Variables (`src/shared/templateVariables.ts` - Both)

| Function / Constant                              | Signature                                      | Purpose                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `TEMPLATE_VARIABLES`                             | `Array<{variable, description, autoRunOnly?}>` | All available template variables with docs.                                                                     |
| `TEMPLATE_VARIABLES_GENERAL`                     | Same array filtered                            | Excludes Auto Run-only variables.                                                                               |
| `substituteTemplateVariables(template, context)` | `(string, TemplateContext) => string`          | Case-insensitive replacement of `{{VAR}}` placeholders. Handles agent, path, date/time, git, context variables. |

---

## Tree Utilities (`src/shared/treeUtils.ts` - Both)

| Function                                | Signature                                    | Purpose                                                       |
| --------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| `walkTree(nodes, options)`              | `<T>(TreeNode[], WalkTreeOptions<T>) => T[]` | Generic recursive tree walker with onFile/onFolder callbacks. |
| `walkTreePartitioned(nodes, basePath?)` | `(TreeNode[], string?) => PartitionedPaths`  | Walk tree, return `{ files: Set, folders: Set }`.             |
| `getAllFilePaths(nodes, basePath?)`     | `(TreeNode[], string?) => string[]`          | Convenience: all file paths.                                  |
| `getAllFolderPaths(nodes, basePath?)`   | `(TreeNode[], string?) => string[]`          | Convenience: all folder paths.                                |
| `buildFileIndex(nodes, basePath?)`      | `(TreeNode[], string?) => FilePathEntry[]`   | Build flat index with `{ relativePath, filename }`.           |

---

## Synopsis Parsing (`src/shared/synopsis.ts` - Both)

| Function / Constant           | Signature                    | Purpose                                                                                                                            |
| ----------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `NOTHING_TO_REPORT`           | `string`                     | Sentinel token AI agents return when nothing meaningful happened.                                                                  |
| `isNothingToReport(response)` | `(string) => boolean`        | Check if response contains the sentinel token.                                                                                     |
| `parseSynopsis(response)`     | `(string) => ParsedSynopsis` | Parse AI synopsis into `{ shortSummary, fullSynopsis, nothingToReport }`. Filters template placeholders and conversational filler. |

---

## History Utilities (`src/shared/history.ts` - Both)

| Function / Constant                  | Signature                                            | Purpose                                                      |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------ |
| `HISTORY_VERSION`                    | `number` (1)                                         | Current history file format version.                         |
| `MAX_ENTRIES_PER_SESSION`            | `number` (5000)                                      | Max history entries per session file.                        |
| `ORPHANED_SESSION_ID`                | `string` (`'_orphaned'`)                             | Session ID for entries without associated sessions.          |
| `sanitizeSessionId(sessionId)`       | `(string) => string`                                 | Replace non-safe chars with underscore for filesystem.       |
| `paginateEntries(entries, options?)` | `<T>(T[], PaginationOptions?) => PaginatedResult<T>` | Apply limit/offset pagination. Default: limit 100, offset 0. |
| `sortEntriesByTimestamp(entries)`    | `(HistoryEntry[]) => HistoryEntry[]`                 | Immutable sort by descending timestamp.                      |

---

## Logging

### Main Process Logger (`src/main/utils/logger.ts`)

Singleton `logger` instance (class `Logger extends EventEmitter`):

| Method                    | Signature                                            | Purpose                                                                                   |
| ------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `debug/info/warn/error`   | `(message, context?, data?) => void`                 | Standard log levels. Filtered by `minLevel`.                                              |
| `toast`                   | `(message, context?, data?) => void`                 | User-facing notification logs. Always logged.                                             |
| `autorun`                 | `(message, context?, data?) => void`                 | Auto Run workflow tracking. Always logged.                                                |
| `getLogs(filter?)`        | `({ level?, context?, limit? }) => SystemLogEntry[]` | Retrieve buffered logs with optional filtering.                                           |
| `setLogLevel/getLogLevel` | Level control                                        | Default: `'info'`.                                                                        |
| `enableFileLogging()`     | `() => void`                                         | Write to disk. Auto-enabled on Windows. Path: `%APPDATA%/Maestro/logs/maestro-debug.log`. |

### Renderer Logger (`src/renderer/utils/logger.ts`)

Singleton `logger` instance (class `RendererLogger`):

| Method                  | Signature                            | Purpose                                                    |
| ----------------------- | ------------------------------------ | ---------------------------------------------------------- |
| `debug/info/warn/error` | `(message, context?, data?) => void` | Proxies to main process via `window.maestro.logger.log()`. |

### Logger Types (`src/shared/logger-types.ts`)

| Type / Constant                   | Purpose                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| `BaseLogLevel`                    | `'debug' \| 'info' \| 'warn' \| 'error'`                    |
| `MainLogLevel`                    | Extends BaseLogLevel with `'toast' \| 'autorun'`            |
| `LOG_LEVEL_PRIORITY`              | Numeric priority mapping for filtering.                     |
| `DEFAULT_MAX_LOGS`                | 1000 entries in memory buffer.                              |
| `SystemLogEntry`                  | Interface: `{ timestamp, level, message, context?, data? }` |
| `shouldLogLevel(level, minLevel)` | Filter function based on priorities.                        |

---

## Performance Metrics (`src/shared/performance-metrics.ts` - Both)

| Export                       | Signature                                | Purpose                                                                                                      |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PerformanceMetrics` (class) | Constructor: `(context, log?, enabled?)` | Timing collector with `start()/end()`, `mark()/measure()`, `timeAsync()`, `timeSync()`. Disabled by default. |
| `createNoOpMetrics()`        | `() => PerformanceMetrics`               | No-op instance for testing.                                                                                  |
| `formatDuration(durationMs)` | `(number) => string`                     | `"123.45ms"` or `"1.23s"`.                                                                                   |
| `PERFORMANCE_THRESHOLDS`     | Object                                   | Named thresholds: DASHBOARD_LOAD (200ms), SQL_QUERY (50ms), etc.                                             |

Renderer performance integration in `src/renderer/utils/logger.ts`:

- `getRendererPerfMetrics(context)` - Get/create per-component metrics instance
- `setRendererPerfEnabled(enabled)` - Enable/disable all renderer metrics
- `getAllRendererPerfMetrics()` - Collect metrics from all renderer components

---

## Shell & SSH Utilities (Main Process)

### Shell Escape (`src/main/utils/shell-escape.ts`)

| Function                           | Signature                      | Purpose                                                        |
| ---------------------------------- | ------------------------------ | -------------------------------------------------------------- |
| `shellEscape(str)`                 | `(string) => string`           | Single-quote escape for POSIX shells.                          |
| `shellEscapeArgs(args)`            | `(string[]) => string[]`       | Escape array of arguments.                                     |
| `buildShellCommand(command, args)` | `(string, string[]) => string` | Build properly escaped shell command string.                   |
| `shellEscapeForDoubleQuotes(str)`  | `(string) => string`           | Escape `$`, backtick, `\`, `"`, `!` for double-quoted context. |

### Shell Detection (`src/main/utils/shellDetector.ts`)

| Function                   | Signature                    | Purpose                                                                                          |
| -------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `detectShells()`           | `() => Promise<ShellInfo[]>` | Detect available shells. Platform-aware (PowerShell/cmd/bash on Windows; zsh/bash/fish on Unix). |
| `getShellCommand(shellId)` | `(string) => string`         | Map shell ID to executable name.                                                                 |

### SSH Spawn Wrapper (`src/main/utils/ssh-spawn-wrapper.ts`)

| Function                                        | Signature                                                                                            | Purpose                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrapSpawnWithSsh(config, sshConfig, sshStore)` | `(SshSpawnWrapConfig, AgentSshRemoteConfig?, SshRemoteSettingsStore) => Promise<SshSpawnWrapResult>` | Wrap spawn config with SSH remote execution. Handles prompt embedding (small in CLI, large via stdin). Returns local or SSH-wrapped config. |

---

## Process Execution (Main Process)

### execFile (`src/main/utils/execFile.ts`)

| Function                                          | Signature                                                                              | Purpose                                                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execFileNoThrow(command, args?, cwd?, options?)` | `(string, string[], string?, ExecOptions \| NodeJS.ProcessEnv) => Promise<ExecResult>` | Safe command execution. No shell injection. Returns `{ stdout, stderr, exitCode }` - never throws. Handles Windows batch files, stdin input, and timeouts. |
| `needsWindowsShell(command)`                      | `(string) => boolean`                                                                  | Determine if command needs `shell: true` on Windows. `.cmd`/`.bat` need shell; known `.exe` commands (git, node, etc.) do not.                             |

### Safe IPC Send (`src/main/utils/safe-send.ts`)

| Function                        | Signature                       | Purpose                                                                                      |
| ------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| `createSafeSend(getMainWindow)` | `(GetMainWindow) => SafeSendFn` | Factory for safe IPC message sender. Handles disposed renderer, GPU crashes, window closing. |
| `isWebContentsAvailable(win)`   | `(BrowserWindow?) => boolean`   | Type guard to check if webContents is available.                                             |

---

## IPC Handler Utilities (`src/main/utils/ipcHandler.ts` - Main)

| Function                                 | Signature                                                                                      | Purpose                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `createHandler(options, handler)`        | Wraps handler with try-catch, returns `{ success, ...result }` or `{ success: false, error }`. | For direct use, not ipcMain.handle.            |
| `createDataHandler(options, handler)`    | Same, returns `{ success, data }` format.                                                      | Standard data response.                        |
| `withErrorLogging(options, handler)`     | Wraps with error logging, re-throws on error.                                                  | Transparent error logging.                     |
| `withIpcErrorLogging(options, handler)`  | Same but strips the `_event` arg for ipcMain.handle compatibility.                             | Most common for IPC handlers.                  |
| `createIpcHandler(options, handler)`     | Like `createHandler` but strips `_event` arg.                                                  | For ipcMain.handle with custom response shape. |
| `createIpcDataHandler(options, handler)` | Like `createDataHandler` but strips `_event` arg.                                              | For ipcMain.handle with `{ success, data }`.   |
| `requireProcessManager(getter)`          | `(() => PM \| null) => PM`                                                                     | Throws if ProcessManager not initialized.      |
| `requireDependency(getter, name)`        | `<T>(() => T \| null, string) => T`                                                            | Generic require for nullable dependencies.     |

---

## Network & CLI Detection (Main Process)

### Network (`src/main/utils/networkUtils.ts`)

| Function                  | Signature               | Purpose                                                                    |
| ------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| `getLocalIpAddress()`     | `() => Promise<string>` | Detect local IP via UDP socket to 8.8.8.8, fallback to interface scanning. |
| `getLocalIpAddressSync()` | `() => string`          | Sync version using interface scanning only.                                |

### CLI Detection (`src/main/utils/cliDetection.ts`)

| Function                     | Signature                       | Purpose                                                      |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------ |
| `isCloudflaredInstalled()`   | `() => Promise<boolean>`        | Cached detection of cloudflared binary.                      |
| `isGhInstalled()`            | `() => Promise<boolean>`        | Cached detection of GitHub CLI.                              |
| `resolveGhPath(customPath?)` | `(string?) => Promise<string>`  | Get gh path with auto-detection and custom override.         |
| `detectSshPath()`            | `() => Promise<string \| null>` | Cached detection of ssh binary. Windows fallback to OpenSSH. |
| `resolveSshPath()`           | `() => Promise<string>`         | Get ssh path with fallback to `'ssh'`.                       |

---

## Pricing (`src/main/utils/pricing.ts` - Main)

| Function                          | Signature                                 | Purpose                                                           |
| --------------------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `calculateCost(tokens, pricing?)` | `(TokenCounts, PricingConfig?) => number` | Calculate USD cost from token counts. Defaults to CLAUDE_PRICING. |
| `calculateClaudeCost(...)`        | Individual params version                 | Deprecated. Use `calculateCost()`.                                |

---

## Stats Cache (`src/main/utils/statsCache.ts` - Main)

| Function                             | Signature                                        | Purpose                                    |
| ------------------------------------ | ------------------------------------------------ | ------------------------------------------ |
| `getStatsCachePath(projectPath)`     | `(string) => string`                             | Per-project stats cache file path.         |
| `loadStatsCache(projectPath)`        | `(string) => Promise<SessionStatsCache \| null>` | Load with version validation.              |
| `saveStatsCache(projectPath, cache)` | `(string, SessionStatsCache) => Promise<void>`   | Save with directory creation.              |
| `getGlobalStatsCachePath()`          | `() => string`                                   | Global stats cache file path.              |
| `loadGlobalStatsCache()`             | `() => Promise<GlobalStatsCache \| null>`        | Load global cache with version validation. |
| `saveGlobalStatsCache(cache)`        | `(GlobalStatsCache) => Promise<void>`            | Save global cache.                         |

---

## Renderer-Only Utilities

### Token Counter (`src/renderer/utils/tokenCounter.ts`)

| Function                  | Signature                     | Purpose                                                            |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `countTokens(text)`       | `(string) => Promise<number>` | Accurate count using tiktoken cl100k_base. Falls back to estimate. |
| `estimateTokens(text)`    | `(string) => number`          | Sync heuristic: ~4 chars/token.                                    |
| `formatTokenCount(count)` | `(number) => string`          | `"1.2k"`, `"15k"`, `"1.5M"`.                                       |

### Shortcut Formatter (`src/renderer/utils/shortcutFormatter.ts`)

| Function                               | Signature                       | Purpose                                                                              |
| -------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| `formatKey(key)`                       | `(string) => string`            | Platform-aware key symbol (Mac: `"Meta"` -> `"command"`, Win: `"Meta"` -> `"Ctrl"`). |
| `formatShortcutKeys(keys, separator?)` | `(string[], string?) => string` | Format key array: Mac `"command shift K"`, Win `"Ctrl+Shift+K"`.                     |
| `formatMetaKey()`                      | `() => string`                  | `"command"` on Mac, `"Ctrl"` on Win/Linux.                                           |
| `formatEnterToSend(enterToSend)`       | `(boolean) => string`           | `"Enter"` or `"command + Enter"` / `"Ctrl + Enter"`.                                 |

### Context Usage (`src/renderer/utils/contextUsage.ts`)

| Function                                                                                | Signature                                       | Purpose                                                                              |
| --------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `calculateContextTokens(stats, agentId?)`                                               | `(UsageStats, string?) => number`               | Agent-specific context token calculation. Claude: input+cache. OpenAI: input+output. |
| `estimateContextUsage(stats, agentId?)`                                                 | `(UsageStats, string?) => number \| null`       | Estimate context usage %. Returns null for accumulated multi-tool turns.             |
| `calculateContextDisplay(usageStats, contextWindow, agentId?, fallbackPercentage?)`     | Returns `{ tokens, percentage, contextWindow }` | Single source of truth for context gauge rendering.                                  |
| `estimateAccumulatedGrowth(currentUsage, outputTokens, cacheReadTokens, contextWindow)` | `(number, number, number, number) => number`    | Conservative growth estimate during tool-heavy turns. Bounded to 1-3% per turn.      |

### Session Helpers (`src/renderer/utils/sessionHelpers.ts`)

| Function                                  | Signature                                                                        | Purpose                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `buildSpawnConfigForAgent(options)`       | `(BuildSpawnConfigOptions) => Promise<ProcessConfig \| null>`                    | Build spawn config for an agent. Fetches agent config from main process.                |
| `createSessionForAgent(options)`          | `(CreateSessionForAgentOptions) => Promise<CreateSessionForAgentResult \| null>` | Create session structure + spawn config for agent initialization.                       |
| `agentSupportsContextTransfer(agentType)` | `(ToolType) => Promise<boolean>`                                                 | Check if agent supports receiving merged context.                                       |
| `getSessionSshRemoteId(session)`          | `(SessionSshInfo?) => string \| undefined`                                       | Get effective SSH remote ID. Handles the sshRemoteId vs sessionSshRemoteConfig pitfall. |
| `isSessionRemote(session)`                | `(SessionSshInfo?) => boolean`                                                   | Check if session is SSH remote. Works for both AI and terminal-only sessions.           |

### Sentry (`src/renderer/utils/sentry.ts`)

| Function                                   | Signature                                 | Purpose                                 |
| ------------------------------------------ | ----------------------------------------- | --------------------------------------- |
| `captureException(error, captureContext?)` | `(Error \| unknown, { extra? }?) => void` | Report error to Sentry from renderer.   |
| `captureMessage(message, captureContext?)` | `(string, { level?, extra? }?) => void`   | Report message to Sentry from renderer. |

---

## Themes

### Types (`src/shared/theme-types.ts` - Both)

| Type                 | Purpose                                                                               |
| -------------------- | ------------------------------------------------------------------------------------- |
| `ThemeId`            | Union of 17 theme identifiers (dracula, monokai, nord, etc. + custom).                |
| `ThemeMode`          | `'light' \| 'dark' \| 'vibe'`                                                         |
| `ThemeColors`        | 13-property color palette (bgMain, bgSidebar, accent, success, warning, error, etc.). |
| `Theme`              | Complete theme: `{ id, name, mode, colors }`.                                         |
| `isValidThemeId(id)` | Type guard for ThemeId validation.                                                    |

### Definitions (`src/shared/themes.ts` - Both)

| Export                        | Purpose                                              |
| ----------------------------- | ---------------------------------------------------- |
| `THEMES`                      | `Record<ThemeId, Theme>` - All 17 theme definitions. |
| `DEFAULT_CUSTOM_THEME_COLORS` | Dracula colors as default for custom theme.          |
| `getThemeById(themeId)`       | Look up a theme, returns null if not found.          |
