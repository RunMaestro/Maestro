# CLAUDE-PLATFORM.md

Cross-platform and multi-environment considerations for the Maestro codebase. For the main guide, see [[CLAUDE.md]].

---

## Platform Compatibility Matrix

| Feature | macOS | Windows | Linux | SSH Remote |
|---------|-------|---------|-------|------------|
| Claude Code | Full | Full | Full | Full |
| OpenAI Codex | Full | Full | Full | Full |
| OpenCode | Full | Full | Full | Full |
| Factory Droid | Full | Full | Full | Full |
| File watching (chokidar) | Yes | Yes | Yes | **No** |
| Git worktrees | Yes | Yes | Yes | Yes |
| PTY terminal | Yes | Yes | Yes | N/A |

---

## Critical Platform Gotchas

### 1. Path Handling

**Path separators differ:**
```typescript
// WRONG - hardcoded separator
const fullPath = folder + '/' + filename;

// CORRECT - use path.join or path.posix for SSH
import * as path from 'path';
const fullPath = path.join(folder, filename);           // Local
const remotePath = path.posix.join(folder, filename);   // SSH remote
```

**Path delimiters differ:**
```typescript
// Windows uses ';', Unix uses ':'
const delimiter = path.delimiter;  // Use this, don't hardcode
```

**Tilde expansion:**
```typescript
// Node.js fs does NOT expand ~ automatically
import { expandTilde } from '../shared/pathUtils';
const expanded = expandTilde('~/.config/file');  // Always use this
```

**Minimum path lengths:**
```typescript
// Validation must account for platform differences
const minPathLength = process.platform === 'win32' ? 4 : 5;  // C:\a vs /a/b
```

**Windows reserved names:**
```typescript
// CON, PRN, AUX, NUL, COM1-9, LPT1-9 are invalid on Windows
const reservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
```

### 2. Shell Detection & Execution

**Default shells differ:**
```typescript
// Windows: $SHELL doesn't exist; default to PowerShell
const defaultShell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
```

**Command lookup differs:**
```typescript
// 'which' on Unix, 'where' on Windows
const command = process.platform === 'win32' ? 'where' : 'which';
```

**Executable permissions:**
```typescript
// Unix requires X_OK check; Windows does not
if (process.platform !== 'win32') {
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

// CORRECT - works for all SSH agents
const sshId = session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId;
```

**File watching not available for SSH:**
```typescript
// chokidar can't watch remote directories
if (sshRemoteId) {
    // Use polling instead of file watching
}
```

**Prompts must go via stdin for SSH:**
```typescript
// IMPORTANT: ALL agent prompts are passed via stdin passthrough for SSH.
// This avoids shell escaping issues and command line length limits.
if (isSSH) {
    // Pass prompt via stdin, not as command line argument
}
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
// OpenCode:
//   - macOS/Linux: ~/.config/opencode/storage/
//   - Windows: %APPDATA%/opencode/storage/
```

**Resume flags differ:**
```typescript
// Claude Code: --resume <session-id>
// Codex: resume <thread_id> (subcommand, not flag)
// OpenCode: --session <session-id>
```

**Read-only mode flags differ:**
```typescript
// Claude Code: --permission-mode plan
// Codex: --sandbox read-only
// OpenCode: --agent plan
```

### 5. Keyboard & Input

**macOS Alt key produces special characters:**
```typescript
// Alt+L = '¬', Alt+P = 'π', Alt+U = 'ü'
// Must use e.code for Alt key combos, not e.key
if (e.altKey && process.platform === 'darwin') {
    const key = e.code.replace('Key', '').toLowerCase();  // 'KeyL' -> 'l'
}
```

**Windows command line length limit:**
```typescript
// cmd.exe has ~8KB command line limit
// Use sendPromptViaStdin to bypass this for long prompts
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

---

## Key Files for Platform Logic

| Concern | Primary Files |
|---------|---------------|
| Path utilities | `src/shared/pathUtils.ts` |
| Shell detection | `src/main/utils/shellDetector.ts` |
| WSL detection | `src/main/utils/wslDetector.ts` |
| CLI detection | `src/main/utils/cliDetection.ts` |
| SSH spawn wrapper | `src/main/utils/ssh-spawn-wrapper.ts` |
| SSH command builder | `src/main/utils/ssh-command-builder.ts` |
| Agent path probing | `src/main/agents/path-prober.ts` |
| Windows diagnostics | `src/main/debug-package/collectors/windows-diagnostics.ts` |
| Safe exec | `src/main/utils/execFile.ts` |
