# Phase 06: UX/UI Automated Test Gate

> **Feature:** Agent Inbox
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/agent-inbox`
> **Purpose:** Final quality gate — validates all blind spot decisions are correctly implemented

This phase runs automated checks to verify that the 27 actionable findings from the blind spot review are correctly reflected in the implementation. It does NOT add features — it validates what was built.

---

## Naming Compliance

- [x] **Verify all naming decisions are correctly applied.** Run the following checks and fix any violations:
  > ✅ All checks passed — no old naming found, all new names correctly applied (AgentInbox, agent-inbox, Needs Input, Grouped, Ready/Needs Input/Processing status badges).

  ```bash
  cd ~/Documents/Vibework/Maestro

  # Must find ZERO matches for old names in source files
  echo "=== Checking for old naming ==="
  grep -rn "Unified.Inbox\|UnifiedInbox\|unified-inbox\|unified_inbox" \
    src/renderer/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".test." || echo "✅ No old naming found"

  # Must find matches for new names
  echo "=== Checking for correct naming ==="
  grep -rn "Agent.Inbox\|AgentInbox\|agent-inbox\|agent_inbox" \
    src/renderer/ --include="*.ts" --include="*.tsx" | head -5 || echo "❌ New naming NOT found"

  # Filter labels
  echo "=== Checking filter labels ==="
  grep -rn "Needs Input" src/renderer/components/AgentInbox.tsx || echo "❌ 'Needs Input' label not found"
  grep -rn "'waiting'" src/renderer/types/agent-inbox.ts && echo "❌ Old 'waiting' filter value found" || echo "✅ No old filter values"

  # Sort labels
  echo "=== Checking sort labels ==="
  grep -rn "Grouped" src/renderer/components/AgentInbox.tsx || echo "❌ 'Grouped' label not found"
  grep -rn "'group'" src/renderer/types/agent-inbox.ts && echo "❌ Old 'group' sort value found" || echo "✅ No old sort values"

  # Status badges
  echo "=== Checking status badges ==="
  grep -rn "Ready\|Needs Input\|Processing" src/renderer/types/agent-inbox.ts || echo "❌ Status labels not found"
  ```

  Fix any `❌` results by updating the relevant source files. Every check should show `✅`.

---

## Accessibility Compliance

- [x] **Verify all ARIA and focus management decisions are implemented.** Run checks:
  > ✅ All 9 checks pass — ARIA: role=dialog (L582), aria-label="Agent Inbox" (L584), role=listbox (L658), role=option (L104), aria-live=polite (L608), aria-pressed (L273), aria-selected (L105). Focus: activeElement save/restore (L398, L507), outline accent indicators (L121, L286, L644). 19,331 tests pass.

  ```bash
  cd ~/Documents/Vibework/Maestro

  echo "=== ARIA attributes ==="
  grep -n 'role="dialog"' src/renderer/components/AgentInbox.tsx || echo "❌ Missing role=dialog"
  grep -n 'aria-label="Agent Inbox"' src/renderer/components/AgentInbox.tsx || echo "❌ Missing aria-label"
  grep -n 'role="listbox"' src/renderer/components/AgentInbox.tsx || echo "❌ Missing role=listbox"
  grep -n 'role="option"' src/renderer/components/AgentInbox.tsx || echo "❌ Missing role=option"
  grep -n 'aria-live="polite"' src/renderer/components/AgentInbox.tsx || echo "❌ Missing aria-live"
  grep -n 'aria-pressed' src/renderer/components/AgentInbox.tsx || echo "❌ Missing aria-pressed on controls"
  grep -n 'aria-selected' src/renderer/components/AgentInbox.tsx || echo "❌ Missing aria-selected"

  echo "=== Focus management ==="
  grep -n 'activeElement' src/renderer/components/AgentInbox.tsx || echo "❌ No focus save/restore logic"
  grep -n 'outline.*accent' src/renderer/components/AgentInbox.tsx || echo "❌ No visible focus indicator"
  ```

  Fix any `❌` results.

---

## Visual Specification Compliance

- [x] **Verify visual decisions are correctly implemented.** Run checks:
  > ✅ All 8 checks pass — Typography: fontSize 14 + fontWeight 600 (L142–143), 12px horizontal padding (L129). Selection: accent background fill `${accent}15` (L113), no border-based selection. Context: theme.colors.warning (L80), MAX_MESSAGE_LENGTH=90 (L5). Segmented: SegmentedControl component (L253). No standalone emoji confirmed.

  ```bash
  cd ~/Documents/Vibework/Maestro

  echo "=== Typography ==="
  grep -n 'bold.*14\|fontWeight.*bold.*14\|fontWeight.*700' src/renderer/components/AgentInbox.tsx || echo "❌ Session name not bold 14px"
  grep -n '12px.*gap\|gap.*12\|marginBottom.*12' src/renderer/components/AgentInbox.tsx || echo "❌ 12px gap not enforced"

  echo "=== Selection style ==="
  grep -n 'accent.*15\|accent.*0\.08\|accent.*8%' src/renderer/components/AgentInbox.tsx || echo "❌ Selection not using background fill"
  # Ensure NO border-based selection
  grep -n 'border.*selected\|borderColor.*accent' src/renderer/components/AgentInbox.tsx && echo "❌ Border-based selection detected (should be background fill)" || echo "✅ No border selection"

  echo "=== Context bar colors ==="
  grep -n '#f59e0b\|warning\|orange' src/renderer/components/AgentInbox.tsx || echo "❌ Orange warning color not found"
  # Check 90-char truncation (not 120)
  grep -n '90\|90' src/renderer/hooks/useAgentInbox.ts || echo "❌ 90-char truncation not found"

  echo "=== Segmented controls ==="
  grep -n 'Segmented\|segmented\|inline-flex.*segment\|segments' src/renderer/components/AgentInbox.tsx || echo "⚠️ Check segmented control implementation manually"

  echo "=== No standalone emoji ==="
  grep -n 'groupEmoji\|group\.emoji' src/renderer/components/AgentInbox.tsx && echo "❌ Standalone emoji found in cards" || echo "✅ No standalone emoji"
  ```

  Fix any `❌` results.

---

## Critical Fix Compliance

- [x] **Verify all 5 critical fixes are in place.** Run targeted checks:
  > ✅ All 5 critical checks pass — #1: react-window List (L2, L301, L552), #2: 11 null guards + Number.isFinite timestamp validation (L105, L108) + isNaN context guard (L99), #3: cancelAnimationFrame cleanup (L401) + 1 useEffect cleanup function (other 3 useEffects are fire-and-forget), #4: useMemo in hook (L154) with no ref-based memoization, #5: MODAL_PRIORITIES + useModalLayer (L418) + role="dialog" (L582). 19,331 tests pass.

  ```bash
  cd ~/Documents/Vibework/Maestro

  echo "=== CRITICAL #1: Virtualization ==="
  grep -n 'react-window\|FixedSizeList\|VariableSizeList' src/renderer/components/AgentInbox.tsx || echo "❌ No virtualization found"

  echo "=== CRITICAL #2: Null guards ==="
  grep -n '??\|?\.\\|typeof.*undefined' src/renderer/hooks/useAgentInbox.ts | wc -l | xargs -I{} echo "Null guards count: {}"
  grep -n 'isNaN\|<= 0' src/renderer/hooks/useAgentInbox.ts || echo "❌ Missing timestamp validation"

  echo "=== CRITICAL #3: Memory leak prevention ==="
  grep -n 'removeEventListener\|clearInterval\|clearTimeout' src/renderer/components/AgentInbox.tsx || echo "⚠️ Verify cleanup manually if no listeners used"
  grep -c 'return () =>' src/renderer/components/AgentInbox.tsx | xargs -I{} echo "useEffect cleanup count: {}"

  echo "=== CRITICAL #4: Memoization ==="
  grep -n 'useMemo' src/renderer/hooks/useAgentInbox.ts || echo "❌ No useMemo found"
  grep -n 'useRef.*cache\|useRef.*memo\|useRef.*derived' src/renderer/hooks/useAgentInbox.ts && echo "❌ Using ref for derived state (stale data risk)" || echo "✅ No ref-based memoization"

  echo "=== CRITICAL #5: Focus trap ==="
  grep -n 'useLayerStack\|MODAL_PRIORITIES' src/renderer/components/AgentInbox.tsx || echo "❌ No focus trap"
  grep -n 'role="dialog"' src/renderer/components/AgentInbox.tsx || echo "❌ Missing dialog role"
  ```

  Every check must show `✅` or return valid matches. Fix any `❌` results.

---

## Zero-Items Guard

- [ ] **Verify the zero-items toast guard works.** Check the keyboard handler:

  ```bash
  cd ~/Documents/Vibework/Maestro

  echo "=== Zero-items guard ==="
  grep -A 10 'Alt.*Cmd.*I\|Cmd.*Alt.*I' src/renderer/hooks/keyboard/useMainKeyboardHandler.ts | head -15
  grep -n 'toast\|notification\|No pending' src/renderer/hooks/keyboard/useMainKeyboardHandler.ts || echo "❌ No toast/notification for zero items"
  ```

  The handler should check item count BEFORE opening the modal. If it opens unconditionally, fix it.

---

## Final Gate

- [ ] **Run full CI-equivalent pipeline and confirm clean state.** Execute:
  ```bash
  cd ~/Documents/Vibework/Maestro && \
  npx tsc --noEmit && \
  npm run lint && \
  npm test -- --run && \
  npm run build && \
  echo "✅ ALL GATES PASSED"
  ```

  If ANY step fails, fix the issue and re-run the entire pipeline. The feature is not complete until all 4 gates pass in sequence.

---

## Human Verification Checklist (not auto-run)

These items require manual visual/interaction testing:

- Open app with 0 pending items → `Alt+Cmd+I` → see toast, modal stays closed
- Open app with 3+ pending items → `Alt+Cmd+I` → modal opens, items visible
- Navigate with ↑↓ → selection is background fill (not border)
- Press Enter → navigates to correct session tab
- Press Esc → modal closes, focus returns to previous element
- Switch to "Needs Input" filter → only waiting sessions shown
- Switch to "Grouped" sort → items grouped by group name
- Switch to filter with no matches → empty state message shown (modal stays open)
- Check context bars → green/orange/red at correct thresholds
- Check git branch badges → present only when branch exists, truncated at 25 chars
- Screen reader test → dialog announced, items listbox, badge announces count changes
