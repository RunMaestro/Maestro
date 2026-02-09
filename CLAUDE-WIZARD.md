# CLAUDE-WIZARD.md

Wizard documentation for the Maestro codebase. For the main guide, see [[CLAUDE.md]].

## Onboarding Wizard

The wizard (`src/renderer/components/Wizard/`) guides new users through first-run setup, creating AI agents with Auto Run documents.

### Wizard Architecture

```
src/renderer/components/Wizard/
├── MaestroWizard.tsx           # Main orchestrator, screen transitions
├── WizardContext.tsx           # State management (useReducer pattern)
├── WizardResumeModal.tsx       # Resume incomplete wizard dialog
├── WizardExitConfirmModal.tsx  # Exit confirmation dialog
├── ScreenReaderAnnouncement.tsx # Accessibility announcements
├── screens/                    # Individual wizard steps
│   ├── AgentSelectionScreen.tsx    # Step 1: Choose AI agent
│   ├── DirectorySelectionScreen.tsx # Step 2: Select project folder
│   ├── ConversationScreen.tsx      # Step 3: AI project discovery
│   └── PhaseReviewScreen.tsx       # Step 4: Review generated plan
├── services/                   # Business logic
│   ├── wizardPrompts.ts           # System prompts, response parser
│   ├── conversationManager.ts     # AI conversation handling
│   └── phaseGenerator.ts          # Document generation
└── tour/                       # Post-setup walkthrough
    ├── TourOverlay.tsx            # Spotlight overlay
    ├── TourStep.tsx               # Step tooltip
    ├── tourSteps.ts               # Step definitions
    └── useTour.tsx                # Tour state management
```

### Wizard Flow

1. **Agent Selection** → Select available AI (Claude Code, etc.) and project name
2. **Directory Selection** → Choose project folder, validates Git repo status
3. **Conversation** → AI asks clarifying questions, builds confidence score (0-100)
4. **Phase Review** → View/edit generated Phase 1 document, choose to start tour

When confidence reaches 80+ and agent signals "ready", user proceeds to Phase Review where Auto Run documents are generated and saved to `Auto Run Docs/Initiation/`. The `Initiation/` subfolder keeps wizard-generated documents separate from user-created playbooks.

### Triggering the Wizard

```typescript
// From anywhere with useWizard hook
const { openWizard } = useWizard();
openWizard();

// Keyboard shortcut (default)
Cmd+Shift+N  // Opens wizard

// Also available in:
// - Command K menu: "New Agent Wizard"
// - Hamburger menu: "New Agent Wizard"
```

### State Persistence (Resume)

Wizard state persists to `wizardResumeState` in settings when user advances past step 1. On next app launch, if incomplete state exists, `WizardResumeModal` offers "Resume" or "Start Fresh".

```typescript
// Check for saved state
const hasState = await hasResumeState();

// Load saved state
const savedState = await loadResumeState();

// Clear saved state
clearResumeState();
```

#### State Lifecycle

The Wizard maintains two types of state:

1. **In-Memory State** (React `useReducer`)
   - Managed in `WizardContext.tsx`
   - Includes: `currentStep`, `isOpen`, `isComplete`, conversation history, etc.
   - Lives only during the app session
   - Must be reset when opening wizard after completion

2. **Persisted State** (Settings)
   - Stored in `wizardResumeState` via `window.maestro.settings`
   - Enables resume functionality across app restarts
   - Automatically saved when advancing past step 1
   - Cleared on completion or when user chooses "Just Quit"

**State Save Triggers:**
- Auto-save: When `currentStep` changes (step > 1) - `WizardContext.tsx` useEffect with `saveResumeState()`
- Manual save: User clicks "Save & Exit" - `MaestroWizard.tsx` `handleConfirmExit()`

**State Clear Triggers:**
- Wizard completion: `App.tsx` wizard completion handler + `WizardContext.tsx` `COMPLETE_WIZARD` action
- User quits: "Quit without saving" button - `MaestroWizard.tsx` `handleQuitWithoutSaving()`
- User starts fresh: "Start Fresh" in resume modal - `App.tsx` resume handlers

**Opening Wizard Logic:**
The `openWizard()` function in `WizardContext.tsx` handles state initialization:
```typescript
// If previous wizard was completed, reset in-memory state first
if (state.isComplete === true) {
  dispatch({ type: 'RESET_WIZARD' });  // Clear stale state
}
dispatch({ type: 'OPEN_WIZARD' });  // Show wizard UI
```

This ensures:
- **Fresh starts**: Completed wizards don't contaminate new runs
- **Resume works**: Abandoned wizards (isComplete: false) preserve state
- **No race conditions**: Persisted state is checked after wizard opens

**Important:** The persisted state and in-memory state are independent. Clearing one doesn't automatically clear the other. Both must be managed correctly to prevent state contamination (see Issue #89).

### Tour System

The tour highlights UI elements with spotlight cutouts:

```typescript
// Add data-tour attribute to spotlight elements
<div data-tour="autorun-panel">...</div>

// Tour steps defined in tourSteps.ts
{
  id: 'autorun-panel',
  title: 'Auto Run in Action',
  description: '...',
  selector: '[data-tour="autorun-panel"]',
  position: 'left',  // tooltip position
  uiActions: [       // UI state changes before spotlight
    { type: 'setRightTab', value: 'autorun' },
  ],
}
```

### Customization Points

| What | Where |
|------|-------|
| Add wizard step | `WizardContext.tsx` (WIZARD_TOTAL_STEPS, WizardStep type, STEP_INDEX) |
| Modify wizard prompts | `src/prompts/wizard-*.md` (content), `services/wizardPrompts.ts` (logic) |
| Change confidence threshold | `READY_CONFIDENCE_THRESHOLD` in wizardPrompts.ts (default: 80) |
| Add tour step | `tour/tourSteps.ts` array |
| Modify Auto Run document format | `src/prompts/wizard-document-generation.md` |
| Change wizard keyboard shortcut | `shortcuts.ts` → `openWizard` |

### Related Settings

```typescript
// In useSettings.ts
wizardCompleted: boolean    // First wizard completion
tourCompleted: boolean      // First tour completion
firstAutoRunCompleted: boolean  // Triggers celebration modal
```

---

## Inline Wizard (`/wizard`)

The Inline Wizard creates Auto Run Playbook documents from within an existing agent. Unlike the full-screen Onboarding Wizard above, it runs inside a single tab.

### Prerequisites

- Auto Run document folder must be configured for the agent
- If not set, `/wizard` errors with instructions to configure it

### User Flow

1. **Start**: Type `/wizard` in any AI tab → tab enters wizard mode
2. **Conversation**: Back-and-forth with agent, confidence gauge builds (0-100%)
3. **Generation**: At 80%+ confidence, generates docs (Austin Facts shown, cancellable)
4. **Completion**: Tab returns to normal with preserved context, docs in unique subfolder

### Key Behaviors

- Multiple wizards can run in different tabs simultaneously
- Wizard state is **per-tab** (`AITab.wizardState`), not per-agent
- Documents written to unique subfolder under Auto Run folder (e.g., `Auto Run Docs/Project-Name/`)
- On completion, tab renamed to "Project: {SubfolderName}"
- Final AI message summarizes generated docs and next steps
- Same `agentSessionId` preserved for context continuity

### Architecture

```
src/renderer/components/InlineWizard/
├── WizardConversationView.tsx  # Conversation phase UI
├── WizardInputPanel.tsx        # Input with confidence gauge
├── DocumentGenerationView.tsx  # Generation phase with Austin Facts
└── ... (see index.ts for full documentation)

src/renderer/hooks/useInlineWizard.ts    # Main hook
src/renderer/contexts/InlineWizardContext.tsx  # State provider
```

### Customization Points

| What | Where |
|------|-------|
| Modify inline wizard prompts | `src/prompts/wizard-*.md` |
| Change confidence threshold | `READY_CONFIDENCE_THRESHOLD` in wizardPrompts.ts |
| Modify generation UI | `DocumentGenerationView.tsx`, `AustinFactsDisplay.tsx` |
