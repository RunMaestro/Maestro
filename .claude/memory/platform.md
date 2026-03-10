# Cross-Platform & SSH

## Path Handling

- Use `path.join()` for local, `path.posix.join()` for SSH remote
- Windows uses `;` delimiter, Unix uses `:` — use `path.delimiter`
- Node.js does NOT expand `~` — use `expandTilde()` from `src/shared/pathUtils.ts`
- Min path length: Windows 4 (`C:\a`), Unix 5 (`/a/b`)
- Windows reserved names: CON, PRN, AUX, NUL, COM1-9, LPT1-9

## Shell Detection

- Windows: `$SHELL` doesn't exist, default to `powershell.exe`
- CLI lookup: `which` (Unix) vs `where` (Windows)
- Executable perms: skip `X_OK` check on Windows

## SSH Remote Execution (CRITICAL)

**Two SSH identifiers with different lifecycles:**
```typescript
// sshRemoteId: Set AFTER AI agent spawns
// sessionSshRemoteConfig.remoteId: Set BEFORE spawn (user config)

// WRONG - fails for terminal-only SSH agents
const sshId = session.sshRemoteId;
// CORRECT
const sshId = session.sshRemoteId || session.sessionSshRemoteConfig?.remoteId;

// WRONG
const isRemote = !!session.sshRemoteId;
// CORRECT
const isRemote = !!session.sshRemoteId || !!session.sessionSshRemoteConfig?.enabled;
```

- File watching (chokidar) NOT available for SSH — use polling
- Prompts go via stdin for SSH (avoids shell escaping + length limits)
- Don't resolve paths locally when operating on remote

## Keyboard & Input

- macOS Alt key produces special chars (¬, π, ü) — use `e.code` not `e.key` for Alt combos
- Windows cmd.exe has ~8KB command line limit — use stdin passthrough for long prompts

## Agent Storage Locations

- Claude: `~/.claude/projects/<encoded-path>/`
- Codex: `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
- OpenCode: `~/.config/opencode/storage/` (macOS/Linux), `%APPDATA%/opencode/storage/` (Windows)

## Key Files

| Concern | File |
|---------|------|
| Path utils | `src/shared/pathUtils.ts` |
| Shell detection | `src/main/utils/shellDetector.ts` |
| WSL detection | `src/main/utils/wslDetector.ts` |
| SSH spawn wrapper | `src/main/utils/ssh-spawn-wrapper.ts` |
| SSH command builder | `src/main/utils/ssh-command-builder.ts` |
| Safe exec | `src/main/utils/execFile.ts` |
