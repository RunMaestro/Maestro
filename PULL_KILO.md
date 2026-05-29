# feat: Add Kilo agent support

## Summary

Add [Kilo](https://github.com/Kilo-Org/kilocode) as a new agent in Maestro. Kilo is a 1:1 fork of OpenCode with identical CLI interface and JSON output format, differing only in binary name (`kilo` vs `opencode`), data directory, and branding. The integration reuses OpenCode's parser and session storage via subclassing, keeps the wizard and new-agent UI in sync, and includes a follow-up stderr normalization fix so Kilo's compatibility warning does not render as a false error.

## Motivation

Kilo is a actively maintained fork of OpenCode that adds:

- Kilo-specific provider integrations (Kilo API gateway)
- VS Code and JetBrains IDE extensions
- Additional CLI flags (`--auto`, `--variant`, `--thinking`)
- Its own authentication and billing system

Users who have adopted Kilo as their primary coding agent can now use it directly in Maestro without switching back to OpenCode.

## Changes

### New Files (2)

| File                                       | Lines | Purpose                                                                                                                         |
| ------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/parsers/kilo-output-parser.ts`   | 6     | Thin subclass of `OpenCodeOutputParser` with `agentId = 'kilo'`                                                                 |
| `src/main/storage/kilo-session-storage.ts` | 43    | Subclass of `OpenCodeSessionStorage` overriding data dir (`~/.local/share/kilo/`), DB path (`kilo.db`), and remote storage path |

### Modified Files (21)

#### Core Registration

| File                                   | Change                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/shared/agentIds.ts`               | Added `'kilo'` to `AGENT_IDS` array — the single source of truth for the `ToolType` union              |
| `src/shared/agentMetadata.ts`          | Added `'Kilo'` display name, added to `PLAN_MODE_AGENTS` (uses `--agent plan`), added to `BETA_AGENTS` |
| `src/shared/agentConstants.ts`         | Added `kilo: 128000` default context window                                                            |
| `src/shared/templateVariables.ts`      | Updated `{{TOOL_TYPE}}` doc comment to include `kilo`                                                  |
| `src/shared/pathUtils.ts`              | Added `~/.kilo/bin` (Unix) and `scoop/apps/kilo` (Windows) to expanded PATH                            |
| `src/renderer/constants/agentIcons.ts` | Added `kilo: '⚡'` icon                                                                                |

#### Agent Definition & Capabilities

| File                              | Change                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/agents/definitions.ts`  | Full agent definition: `run` subcommand, `--format json`, `--session`, `--model`, `--agent plan`, `KILO_CONFIG_CONTENT` env var for YOLO mode |
| `src/main/agents/capabilities.ts` | Complete capability set mirroring OpenCode (resume, read-only, JSON output, session storage, cost tracking, model selection, streaming, etc.) |
| `src/main/agents/detector.ts`     | Added `kilo models` command for runtime model discovery                                                                                       |

#### Parsers & Error Handling

| File                                 | Change                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `src/main/parsers/index.ts`          | Registered and exported `KiloOutputParser`                                                      |
| `src/main/parsers/error-patterns.ts` | Added `kilo` to binary-not-found regex pattern, registered `OPENCODE_ERROR_PATTERNS` for `kilo` |

#### Storage

| File                                           | Change                                                                                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/storage/index.ts`                    | Registered and exported `KiloSessionStorage`                                                                                                                                                        |
| `src/main/storage/opencode-session-storage.ts` | Refactored `getDataDir()`, `getStorageDir()`, `getDbPath()`, `getRemoteStorageDir()` from module-level functions to `protected` methods on the class, enabling KiloSessionStorage to override paths |

#### Process & SSH

| File                                                 | Change                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `src/main/process-manager/handlers/StdoutHandler.ts` | Extended init event `resultEmitted` reset to include `'kilo'` (same streaming behavior as OpenCode)                       |
| `src/main/process-manager/handlers/StderrHandler.ts` | Filters Kilo's non-fatal client/server compatibility warning and re-emits any remaining assistant text as normal output   |
| `src/main/utils/ssh-command-builder.ts`              | Added `$HOME/.kilo/bin` to `BASE_SSH_PATH_DIRS` for remote execution                                                      |
| `src/main/agents/path-prober.ts`                     | Added `kilo` binary detection paths for Windows (scoop, volta, npm, go) and Unix (local, homebrew, npm, version managers) |

#### CLI Spawner

| File                                | Change                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/cli/services/agent-spawner.ts` | Added `detectKilo()`, `getKiloCommand()` wrappers, imported `KiloOutputParser`, added `'kilo'` case in `createParser()` |

#### Renderer Services

| File                                                             | Change                                                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/renderer/services/contextGroomer.ts`                        | Added `kilo` entry to `AGENT_ARTIFACTS` (slash commands, brand references) and `AGENT_TARGET_NOTES` |
| `src/renderer/services/inlineWizardDocumentGeneration.ts`        | Added `'kilo'` to all `opencode` equality checks and switch cases                                   |
| `src/renderer/services/inlineWizardConversation.ts`              | Added `'kilo'` to all `opencode` equality checks and switch cases                                   |
| `src/renderer/components/Wizard/services/conversationManager.ts` | Added `'kilo'` to all `opencode` equality checks and switch cases                                   |

## Design Decisions

### Why subclass instead of copy?

Kilo's CLI and JSON output are byte-for-byte compatible with OpenCode. Rather than duplicating ~500 lines of parser code and ~1700 lines of session storage code, the integration uses inheritance:

```
OpenCodeOutputParser          OpenCodeSessionStorage
  └── KiloOutputParser (6L)     └── KiloSessionStorage (43L)
```

This means any future bug fixes to the OpenCode parser automatically apply to Kilo. The tradeoff is tight coupling — if Kilo's output format diverges from OpenCode in the future, `KiloOutputParser` can be promoted to a full standalone implementation at that point.

### Why `KILO_CONFIG_CONTENT` instead of `OPENCODE_CONFIG_CONTENT`?

Kilo reads its own config env var. The YOLO mode permissions JSON is identical in structure but must use the correct env var name for the binary to pick it up.

### Why mark as Beta?

Kilo integration has not been through end-to-end testing with all Maestro features (SSH remote, Auto Run, Group Chat wizard, session import/export). Marking as Beta sets appropriate expectations while the integration matures.

### Why normalize Kilo stderr?

The Kilo wrapper currently emits a non-fatal compatibility warning on stderr before the assistant response. Without normalization, Maestro would show the warning in a red stderr block and risk hiding the actual reply. The handler now strips that warning and preserves the remaining assistant text as normal output.

## Kilo vs OpenCode Reference

| Aspect                 | OpenCode                                  | Kilo                                      |
| ---------------------- | ----------------------------------------- | ----------------------------------------- |
| Binary                 | `opencode`                                | `kilo` (alias: `kilocode`)                |
| npm package            | `opencode`                                | `@kilocode/cli`                           |
| Data dir (Linux/macOS) | `~/.local/share/opencode/`                | `~/.local/share/kilo/`                    |
| Data dir (Windows)     | `%APPDATA%\opencode`                      | `%LOCALAPPDATA%\kilo`                     |
| Database               | `opencode.db`                             | `kilo.db`                                 |
| Config env var         | `OPENCODE_CONFIG_CONTENT`                 | `KILO_CONFIG_CONTENT`                     |
| CLI `run` args         | `--format json --session --model --agent` | Identical + `--auto --variant --thinking` |
| JSON output            | `{ type, timestamp, sessionID, part }`    | Identical                                 |

## Testing

- [ ] `kilo` binary detected on PATH (or via known install paths)
- [ ] `kilo run --format json "hello"` produces parseable JSONL
- [ ] Session history loads from `~/.local/share/kilo/`
- [ ] Read-only (plan) mode works via `--agent plan`
- [ ] Model selection works via `--model provider/model`
- [ ] Auto Run batch execution completes
- [ ] SSH remote execution finds `kilo` binary
- [ ] Kilo compatibility warning is filtered from stderr and assistant text still renders
- [ ] Error messages display correctly for common failures
- [ ] Kilo appears in agent picker with ⚡ icon and "(Beta)" badge

## Related

- KiloCode repo: https://github.com/Kilo-Org/kilocode
- OpenCode repo: https://github.com/opencode-ai/opencode
- Existing OpenCode integration: `src/main/parsers/opencode-output-parser.ts`, `src/main/storage/opencode-session-storage.ts`
