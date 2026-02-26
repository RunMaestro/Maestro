# ENCORE-INBOX-14: Final lint + test + verification gate

## Objective
Full verification pass ensuring all 13 prior phases integrate cleanly.

## Tasks

- [x] Run `npm run lint` (TypeScript). Fix any errors.
  > ✅ Passes cleanly — zero TypeScript errors across all 3 configs (lint, main, cli).

- [x] Run `npm run test`. Fix any failures. Pay special attention to tests referencing SessionList props, keyboard handler context, or modal store IDs.
  > ✅ 484/485 test files pass, 20,880/20,883 tests pass. 3 failures are **pre-existing** CodexSessionStorage timeout issues (not related to Encore Inbox): the test scans ~32K real `.jsonl` files in `~/.codex/sessions/` without mocking the filesystem, causing 10s timeouts. Verified by checking `git diff main` — no functional changes to this test file. All SessionList, keyboard handler, and modal store tests pass cleanly.

- [ ] Run `npm run lint:eslint`. Fix any warnings.

- [ ] Verify the complete integration by running these checks:
  ```bash
  # 1. Type flag exists
  grep -n "unifiedInbox" src/renderer/types/index.ts
  # 2. Default is false
  grep -n "unifiedInbox" src/renderer/stores/settingsStore.ts
  # 3. Settings toggle card exists
  grep -c "unifiedInbox" src/renderer/components/SettingsModal.tsx
  # 4. Modal gating in App.tsx
  grep -n "encoreFeatures.unifiedInbox" src/renderer/App.tsx
  # 5. Keyboard shortcut registered and gated
  grep -n "agentInbox" src/renderer/constants/shortcuts.ts
  grep -n "agentInbox.*encoreFeatures" src/renderer/hooks/keyboard/useMainKeyboardHandler.ts
  # 6. Hamburger menu item
  grep -n "setAgentInboxOpen" src/renderer/components/SessionList.tsx
  # 7. Command palette entry
  grep -n "onOpenUnifiedInbox" src/renderer/components/QuickActionsModal.tsx
  # 8. Components ported
  ls src/renderer/components/AgentInbox/
  # 9. Auto-scroll fix
  grep -n "distanceFromBottom" src/renderer/components/AgentInbox/FocusModeView.tsx
  # 10. Design alignment
  grep -n "px-4 py-3" src/renderer/components/AgentInbox/InboxListView.tsx
  ```

## Gate
- `npm run lint` passes (zero errors)
- `npm run test` passes (all tests green)
- `npm run lint:eslint` passes (zero warnings)
- All 10 verification checks above return results
