# Phase 08-A: Extract GhostIconButton Component

## Objective

Replace 100+ instances of the ghost icon button pattern (`p-1 rounded hover:bg-white/10 transition-colors`) across 40+ files with a shared `<GhostIconButton>` component.

**Evidence:** `docs/agent-guides/scans/SCAN-COMPONENTS.md`, "Ghost Icon Button Pattern Locations"
**Risk:** Low - pure UI extraction, no logic changes
**Estimated savings:** ~300 lines

---

## Pre-flight Checks

- [x] Phase 07 (session state) is complete
- [x] `rtk npm run lint` passes

---

## Tasks

### 1. Survey pattern variations

- [x] Run: `rtk grep "p-1 rounded hover:bg-white/10" src/renderer/ --glob "*.tsx"` - **57 instances across ~30 files**
- [x] Run: `rtk grep "p-1.5 rounded hover:bg-white/10" src/renderer/ --glob "*.tsx"` - **24 instances across ~12 files**
- [x] Run: `rtk grep "opacity-0 group-hover:opacity-100" src/renderer/ --glob "*.tsx"` (filter for p-1 variants) - **~6 ghost button fade-in instances** (SessionListItem, ProcessMonitor x4, LogFilterControls, LogViewer); many others are tooltips/overlays, not ghost buttons
- [x] Categorize variants: Standard (`p-1`), Larger (`p-1.5`), Fade-in (with `opacity-0 group-hover:opacity-100`), With tooltip
  - **Standard (p-1):** 57 instances - base ghost icon button with `p-1 rounded hover:bg-white/10 transition-colors`
  - **Larger (p-1.5):** 24 instances - larger padding variant
  - **Fade-in:** ~6 instances combining ghost button styling with `opacity-0 group-hover:opacity-100`
  - **With disabled:** ~8 instances include `disabled:opacity-50` or `disabled:opacity-30`
  - **With layout extras:** Several include `shrink-0`, `flex-shrink-0`, `ml-auto`, `flex items-center gap-1`
  - **Custom hover colors:** ~3 instances use `hover:bg-red-500/20` instead (SessionList, ExecutionQueueBrowser) - these may stay custom
  - **Total migratable:** ~81 instances (p-1 + p-1.5 patterns with `hover:bg-white/10`)

### 2. Create the GhostIconButton component

- [x] Create `src/renderer/components/ui/GhostIconButton.tsx`
- [x] Define props interface: `icon`, `size` (`'sm' | 'md'`), `showOnHover`, `tooltip`, `className`, `children`, plus `ButtonHTMLAttributes`
- [x] Implement size mapping: `sm` = `p-1`, `md` = `p-1.5`
- [x] Implement `showOnHover` via `opacity-0 group-hover:opacity-100` class
- [x] Implement optional tooltip wrapper - uses native `title` attribute (consistent with existing codebase pattern)
- [x] Export from the component file - added to `src/renderer/components/ui/index.ts` barrel export

### 3. Write tests for GhostIconButton

- [x] Create `src/__tests__/renderer/components/ui/GhostIconButton.test.tsx`
- [x] Test renders with default props
- [x] Test applies `p-1` for size `sm` and `p-1.5` for size `md`
- [x] Test applies `opacity-0 group-hover:opacity-100` when `showOnHover` is true
- [x] Test passes through button props (`onClick`, `disabled`, `aria-label`)
- [x] Test renders tooltip when `tooltip` prop provided
- [x] Run tests: `CI=1 rtk vitest run src/__tests__/renderer/components/ui/GhostIconButton.test.tsx` - **14 tests pass**

### 4. Migrate high-frequency files first

- [x] Migrate `TabBar.tsx` - find and replace all ghost icon button patterns - **1 instance migrated** (search button `w-6 h-6` variant converted to GhostIconButton)
- [x] Migrate `SessionList.tsx` - **0 migratable**: 2 instances use `p-2` (larger than `md`/`p-1.5`), left as edge cases
- [x] Migrate `RightPanel.tsx` - **0 instances** of ghost icon button pattern found
- [x] Migrate `SymphonyModal.tsx` - **3 of 4 instances migrated** (sync button, refresh button, close button); 1 skipped due to `ref={helpButtonRef}` requiring `forwardRef` support
- [x] For each file: run `CI=1 rtk vitest run <relevant-test>` after migration - **181 tests pass (0 failures)**

### 5. Migrate remaining 36+ files

- [ ] Search for remaining pattern instances: `rtk grep "p-1 rounded hover:bg-white/10" src/renderer/ --glob "*.tsx"`
- [ ] Replace each instance with `<GhostIconButton>` using appropriate props
- [ ] Ensure the `icon` prop matches (most pass a lucide-react icon as child)
- [ ] Run targeted tests after each batch

### 6. Handle edge cases

- [ ] Check for buttons with additional active state classes - add `active` prop if needed
- [ ] Check for buttons with custom hover colors - accept via `className` prop
- [ ] Verify disabled state looks correct on the component

### 7. Verify full build

- [ ] Run lint: `rtk npm run lint`
- [ ] Run tests: `CI=1 rtk vitest run`
- [ ] Verify types: `rtk tsc -p tsconfig.main.json --noEmit && rtk tsc -p tsconfig.lint.json --noEmit`

### 8. Count remaining raw patterns

- [ ] Run: `rtk grep "p-1 rounded hover:bg-white/10" src/renderer/ --glob "*.tsx"` (exclude GhostIconButton)
- [ ] Target: fewer than 5 remaining (edge cases only)

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

- `GhostIconButton` component in `src/renderer/components/ui/`
- 100+ inline patterns replaced
- Unit tests for the component
- Lint and tests pass
