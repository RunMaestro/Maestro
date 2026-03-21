# Dedup Scan: Renderer Services and Constants

---

## Services Duplication Analysis

### 1. `extractResultFromStreamJson` - DUPLICATED (HIGH)

**Files:** `inlineWizardConversation.ts:397`, `inlineWizardDocumentGeneration.ts:535`

Both files define a private `extractResultFromStreamJson(output, agentType)` function with identical logic:
- OpenCode: concatenate `msg.type === 'text' && msg.part?.text`
- Codex: concatenate `msg.type === 'agent_message' && msg.content[].text` plus `msg.type === 'message' && msg.text`
- Claude Code: find `msg.type === 'result' && msg.result`

**Recommendation:** Extract to a shared utility (e.g., `renderer/utils/agentOutputParser.ts`) and import in both services.

---

### 2. `buildArgsForAgent` - DUPLICATED (MEDIUM)

**Files:** `inlineWizardConversation.ts:469`, `inlineWizardDocumentGeneration.ts:607`

Both files define a private `buildArgsForAgent(agent)` with the same switch/case structure for claude-code, codex, opencode, and default. The only difference:
- **Conversation version:** restricts to `--allowedTools Read,Glob,Grep,LS` (read-only)
- **Generation version:** allows `--allowedTools Read,Glob,Grep,LS,Write` (write access for doc creation)

**Recommendation:** Extract to shared utility with a `readOnly: boolean` parameter to control the allowedTools list.

---

### 3. SpecKit/OpenSpec Services - STRUCTURAL CLONE (MEDIUM)

**Files:** `speckit.ts` (57 lines), `openspec.ts` (57 lines)

These two files are structurally identical. Each exports 3 functions:

```
speckit.ts:                          openspec.ts:
getSpeckitCommands()                 getOpenSpecCommands()
  -> window.maestro.speckit.getPrompts()     -> window.maestro.openspec.getPrompts()

getSpeckitMetadata()                 getOpenSpecMetadata()
  -> window.maestro.speckit.getMetadata()    -> window.maestro.openspec.getMetadata()

getSpeckitCommand(slashCommand)      getOpenSpecCommand(slashCommand)
  -> window.maestro.speckit.getCommand()     -> window.maestro.openspec.getCommand()
```

Same error handling pattern (try/catch with console.error, return empty/null). Same response checking (`result.success && result.commands/metadata/command`).

**Additional bypass:** Both have panel components (`SpecKitCommandsPanel.tsx`, `OpenSpecCommandsPanel.tsx`) that call `window.maestro.speckit.*` / `window.maestro.openspec.*` directly, bypassing these services entirely for `getPrompts`, `getMetadata`, `savePrompt`, `resetPrompt`, and `refresh` operations.

**Recommendation:** Create a generic `createPromptService(namespace)` factory that returns the three methods parameterized by namespace. Also consider consolidating the panel components.

---

### 4. Direct `window.maestro.process.*` Bypass of `processService` (MEDIUM)

**Pattern:** `processService` wraps `window.maestro.process.*` with `createIpcMethod`, but wizard services bypass it entirely.

```
process.ts (via processService):
  - onData, onExit, onSessionId, onToolExecution

inlineWizardConversation.ts (direct calls):
  - window.maestro.process.onData          (line 671)
  - window.maestro.process.onExit          (line 727)
  - window.maestro.process.onThinkingChunk (line 684) -- not even in processService!
  - window.maestro.process.onToolExecution (line 705)
  - window.maestro.process.kill            (line 627, 865)
  - window.maestro.process.spawn           (line 790)

inlineWizardDocumentGeneration.ts (direct calls):
  - window.maestro.process.onData          (line 937)
  - window.maestro.process.onExit          (line 948)
  - window.maestro.process.kill            (line 805, 818)
  - window.maestro.process.spawn           (line 985)
```

**Missing from processService:** `onThinkingChunk` is called directly and has no wrapper in `processService` at all.

**Recommendation:** Either add `onThinkingChunk` to `processService` and have wizard services use the wrapper, or accept that wizard services need direct access for their complex lifecycle management (spawn + multiple listeners + timeout + cleanup).

---

### 5. Shared Utilities Between contextGroomer and contextSummarizer (LOW - CLEAN)

Both services import from `renderer/utils/contextExtractor`:
- `formatLogsForGrooming` - contextGroomer (2 uses), contextSummarizer (3 uses)
- `parseGroomedOutput` - contextGroomer (1 use), contextSummarizer (2 uses)
- `estimateTokenCount` - contextGroomer (1 use)
- `estimateTextTokenCount` - contextSummarizer (5 uses)

This is properly factored. The shared utilities live in `renderer/utils/contextExtractor.ts` and both services import from there. No duplication here.

Both services also call the same IPC endpoint `window.maestro.context.groomContext()` - the summarizer just calls it more times (chunking). This is intentional reuse, not duplication.

---

### 6. `createIpcMethod` Adoption Gap (LOW)

Only 2 of 9 service files use `createIpcMethod`:
- `git.ts` - 7 calls (all swallow mode with defaultValue)
- `process.ts` - 5 calls (all rethrow mode)

Files NOT using it (with their own try/catch):
- `contextGroomer.ts` - 2 IPC calls
- `contextSummarizer.ts` - 4 IPC calls
- `speckit.ts` - 3 IPC calls
- `openspec.ts` - 3 IPC calls
- `inlineWizardConversation.ts` - 8 IPC calls
- `inlineWizardDocumentGeneration.ts` - 15+ IPC calls

The wizard services have legitimate reasons (complex process lifecycle), but speckit/openspec could use `createIpcMethod` with `defaultValue` for consistency.

---

## Constants Duplication Analysis

### 7. Modal Priority Consistency (CLEAN)

All 50+ usages across 40+ component files reference `MODAL_PRIORITIES.*` from the centralized constant. No hardcoded numeric priority values found anywhere in the codebase.

One minor issue: `DebugWizardModal.tsx` uses `MODAL_PRIORITIES.CONFIRM || 100` with a fallback, suggesting uncertainty about the constant's availability. This fallback is unnecessary since `MODAL_PRIORITIES.CONFIRM` is always `1000`.

**Ordering anomaly:** `DIRECTOR_NOTES` (848) has a higher priority value than `RENAME_GROUP` (850), but the comment order suggests DIRECTOR_NOTES should be lower priority. These are adjacent values that work correctly in practice.

---

### 8. `KNOWN_TOOL_NAMES` and `CLAUDE_BUILTIN_COMMANDS` (CLEAN)

Both constants in `app.ts` are only imported from `app.ts`. No inline redefinitions found elsewhere in the codebase.

---

### 9. `AGENT_ICONS` (CLEAN)

Centralized in `agentIcons.ts`. Only used via imports:
- `SendToAgentModal.tsx` - imports `getAgentIcon`
- `useAvailableAgents.ts` - imports `getAgentIcon`

No inline icon definitions found elsewhere.

---

### 10. `themes.ts` Re-export (CLEAN)

Pure re-export from `src/shared/themes.ts`. No renderer-specific theme definitions. All consumers import through this re-export layer, maintaining the shared -> renderer dependency direction.

---

### 11. Shortcut Constants (CLEAN)

All three shortcut records (`DEFAULT_SHORTCUTS`, `FIXED_SHORTCUTS`, `TAB_SHORTCUTS`) are only defined in `constants/shortcuts.ts` and imported by:
- `KeyboardMasteryCelebration.tsx`
- `LeaderboardRegistrationModal.tsx`
- `ShortcutsHelpModal.tsx`
- `settingsStore.ts`

No inline shortcut definitions found.

---

### 12. Colorblind Palettes (CLEAN)

All colorblind constants are centralized in `colorblindPalettes.ts` and imported by:
- `SymphonyModal.tsx` - uses `COLORBLIND_AGENT_PALETTE`
- `ActivityHeatmap.tsx` - uses `COLORBLIND_HEATMAP_SCALE`
- `AgentComparisonChart.tsx` - uses `COLORBLIND_AGENT_PALETTE`
- `AgentEfficiencyChart.tsx` - uses `COLORBLIND_AGENT_PALETTE`
- `AgentUsageChart.tsx` - uses `COLORBLIND_AGENT_PALETTE`
- `DurationTrendsChart.tsx` - uses `COLORBLIND_LINE_COLORS`

No inline color definitions that should be using these palettes.

---

### 13. Conductor Badges and Keyboard Mastery (CLEAN)

Both gamification systems are centralized with no duplication:
- `conductorBadges.ts` - used by 4 components
- `keyboardMastery.ts` - used by 4 components + settingsStore

---

## Summary

### Issues Found

| # | Finding | Severity | Files |
|---|---------|----------|-------|
| 1 | `extractResultFromStreamJson` duplicated | HIGH | inlineWizardConversation.ts, inlineWizardDocumentGeneration.ts |
| 2 | `buildArgsForAgent` duplicated | MEDIUM | inlineWizardConversation.ts, inlineWizardDocumentGeneration.ts |
| 3 | speckit.ts / openspec.ts structural clone | MEDIUM | speckit.ts, openspec.ts |
| 4 | Direct process IPC bypass of processService | MEDIUM | inlineWizardConversation.ts, inlineWizardDocumentGeneration.ts |
| 5 | `onThinkingChunk` missing from processService | MEDIUM | process.ts |
| 6 | `createIpcMethod` not adopted by most services | LOW | 7 of 9 service files |
| 7 | SpecKit/OpenSpec panel components bypass services | LOW | SpecKitCommandsPanel.tsx, OpenSpecCommandsPanel.tsx |

### Clean Areas (No Action Needed)

- Modal priorities: fully centralized, no hardcoded values
- Theme definitions: properly layered via shared re-export
- Shortcut definitions: single source of truth
- Colorblind palettes: centralized, properly imported
- Gamification constants: no duplication
- contextGroomer/contextSummarizer shared utilities: properly factored via contextExtractor

### Recommended Extractions

1. **`renderer/utils/agentOutputParser.ts`** - Extract `extractResultFromStreamJson` and `extractDisplayTextFromChunk` into shared utility
2. **`renderer/utils/agentArgsBuilder.ts`** - Extract `buildArgsForAgent` with `readOnly` parameter
3. **`renderer/services/promptCommandService.ts`** - Generic factory for SpecKit/OpenSpec pattern
4. **`processService.onThinkingChunk`** - Add missing event wrapper
