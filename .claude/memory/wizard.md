# Wizard & Tour System

## Onboarding Wizard (`src/renderer/components/Wizard/`)

**Flow:** Agent Selection → Directory Selection → AI Conversation (confidence 0-100) → Phase Review

- Confidence threshold: 80 (configurable via `READY_CONFIDENCE_THRESHOLD`)
- Documents generated to `Auto Run Docs/Initiation/` subfolder
- State persists to `wizardResumeState` in settings (resume on relaunch)

**Two state types:**
1. **In-memory** (React `useReducer` in `WizardContext.tsx`) — lives during session
2. **Persisted** (settings store) — enables resume across restarts

**Opening wizard after completion:** Must dispatch `RESET_WIZARD` before `OPEN_WIZARD` to clear stale state.

## Inline Wizard (`/wizard` command)

- Runs inside existing AI tab (not full-screen)
- State per-tab (`AITab.wizardState`), not per-agent
- Documents written to unique subfolder under Auto Run folder
- Tab renamed to "Project: {SubfolderName}" on completion
- Same `agentSessionId` preserved for context continuity

## Tour System

```typescript
// Spotlight elements via data attribute
<div data-tour="autorun-panel">...</div>

// Steps defined in tour/tourSteps.ts
{ id: 'autorun-panel', selector: '[data-tour="autorun-panel"]', position: 'left',
  uiActions: [{ type: 'setRightTab', value: 'autorun' }] }
```

## Customization Points

| What | Where |
|------|-------|
| Wizard prompts | `src/prompts/wizard-*.md` |
| Confidence threshold | `READY_CONFIDENCE_THRESHOLD` in wizardPrompts.ts |
| Tour steps | `tour/tourSteps.ts` |
| Document format | `src/prompts/wizard-document-generation.md` |
| Keyboard shortcut | `shortcuts.ts` → `openWizard` |

## Related Settings

`wizardCompleted`, `tourCompleted`, `firstAutoRunCompleted` (triggers celebration)
