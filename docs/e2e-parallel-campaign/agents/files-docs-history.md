# files-docs-history

Status: first recovery tranche committed

## Scope

File explorer, file preview, document rendering, history.

## Checklist

- [x] Inspect existing related E2E coverage and component surfaces.
- [x] Author deterministic active scenarios for the first recovery tranche.
- [x] Add skipped/env-gated cases for product gaps or unavailable external state.
- [x] Record files touched and scenario counts for the first tranche.
- [x] Commit first tranche work on `codex/e2e-files-docs-history`.

## Progress

### 2026-06-08 first recovery tranche

- Commit: `6027024d62956238690f2580ad52a25ceb003b09`
- Files touched:
  - `e2e/files-docs-history.spec.ts`
- Shared helpers touched: none. `docs/e2e-parallel-campaign/broadcasts.md` did not need an update.
- Scenario counts:
  - Active matrix rows added: 8
  - Skipped product-gap rows added: 3
  - Env-gated external-state rows added: 2
  - Total matrix rows added: 13
- Active coverage IDs:
  - `FDH-A01` File Explorer nested document filtering
  - `FDH-A02` File context menu affordance coverage
  - `FDH-A03` Rename validation for slash/path escape values
  - `FDH-A04` Cancelled folder delete preserves nested files
  - `FDH-A05` Relative markdown links in preview
  - `FDH-A06` Plain text preview edit/save to disk
  - `FDH-A07` Markdown task, table, and code rendering
  - `FDH-A08` History search by provider session id and detail metadata
- Skipped/product-gap rows:
  - `FDH-S01` Create-new-file toolbar flow: no current File Explorer create-file control.
  - `FDH-S02` Multi-select file operations: current tree models single-node selection/context actions.
  - `FDH-S03` PDF page rendering: inspected preview surfaces do not expose a PDF renderer branch.
- Env-gated rows:
  - `FDH-E01` Real OS default-app handoff requires host app state.
  - `FDH-E02` SSH file browsing requires a reachable configured remote fixture.
- Checks run:
  - `npx prettier --check e2e/files-docs-history.spec.ts`
  - `npx eslint e2e/files-docs-history.spec.ts`
  - `npx tsc --noEmit --target ES2020 --lib ES2020,DOM,DOM.Iterable --module ESNext --skipLibCheck --moduleResolution bundler --allowImportingTsExtensions --resolveJsonModule --isolatedModules --strict --noUnusedLocals --noUnusedParameters --noFallthroughCasesInSwitch --types node,@playwright/test e2e/files-docs-history.spec.ts e2e/fixtures/electron-app.ts`
- E2E execution deliberately not run:
  - Did not run `npm run test:e2e`, `playwright test`, headed/UI E2E, or `npx playwright test --list`.
  - Did not use the E2E Runner skill.
- Remaining lane target:
  - Source objective remains about 349 additional active scenarios plus skipped/env-gated rows.
  - First tranche adds 8 active rows, leaving roughly 341 active scenarios to author in later tranches.
- Blockers and follow-up:
  - Product gaps above should stay skipped until matching product controls exist.
  - External/default-app and SSH remote cases need orchestrator-provided environment state before activation.
  - Later tranches should continue with compact matrix files rather than expanding the already broad `e2e/app-shell.spec.ts`.
