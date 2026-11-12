# CLAUDE-PLATFORM.md

Cross-platform and multi-environment considerations for the Maestro codebase. For the main guide, see [[CLAUDE.md]].

---

## Platform Compatibility Matrix

| Feature                  | macOS | Windows | Linux | SSH Remote |
| ------------------------ | ----- | ------- | ----- | ---------- |
| Claude Code              | Full  | Full    | Full  | Full       |
| OpenAI Codex             | Full  | Full    | Full  | Full       |
| OpenCode                 | Full  | Full    | Full  | Full       |
| Factory Droid            | Full  | Full    | Full  | Full       |
| File watching (chokidar) | Yes   | Yes     | Yes   | **No**     |
| Git worktrees            | Yes   | Yes     | Yes   | Yes        |
| PTY terminal             | Yes   | Yes     | Yes   | N/A        |

The matrix shows the four longest-supported providers; there are 13 agent ids in `AGENT_IDS` (`src/shared/agentIds.ts`), and every provider's spawn, resume, and read-only flags live in `src/main/agents/definitions.ts`.

---

## Critical Platform Gotchas

### 1. Path Handling

**Path separators differ:**

```typescript
// WRONG - hardcoded separator
const fullPath = folder + '/' + filename;

// CORRECT - use path.join or path.posix for SSH
import * as path from 'path';
const fullPath = path.join(folder, filename); // Local
const remotePath = path.posix.join(folder, filename); // SSH remote
```

**Path delimiters differ:**

```typescript
// Windows uses ';', Unix uses ':'
const delimiter = path.delimiter; // Use this, don't hardcode
```

**Tilde expansion:**

```typescript
// Node.js fs does NOT expand ~ automatically
import { expandTilde } from '../shared/pathUtils';
const expanded = expandTilde('~/.config/file'); // Always use this
```

**Platform checks go through the helpers, never raw `process.platform`:**

```typescript
// Main process, CLI, and shared code:
import { isWindows, isMacOS, isLinux, getWhichCommand } from '../shared/platformDetection';
// Renderer only (process.platform there is the shim sentinel 'browser'):
import {
	isWindowsPlatform,
	isMacOSPlatform,
	isLinuxPlatform,
} from '../renderer/utils/platformUtils';
```

**Minimum path lengths and Windows reserved names** (`isValidSyncPath()` in `src/shared/syncPath.ts`):

```typescript
const minPathLength = isWindows() ? 4 : 5; // C:\a vs /a/b
// CON, PRN, AUX, NUL, COM1-9, LPT1-9 are invalid on Windows; checked per path segment
const reservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Plugin KV ids use a stricter variant that also rejects `CON.txt` (src/main/plugins/plugin-kv-store.ts)
```

### 2. Shell Detection & Execution

**Default shells differ** (`src/main/utils/shellDetector.ts`):

```typescript
// Windows: $SHELL doesn't exist. Candidates: powershell, pwsh, cmd, bash (Git Bash), wsl.
// Unix: zsh, bash, sh, fish, tcsh. Terminal-tab PTYs spawn whichever the user picked in Settings.
const defaultShell = isWindows() ? 'powershell.exe' : 'bash';
```

**Command lookup differs:**

```typescript
// 'which' on Unix, 'where' on Windows
const command = getWhichCommand();
```

**Executable permissions:**

```typescript
// Unix requires X_OK check; Windows does not
if (!isWindows()) {
	await fs.promises.access(filePath, fs.constants.X_OK);
}
```

**Windows shell execution:**

```typescript
// Some Windows commands need shell: true
const useShell = isWindows && needsWindowsShell(command);
```

### 3. SSH Remote Execution

**Two SSH identifiers with different lifecycles:**

```typescript
// sshRemoteId: Set AFTER AI agent spawns (via onSshRemote callback)
// sessionSshRemoteConfig.remoteId: Set BEFORE spawn (user configuration)

// WRONG - fails for terminal-only SSH agents
const sshId = session.sshRemoteId;

// CORRECT - the helpers fold both together (src/renderer/utils/sessionHelpers.ts)
import { getSessionSshRemoteId, isSessionRemote } from '../utils/sessionHelpers';
const sshId = getSessionSshRemoteId(session);
if (isSessionRemote(session)) {
	/* remote-only path */
}
```

**Stopping a remote agent** (`src/main/utils/ssh-remote-signal.ts`): with `RequestTTY=no` a signal to the local `ssh` client never reaches the remote process, so the launch script records the agent's pid (plus start time) in a pid file before it `exec`s, and Stop runs a one-shot `ssh` with the same connection args to signal that process group.

**File watching not available for SSH:**

```typescript
// chokidar can't watch remote directories
if (sshRemoteId) {
	// Use polling instead of file watching
}
```

**Prompts go via stdin for SSH (with one size rule):**

```typescript
// The main spawn path (src/main/ipc/handlers/process/wrap-spawn-for-ssh.ts)
// sends the whole launch script AND the prompt through stdin to /bin/bash on
// the remote, which sidesteps shell escaping and command-line length limits.
// wrapSpawnWithSsh() (src/main/utils/ssh-spawn-wrapper.ts), used by Cue, group
// chat, the context groomer, the usage sampler and the CLI, embeds a prompt of
// 4000 chars or fewer on the command line and switches to the stdin script
// only above that. Keep that threshold in mind when a remote prompt is
// visible in `ps` output or hits a remote shell's argument limit.
```

**Path resolution on remote:**

```typescript
// Don't resolve paths locally when operating on remote
// The remote may have different filesystem structure
if (isRemote) {
	// Use path as-is, normalize slashes only
}
```

### 4. Agent-Specific Differences

**Provider session ID terminology:**

```typescript
// Claude Code: session_id
// Codex: thread_id
// Different field names, same concept
```

**Storage locations differ per platform:**

```typescript
// Claude Code: ~/.claude/projects/<encoded-path>/
// Codex: ~/.codex/sessions/YYYY/MM/DD/*.jsonl
// OpenCode (XDG on EVERY platform, src/main/storage/opencode-session-storage.ts):
//   - v1.2+: SQLite at $XDG_DATA_HOME/opencode/opencode.db, default ~/.local/share/opencode/opencode.db
//   - older: JSON under ~/.local/share/opencode/storage/
//   - Windows: same ~/.local/share path; %APPDATA%\opencode is only a legacy fallback
```

**Resume flags differ:**

```typescript
// Claude Code: --resume <session-id>
// Codex: resume <thread_id> (subcommand, not flag)
// OpenCode: --session <session-id>
// Every other provider: see its entry in src/main/agents/definitions.ts
```

**Read-only mode flags differ:**

```typescript
// Claude Code: --permission-mode plan
// Codex: --sandbox read-only (batch mode also adds --skip-git-repo-check)
// OpenCode: --agent plan
```

### 5. Keyboard & Input

**macOS Alt key produces special characters:**

```typescript
// Alt+L = '¬', Alt+P = 'π', Alt+U = 'ü'
// Must use e.code for Alt key combos, not e.key. Never read process.platform in
// the renderer: the shim (src/renderer/public/process-shim.js) reports 'browser'.
// useMainKeyboardHandler.ts does it this way:
import { isMacOSPlatform } from '../utils/platformUtils';
if (e.altKey && isMacOSPlatform()) {
	const key = e.code.replace('Key', '').toLowerCase(); // 'KeyL' -> 'l'
}
```

**Windows command line length limit:**

```typescript
// cmd.exe has ~8KB command line limit
// handleProcessSpawn sets sendPromptViaStdin/Raw to bypass this for long prompts.
// It is decided in MAIN, from isWindows() and the agent's supportsPromptViaStdin
// capability - never by a renderer. A web-desktop client is a browser that may
// run on a different OS than the host, and a CLI that takes the prompt only as a
// positional argument (omp) would start with no prompt at all.
```

### 6. Git Operations

**Git stat format differs:**

```typescript
// GNU stat vs BSD stat have different format specifiers
// Use git commands that work cross-platform
```

**Case sensitivity:**

```typescript
// macOS with case-insensitive filesystem:
// Renaming "readme.md" to "README.md" may not trigger expected events
```

---

## Testing Checklist

When making changes that involve any of the above areas, verify:

- [ ] Works on macOS (primary development platform)
- [ ] Works on Windows (PowerShell default, path separators)
- [ ] Works on Linux (standard Unix behavior)
- [ ] Works with SSH remote agents (no file watching, stdin passthrough)
- [ ] Path handling uses `path.join` or `path.posix` as appropriate
- [ ] No hardcoded path separators (`/` or `\`)
- [ ] Shell commands use platform-appropriate lookup (`which`/`where`)
- [ ] Agent-specific code handles all supported agents, not just Claude
- [ ] Path assertions in tests use the `path`/`os` API (`path.isAbsolute`, `path.join`, `path.resolve`, `os.homedir`, `os.tmpdir`), never literal `/`, `\`, or `process.env.HOME`
- [ ] Both CI matrix legs (`test (ubuntu-latest)` and `test (windows-latest)`) are green before merge; a local single-OS run is not sufficient

---

## Key Files for Platform Logic

| Concern                     | Primary Files                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| Platform detection (main)   | `src/shared/platformDetection.ts`                                                            |
| Platform detection (render) | `src/renderer/utils/platformUtils.ts`, shim in `src/renderer/public/process-shim.js`         |
| Path utilities              | `src/shared/pathUtils.ts`                                                                    |
| Shell escaping              | `src/main/utils/shell-escape.ts`                                                             |
| Shell detection             | `src/main/utils/shellDetector.ts`                                                            |
| WSL detection               | `src/main/utils/wslDetector.ts`                                                              |
| CLI detection               | `src/main/utils/cliDetection.ts`                                                             |
| SSH spawn wrapper           | `src/main/utils/ssh-spawn-wrapper.ts`, `src/main/ipc/handlers/process/wrap-spawn-for-ssh.ts` |
| SSH command builder         | `src/main/utils/ssh-command-builder.ts`                                                      |
| SSH remote resolution       | `src/main/utils/ssh-remote-resolver.ts`, `src/main/utils/ssh-config-parser.ts`               |
| SSH remote stop/kill        | `src/main/utils/ssh-remote-signal.ts`                                                        |
| Agent path probing          | `src/main/agents/path-prober.ts`                                                             |
| Provider session storage    | `src/main/storage/codex-session-storage.ts`, `src/main/storage/opencode-session-storage.ts`  |
| Windows diagnostics         | `src/main/debug-package/collectors/windows-diagnostics.ts`                                   |
| Safe exec                   | `src/main/utils/execFile.ts`                                                                 |
