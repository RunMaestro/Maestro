# SCAN-PROMPTS-CLI

Scan date: 2026-03-20
Source: `src/cli/`, `src/main/`, `src/shared/`

---

## CLI Functions Also in Main

```
comm -12 <(grep -roh "function [a-zA-Z]*" src/cli/ --include="*.ts" | sed 's/function //' | sort -u) \
         <(grep -roh "function [a-zA-Z]*" src/main/ --include="*.ts" | sed 's/function //' | sort -u)
```

7 duplicated function names:

```
calculateCost
extractTextFromContent
getConfigDir
getPlaybooksFilePath
parseSessionContent
readPlaybooks
sleep
```

---

## extractTextFromContent Copies

```
grep -rn "extractTextFromContent" src/ --include="*.ts" | grep -v __tests__
```

6 independent definitions across 5 files:

| File                                                | Line | Signature                                                                              |
| --------------------------------------------------- | ---- | -------------------------------------------------------------------------------------- |
| `src/cli/services/agent-sessions.ts`                | 142  | `function extractTextFromContent(content: unknown): string`                            |
| `src/main/ipc/handlers/claude.ts`                   | 137  | `function extractTextFromContent(content: unknown): string`                            |
| `src/main/storage/claude-session-storage.ts`        | 60   | `function extractTextFromContent(content: unknown): string`                            |
| `src/main/storage/codex-session-storage.ts`         | 124  | `function extractTextFromContent(content: CodexMessageContent[] \| undefined): string` |
| `src/main/storage/factory-droid-session-storage.ts` | 138  | `function extractTextFromContent(content: FactoryContentItem[] \| string): string`     |

**Usage counts per file:**

| File                                                | Definition | Call sites                                                                      |
| --------------------------------------------------- | ---------- | ------------------------------------------------------------------------------- |
| `src/cli/services/agent-sessions.ts`                | :142       | :175, :182                                                                      |
| `src/main/ipc/handlers/claude.ts`                   | :137       | :221, :229, :437, :445                                                          |
| `src/main/storage/claude-session-storage.ts`        | :60        | :107, :115, :767                                                                |
| `src/main/storage/codex-session-storage.ts`         | :124       | :307, :324, :338, :355, :668, :682, :695, :709, :965, :982, :1132, :1138, :1301 |
| `src/main/storage/factory-droid-session-storage.ts` | :138       | :323, :423, :505, :552, :608                                                    |

**Key finding:** The first 3 definitions (`cli/services/agent-sessions.ts`, `main/ipc/handlers/claude.ts`, `main/storage/claude-session-storage.ts`) have identical signatures and likely identical implementations. The codex and factory-droid versions are typed differently but may share extractable logic.

---

## SpecKit vs OpenSpec Diffs

```
wc -l src/main/speckit-manager.ts src/main/openspec-manager.ts \
      src/main/ipc/handlers/speckit.ts src/main/ipc/handlers/openspec.ts \
      src/renderer/components/SpecKitCommandsPanel.tsx src/renderer/components/OpenSpecCommandsPanel.tsx
```

| File                                                | Lines    |
| --------------------------------------------------- | -------- |
| `src/main/speckit-manager.ts`                       | 530      |
| `src/main/openspec-manager.ts`                      | 471      |
| `src/main/ipc/handlers/speckit.ts`                  | 100      |
| `src/main/ipc/handlers/openspec.ts`                 | 100      |
| `src/renderer/components/SpecKitCommandsPanel.tsx`  | 424      |
| `src/renderer/components/OpenSpecCommandsPanel.tsx` | 426      |
| **Total**                                           | **2051** |

**Key finding:** Near-identical line counts across all 3 pairs. The IPC handlers are exactly 100/100 lines. The UI panels are 424/426 lines. The managers differ by only 59 lines (530 vs 471). Strong candidate for a shared base implementation with configuration-driven specialization.

---

## CLI Importing from Main

```
grep -rn "from '.*main/" src/cli/ --include="*.ts"
```

11 cross-boundary imports across 4 CLI files:

| File                                  | Line | Import                                                                                      |
| ------------------------------------- | ---- | ------------------------------------------------------------------------------------------- |
| `src/cli/commands/run-playbook.ts`    | 8    | `import { getAgentDefinition } from '../../main/agents/definitions'`                        |
| `src/cli/commands/send.ts`            | 6    | `import { estimateContextUsage } from '../../main/parsers/usage-aggregator'`                |
| `src/cli/commands/send.ts`            | 7    | `import { getAgentDefinition } from '../../main/agents/definitions'`                        |
| `src/cli/services/agent-spawner.ts`   | 7    | `import type { AgentOutputParser } from '../../main/parsers/agent-output-parser'`           |
| `src/cli/services/agent-spawner.ts`   | 8    | `import { CodexOutputParser } from '../../main/parsers/codex-output-parser'`                |
| `src/cli/services/agent-spawner.ts`   | 9    | `import { OpenCodeOutputParser } from '../../main/parsers/opencode-output-parser'`          |
| `src/cli/services/agent-spawner.ts`   | 10   | `import { FactoryDroidOutputParser } from '../../main/parsers/factory-droid-output-parser'` |
| `src/cli/services/agent-spawner.ts`   | 11   | `import { aggregateModelUsage } from '../../main/parsers/usage-aggregator'`                 |
| `src/cli/services/agent-spawner.ts`   | 12   | `import { getAgentDefinition } from '../../main/agents/definitions'`                        |
| `src/cli/services/agent-spawner.ts`   | 13   | `import { hasCapability } from '../../main/agents/capabilities'`                            |
| `src/cli/services/batch-processor.ts` | 17   | `import { logger } from '../../main/utils/logger'`                                          |

**Categories of cross-boundary imports:**

- Agent definitions/capabilities: 5 imports (3 files)
- Output parsers: 4 imports (1 file)
- Usage aggregator: 2 imports (2 files)
- Logger: 1 import (1 file)

**Key finding:** `agent-spawner.ts` has 7 imports from `main/`. These modules (parsers, agent definitions, capabilities) could live in `shared/` to properly serve both `cli/` and `main/`.

---

## getConfigDir Definitions

```
grep -rn "getConfigDir\|configDir\|CONFIG_DIR" src/ --include="*.ts" | grep -v __tests__
```

37 matches. 4 independent `getConfigDir` implementations:

| File                                        | Line | App name casing         | Mechanism                              |
| ------------------------------------------- | ---- | ----------------------- | -------------------------------------- |
| `src/cli/services/storage.ts`               | 20   | `Maestro` (capitalized) | `os.homedir()` + platform switch       |
| `src/main/group-chat/group-chat-storage.ts` | 150  | N/A                     | `app.getPath('userData')` via electron |
| `src/shared/cli-activity.ts`                | 40   | `maestro` (lowercase)   | `os.homedir()` + platform switch       |
| `src/shared/cli-server-discovery.ts`        | 24   | `maestro` (lowercase)   | `os.homedir()` + platform switch       |

**Casing inconsistency documented in source:**

- `src/shared/cli-activity.ts:7` - "NOTE: This file has its own getConfigDir() implementation (lowercase 'maestro')"
- `src/shared/cli-activity.ts:13` - "cli/services/storage.ts uses 'Maestro' (capitalized)"
- `src/shared/cli-activity.ts:15` - "shared/cli-activity.ts uses 'maestro' (lowercase)"

**Additional `configDir` variable usages:**

| File                                 | Lines                 | Notes                                          |
| ------------------------------------ | --------------------- | ---------------------------------------------- |
| `src/cli/commands/run-playbook.ts`   | 37,40,42,47,50        | Inline platform switch (lowercase 'maestro')   |
| `src/cli/services/agent-sessions.ts` | 82,85,87,89,92        | Inline platform switch (capitalized 'Maestro') |
| `src/main/history-manager.ts`        | 42,46,47,48,49        | Uses `app.getPath('userData')`                 |
| `src/cli/services/storage.ts`        | 39,98,106,373,374,434 | Uses own `getConfigDir()`                      |

**Helper exports:**

- `src/cli/services/storage.ts:373` - `export function getConfigDirectory(): string` (wraps `getConfigDir()`)
- `src/cli/services/storage.ts:374` - `return getConfigDir()`

**Key finding:** 4 separate implementations with inconsistent casing (`Maestro` vs `maestro`) that resolve to different directories on case-sensitive filesystems. The codebase is aware of this issue (comments in `cli-activity.ts`) but has not resolved it.
