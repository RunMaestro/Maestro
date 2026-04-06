# Phase 08-B: Extract Spinner Component

## Objective

Replace 95+ `<Loader2 className="... animate-spin" />` instances across 43 files with a shared `<Spinner>` component.

**Evidence:** `docs/agent-guides/scans/SCAN-COMPONENTS.md`, "Spinner Instances"
**Risk:** Low - pure UI extraction
**Estimated savings:** ~200 lines

---

## Pre-flight Checks

- [x] Phase 08-A (GhostIconButton) is complete - **All 8 sections checked off, 77 instances migrated, 0 raw patterns remain**
- [x] `rtk npm run lint` passes

---

## Tasks

### 1. Survey spinner variations

- [x] Run: `rtk grep "Loader2" src/renderer/ --glob "*.tsx"` (filter for `animate-spin`) - **87 `<Loader2>` usages across 45 files (86 spinning, 1 static)**
- [x] Categorize by size: xs (`w-3 h-3`), sm (`w-4 h-4`), md (`w-5 h-5`), lg (`w-6 h-6` or `w-8 h-8`)
  - **xs (`w-3 h-3`):** 22 instances - AboutModal, SymphonyModal(5), DeleteWorktreeModal, FeedbackChatView(4), CueAiChat, DocumentGraphView(2), HistoryStatsBar, NotificationsPanel, SendToAgentModal, SshRemoteModal, MergeProgressOverlay, SummarizeProgressOverlay, AgentSessionsBrowser, AITab
  - **`w-3.5 h-3.5` (not in original map):** 8 instances - FeedbackChatView, AutoRunToolbar, AutoRunExpandedModal, FilePreviewHeader, AIOverviewTab, LeaderboardRegistrationModal, ToolCallCard, UnifiedHistoryTab. **Recommend adding as size variant or mapping to className passthrough.**
  - **sm (`w-4 h-4`):** 33 instances - largest group. AgentCreationDialog, AboutModal, CreateWorktreeModal, CreatePRModal(2), BatchRunnerModal, DirectorNotesModal, DocumentGraphView, FeedbackChatView(2), LeaderboardRegistrationModal(2), MainPanel, MarketplaceModal, SendToAgentModal, SymphonyModal, TransferErrorModal, UpdateCheckModal(2), WorktreeConfigModal(2), SshRemotesSection(2), SshRemoteModal, DocumentEditor, MarkdownRenderer, AttachmentImage, MarkdownImage, WizardPill, DocumentGenerationView, RightPanel, AgentSessionsBrowser(2)
  - **md (`w-5 h-5`):** 6 instances - SshRemotesSection, PhaseReviewScreen(2), TransferProgressModal, AgentSessionsBrowser, SymphonyModal
  - **`w-6 h-6` (grouped with lg):** 9 instances - AgentCreationDialog, AgentSessionsBrowser(2), DebugPackageModal, FileExplorerPanel, FeedbackChatView(2), MarketplaceModal, SymphonyModal
  - **lg (`w-8 h-8`):** 6 instances - DebugPackageModal, DocumentGraphView, DirectorNotesModal, UpdateCheckModal, MainPanel, AIOverviewTab
  - **`size={14}` (Lucide prop):** 2 instances - TriggerNode, NodeConfigPanel. These use Lucide's numeric `size` prop instead of className.
  - **Static (no animate-spin):** 1 instance - TransferErrorModal:108 (not a spinner, skip migration)
- [x] Note any instances with extra classes beyond size (e.g., color)
  - **`style={{ color: theme.colors.accent }}`** - ~12 instances (AgentCreationDialog, DebugPackageModal, DocumentGraphView, FeedbackChatView(2), FileExplorerPanel, MarketplaceModal, SshRemotesSection, UpdateCheckModal, AIOverviewTab, FeedbackChatView:904, DocumentGraphView:2044)
  - **`style={{ color: theme.colors.textDim }}`** - ~8 instances (AboutModal, AgentSessionsBrowser(2), DirectorNotesModal, MarkdownImage, AttachmentImage, DocumentEditor, MarkdownRenderer, DocumentGenerationView)
  - **`style={{ color: theme.colors.warning }}`** - 1 instance (ToolCallCard)
  - **`shrink-0`** - 2 instances (TransferErrorModal, AITab)
  - **`ml-1` / `ml-auto`** - 2 instances (SymphonyModal:2053, AgentSessionsBrowser:1259)
  - **`mx-auto`** - 2 instances (AgentSessionsBrowser:1110, MainPanel:1660)
  - **`mx-auto mb-3`** - 1 instance (AIOverviewTab:354)
  - **`aria-hidden="true"`** - 1 instance (SendToAgentModal:726)
  - **Note:** ~18 instances are multiline (Loader2 tag and className on separate lines). All follow the same pattern and are migratable.

### 2. Create the Spinner component

- [x] Create `src/renderer/components/ui/Spinner.tsx`
- [x] Define props: `size` (`'xs' | 'sm' | 'md' | 'lg'`, default `'sm'`), `className` - **Also added `style` prop for theme-based color passthrough**
- [x] Define size class map: xs=`w-3 h-3`, sm=`w-4 h-4`, md=`w-5 h-5`, lg=`w-8 h-8`
- [x] Render `<Loader2>` with `animate-spin` plus the size class and optional className
- [x] Export from the component file - **Exported `Spinner`, `SpinnerProps`, `SpinnerSize` from `ui/index.ts`**

### 3. Write tests for Spinner

- [x] Create `src/__tests__/renderer/components/ui/Spinner.test.tsx` - **Created in prior session**
- [x] Test renders with each size variant (xs, sm, md, lg) - **4 tests: xs(w-3 h-3), sm(w-4 h-4 default), md(w-5 h-5), lg(w-8 h-8)**
- [x] Test applies additional className - **2 tests: className passthrough and merge with size+animate-spin**
- [x] Test renders Loader2 with animate-spin class - **2 tests: default animate-spin and all-sizes loop**
- [x] Run tests: `CI=1 rtk vitest run src/__tests__/renderer/components/ui/Spinner.test.tsx` - **10/10 pass**

### 4. Migrate top offender files

- [x] Migrate `SymphonyModal.tsx` (9 instances) - replace `<Loader2 className="w-4 h-4 animate-spin" />` with `<Spinner size="sm" />` - **9 instances migrated: 3 xs (status icons), 1 xs+accent, 1 lg+accent, 1 sm, 1 xs+ml-1, 1 md+textDim. Removed Loader2 import, added Spinner import from `./ui`.**
- [x] Migrate `AgentSessionsBrowser.tsx` (7 instances) - **7 instances migrated: 1 md+mx-auto+textDim, 2 lg+textDim, 1 xs+ml-auto+textDim, 1 sm+textDim, 1 sm+accent. Removed Loader2 import, added Spinner import from `./ui`.**
- [x] Migrate `DocumentGraphView.tsx` (5 instances) - **4 spinning instances migrated (1 lg+accent, 1 sm, 1 xs, 1 xs+accent). Removed Loader2 import, added Spinner import from `../ui`. Note: file is in DocumentGraph/ subdirectory.**
- [x] Run targeted tests after each file: `CI=1 rtk vitest run <relevant-test>` - **269/272 pass. 3 pre-existing failures in formatNumber helper (unrelated to Spinner migration). Spinner.test.tsx: 10/10 pass.**

### 5. Migrate remaining 40 files

- [x] Work through all 43 files, mapping each Loader2 size to the appropriate prop: `w-3 h-3` to `xs`, `w-4 h-4` to `sm`, `w-5 h-5` to `md`, `w-6 h-6` to `lg`, `w-8 h-8` to `xl`
  - **Extended Spinner size map:** Added `lg` (w-6 h-6) and `xl` (w-8 h-8) to properly cover all codebase sizes. Changed `lg` from w-8 h-8 to w-6 h-6 (correct ascending order), added `xl` for w-8 h-8. Fixed 1 already-migrated file (DocumentGraphView: lg to xl).
  - **43 files migrated across 5 parallel agents:**
    - Batch 1 (11 files, 21 instances): BatchRunnerModal, CreatePRModal, CreateWorktreeModal, WorktreeConfigModal, SshRemoteModal, SshRemotesSection, LeaderboardRegistrationModal, MarketplaceModal, UpdateCheckModal, AgentCreationDialog
    - Batch 2 (7 files, 9 instances): DeleteWorktreeModal, CueAiChat, HistoryStatsBar, NotificationsPanel, SendToAgentModal, AboutModal, DirectorNotesModal
    - Batch 3 (9 files, 11 instances): MergeProgressOverlay, SummarizeProgressOverlay, TransferProgressModal, RightPanel, AITab, MainPanel, DebugPackageModal, FileExplorerPanel, TransferErrorModal (kept static Loader2 at line 109)
    - Batch 4 (15 files, 17 instances): AutoRunExpandedModal, AutoRunToolbar, FilePreviewHeader, AIOverviewTab, UnifiedHistoryTab, ToolCallCard, AttachmentImage, DocumentEditor, DocumentGenerationView, MarkdownImage, MarkdownRenderer, WizardPill, PhaseReviewScreen, TriggerNode, NodeConfigPanel
    - FeedbackChatView (1 file, 9 instances)
  - **TransferProgressModal special case:** file has a local `Spinner` component (animated ring with wand icon), so imported shared Spinner as `SpinnerIcon` alias.
  - **w-3.5 h-3.5 instances (8):** Handled with `<Spinner size="xs" className="w-3.5 h-3.5" />` (Tailwind CSS override - w-3.5 declared after w-3 in stylesheet, so it wins).
  - **size={14} instances (2, TriggerNode + NodeConfigPanel):** Converted to `<Spinner size="xs" className="w-3.5 h-3.5" />` (14px = w-3.5 in Tailwind).
- [x] For instances with additional classes beyond size (e.g., color), pass them via `className` - **Extra classes (shrink-0, ml-1, mx-auto, etc.) passed via className; theme-based styles passed via style prop**
- [x] Run targeted tests after each batch - **Spinner.test.tsx: 11/11 pass. Full suite: 19 test files fail (all pre-existing, 0 new failures from migration)**

### 6. Remove orphaned Loader2 imports

- [x] Run: `rtk grep "import.*Loader2" src/renderer/ --glob "*.tsx"` - **Only 1 remaining: Spinner.tsx itself (the wrapper). TransferErrorModal keeps Loader2 for its static (non-spinning) icon.**
- [x] For each file: check if Loader2 is still used; if not, remove the import - **All Loader2 imports removed from migrated files during migration. TransferErrorModal correctly retains import for static usage.**
- [x] Run lint to catch any missed unused imports: `rtk npm run lint` - **lint passes (ok)**

### 7. Verify full build

- [x] Run lint: `rtk npm run lint` - **passes**
- [x] Run tests: `CI=1 rtk vitest run` - **23526 passed, 55 failed (all pre-existing), 107 skipped. 0 new failures from Spinner migration.**
- [x] Verify types: `rtk tsc -p tsconfig.main.json --noEmit && rtk tsc -p tsconfig.lint.json --noEmit` - **both pass**

### 8. Count remaining raw Loader2 usages

- [x] Run: `rtk grep "Loader2.*animate-spin" src/renderer/ --glob "*.tsx"` (exclude Spinner component file) - **0 remaining (only Spinner.tsx itself references Loader2 + animate-spin)**
- [x] Target: 0 remaining - **ACHIEVED**

---

## Verification

After completing changes, run targeted tests for the files you modified:

```bash
CI=1 rtk vitest run <path-to-relevant-test-files>
```

**Rule: Zero new test failures from your changes.** Pre-existing failures on the baseline are acceptable.

Find related test files:

```bash
rtk grep "import.*from.*<module-you-changed>" --glob "*.test.*"
```

Also verify types:

```bash
rtk tsc -p tsconfig.main.json --noEmit
rtk tsc -p tsconfig.lint.json --noEmit
```

---

## Success Criteria

- `Spinner` component in `src/renderer/components/ui/`
- 95+ inline Loader2 usages replaced
- Orphaned Loader2 imports removed
- Lint and tests pass
