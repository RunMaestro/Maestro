---
type: report
title: Did You Know regression validation
created: 2026-09-19
tags:
  - did-you-know
  - testing
related:
  - '[[TEST-PATTERNS]]'
  - '[[CANONICAL-UTILITIES]]'
---

# Did You Know regression validation

Validated the Phase 07 regression task against `f8c6216`, using Node.js 22.19.0
and Vitest 4.1.11 on macOS. No production code or test assertions needed changes.

## Results

- All 2,433 tests in the 49 files below passed. The JSON report independently
  confirmed all 49 files passed, with zero failed or pending tests.
- Selection combines every unit test changed since the contribution base
  `0e4f286` with every test returned by `git grep -l -i tour -- src/__tests__`.
  This includes the five Phase 07 suites, searchable-settings DOM parity,
  settings-store key coverage, and both explicitly requested tour suites.
- An additional nine argument-building tests passed in
  `src/__tests__/integration/group-chat-integration.test.ts`.
  Its six live-provider tests were excluded: they launch real agents, and this
  validation did not exercise live providers.
- Six mocked integration tests in
  `src/__tests__/integration/group-chat.integration.test.ts` failed with
  `Prompts not initialized. Call initializePrompts() first.` The failures occur
  when `routeUserMessage` requests the moderator system prompt.

## Pre-existing integration failure

The mocked group-chat suite consumes `group-chat-test-utils.ts`, whose shuffle
implementation was changed in Phase 01. Re-running all six failures with that
helper's exact `0e4f286` contents, substituted by a temporary Vite transform,
produced the same six prompt-initialization failures. The integration suite,
setup file, prompt manager, and group-chat production files are unchanged from
`0e4f286`. This is a pre-existing failure unrelated to the shuffle promotion;
no assertions were removed or weakened to hide it.

Temporary integration configuration retained the existing integration setup,
selected the two group-chat files, and filtered test names to argument building
and the mocked suite. `RUN_INTEGRATION_TESTS=true` enabled the argument assertions;
the test-name filter excluded the real-agent suite. `SKIP_INTEGRATION_TESTS=false`
ensured the mocked tests executed their bodies. Temporary files stayed under
ignored `tmp/dyk-validation`.

## Unit test manifest

Run these paths together with `node node_modules/vitest/vitest.mjs run`.
The full repository test suite was not run, as required by the playbook.

- `src/__tests__/main/web-server/routes/authRoutes.test.ts`
- `src/__tests__/renderer/components/AppModals-selfSourced.test.tsx`
- `src/__tests__/renderer/components/AppStandaloneModals.test.tsx`
- `src/__tests__/renderer/components/BrowserTabView.test.tsx`
- `src/__tests__/renderer/components/DidYouKnow/DidYouKnowModal.test.tsx`
- `src/__tests__/renderer/components/DidYouKnow/OrnateFrame.test.tsx`
- `src/__tests__/renderer/components/DidYouKnow/TipArtwork.test.tsx`
- `src/__tests__/renderer/components/DidYouKnow/TipCard.test.tsx`
- `src/__tests__/renderer/components/DidYouKnow/useDidYouKnowRotation.test.tsx`
- `src/__tests__/renderer/components/DidYouKnowFrame.test.ts`
- `src/__tests__/renderer/components/DidYouKnowModal.test.tsx`
- `src/__tests__/renderer/components/DidYouKnowReadingMode.test.tsx`
- `src/__tests__/renderer/components/MainPanel/MainPanelContent.test.tsx`
- `src/__tests__/renderer/components/MainPanel/MainPanelHeader.test.tsx`
- `src/__tests__/renderer/components/QuickActionsModal.test.tsx`
- `src/__tests__/renderer/components/QuickActionsModal/commands/commandBuilders.test.ts`
- `src/__tests__/renderer/components/RightPanel.test.tsx`
- `src/__tests__/renderer/components/SessionList.test.tsx`
- `src/__tests__/renderer/components/SessionList/HamburgerMenuContentPhone.test.tsx`
- `src/__tests__/renderer/components/SessionList/SessionListMemoization.test.tsx`
- `src/__tests__/renderer/components/Settings/searchableSettings.test.ts`
- `src/__tests__/renderer/components/Settings/tabs/GeneralTab.test.tsx`
- `src/__tests__/renderer/components/Settings/tabs/GeneralTab/sections.test.tsx`
- `src/__tests__/renderer/components/TabBar/TabBar.reorder.test.tsx`
- `src/__tests__/renderer/components/Wizard/TourStepWidth.test.tsx`
- `src/__tests__/renderer/components/Wizard/WizardContext.test.tsx`
- `src/__tests__/renderer/components/Wizard/WizardIntegration.test.tsx`
- `src/__tests__/renderer/components/Wizard/WizardKeyboardNavigation.test.tsx`
- `src/__tests__/renderer/components/Wizard/WizardThemeStyles.test.tsx`
- `src/__tests__/renderer/components/Wizard/screens/PhaseReviewScreen/components.test.tsx`
- `src/__tests__/renderer/components/Wizard/screens/PhaseReviewScreen/hooks.test.tsx`
- `src/__tests__/renderer/constants/modalPriorities.test.ts`
- `src/__tests__/renderer/constants/shortcuts.test.ts`
- `src/__tests__/renderer/fonts-and-sizing.test.ts`
- `src/__tests__/renderer/hooks/props/useSessionListProps.test.ts`
- `src/__tests__/renderer/hooks/tabs/internal/useBrowserTabHandlers.test.ts`
- `src/__tests__/renderer/hooks/useAppInitialization.test.ts`
- `src/__tests__/renderer/hooks/useMainKeyboardHandler.test.ts`
- `src/__tests__/renderer/hooks/useModalHandlers.test.ts`
- `src/__tests__/renderer/hooks/useSettings.test.ts`
- `src/__tests__/renderer/hooks/useTourActions.test.ts`
- `src/__tests__/renderer/hooks/useWizardHandlers.test.ts`
- `src/__tests__/renderer/stores/modalStore.test.ts`
- `src/__tests__/renderer/stores/settingsStore.test.ts`
- `src/__tests__/renderer/utils/browserTabPersistence.test.ts`
- `src/__tests__/renderer/utils/spotlight.test.ts`
- `src/__tests__/shared/didYouKnow.test.ts`
- `src/__tests__/shared/settingsMetadata.test.ts`
- `src/__tests__/shared/shuffle.test.ts`
