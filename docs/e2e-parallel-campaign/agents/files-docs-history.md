# files-docs-history

Status: fourth recovery tranche committed

## Scope

File explorer, file preview, document rendering, history.

## Checklist

- [x] Inspect existing related E2E coverage and component surfaces.
- [x] Author deterministic active scenarios for the first recovery tranche.
- [x] Add skipped/env-gated cases for product gaps or unavailable external state.
- [x] Record files touched and scenario counts for the first tranche.
- [x] Commit first tranche work on `codex/e2e-files-docs-history`.
- [x] Author deterministic active scenarios for the second recovery tranche.
- [x] Record files touched and scenario counts for the second tranche.
- [x] Commit second tranche spec work on `codex/e2e-files-docs-history`.
- [x] Author deterministic active scenarios for the third recovery tranche.
- [x] Record files touched and scenario counts for the third tranche.
- [x] Commit third tranche spec work on `codex/e2e-files-docs-history`.
- [x] Author deterministic active scenarios for the fourth recovery tranche.
- [x] Record files touched and scenario counts for the fourth tranche.
- [x] Commit fourth tranche spec work on `codex/e2e-files-docs-history`.

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

### 2026-06-08 second recovery tranche

- Spec commit: `f80d498a9b446888d406c630f27fdc40b023b808`
- Files touched:
  - `e2e/files-docs-history.spec.ts`
  - `docs/e2e-parallel-campaign/agents/files-docs-history.md`
- Shared helpers touched: none. `docs/e2e-parallel-campaign/broadcasts.md` did not need an update.
- Scenario counts:
  - Active matrix rows added: 6
  - Skipped product-gap rows added: 0
  - Env-gated external-state rows added: 0
  - Total matrix rows added: 6
  - Cumulative lane matrix rows: 14 active, 3 skipped, 2 env-gated
- Active coverage IDs:
  - `FDH-A09` File Explorer expand/collapse toolbar controls for nested docs
  - `FDH-A10` File Explorer no-match filter state and recovery
  - `FDH-A11` Confirmed folder deletion removes nested document files
  - `FDH-A12` Folder rename validation for slash/path escape values
  - `FDH-A13` Failed History detail metadata for preview failures
  - `FDH-A14` History full-response search for manual file operation notes
- Checks run:
  - `npx prettier --write e2e/files-docs-history.spec.ts`
  - `npx prettier --check e2e/files-docs-history.spec.ts`
  - `npx eslint e2e/files-docs-history.spec.ts`
  - `npx tsc --noEmit --target ES2020 --lib ES2020,DOM,DOM.Iterable --module ESNext --skipLibCheck --moduleResolution bundler --allowImportingTsExtensions --resolveJsonModule --isolatedModules --strict --noUnusedLocals --noUnusedParameters --noFallthroughCasesInSwitch --types node,@playwright/test e2e/files-docs-history.spec.ts e2e/fixtures/electron-app.ts`
- E2E execution deliberately not run:
  - Did not run `npm run test:e2e`, `playwright test`, headed/UI E2E, or `npx playwright test --list`.
  - Did not use the E2E Runner skill.
- Remaining lane target:
  - Source objective remains about 349 additional active scenarios plus skipped/env-gated rows.
  - First two tranches add 14 active rows, leaving roughly 335 active scenarios to author in later tranches.
- Blockers and follow-up:
  - Product gaps from the first tranche remain skipped until matching product controls exist.
  - External/default-app and SSH remote cases still need orchestrator-provided environment state before activation.
  - Later tranches should continue filling `e2e/files-docs-history.spec.ts` with compact, matrix-backed rows and avoid duplicating the app-shell file operations/history cluster.

### 2026-06-08 third recovery tranche

- Spec commit: `4dbc52938b725465ae94c4495d974d34b6ad591d`
- Files touched:
  - `e2e/files-docs-history.spec.ts`
  - `docs/e2e-parallel-campaign/agents/files-docs-history.md`
- Shared helpers touched: none. `docs/e2e-parallel-campaign/broadcasts.md` did not need an update.
- Scenario counts:
  - Active matrix rows added: 7
  - Skipped product-gap rows added: 0
  - Env-gated external-state rows added: 0
  - Total matrix rows added: 7
  - Cumulative lane matrix rows: 21 active, 3 skipped, 2 env-gated
- Active coverage IDs:
  - `FDH-A15` Successful markdown file rename from the File Explorer context menu
  - `FDH-A16` Successful nested docs folder rename preserving child documents
  - `FDH-A17` Cancelled file delete preserves the selected markdown document
  - `FDH-A18` Confirmed file delete removes only the selected markdown document
  - `FDH-A19` Context-menu Preview opens the archive markdown document
  - `FDH-A20` History filter Escape reset restores all seeded results
  - `FDH-A21` Successful History detail can be marked human-validated
- Checks run:
  - `npx prettier --write e2e/files-docs-history.spec.ts`
  - `npx prettier --write docs/e2e-parallel-campaign/agents/files-docs-history.md`
  - `npx prettier --check e2e/files-docs-history.spec.ts`
  - `npx prettier --check docs/e2e-parallel-campaign/agents/files-docs-history.md`
  - `npx eslint e2e/files-docs-history.spec.ts`
  - `npx tsc --noEmit --target ES2020 --lib ES2020,DOM,DOM.Iterable --module ESNext --skipLibCheck --moduleResolution bundler --allowImportingTsExtensions --resolveJsonModule --isolatedModules --strict --noUnusedLocals --noUnusedParameters --noFallthroughCasesInSwitch --types node,@playwright/test e2e/files-docs-history.spec.ts e2e/fixtures/electron-app.ts`
  - `git diff --check`
- E2E execution deliberately not run:
  - Did not run `npm run test:e2e`, `playwright test`, headed/UI E2E, or `npx playwright test --list`.
  - Did not use the E2E Runner skill.
- Remaining lane target:
  - Source objective remains about 349 additional active scenarios plus skipped/env-gated rows.
  - First three tranches add 21 active rows, leaving roughly 328 active scenarios to author in later tranches.
- Blockers and follow-up:
  - Product gaps from the first tranche remain skipped until matching product controls exist.
  - External/default-app and SSH remote cases still need orchestrator-provided environment state before activation.
  - Later tranches should keep authoring compact, matrix-backed rows in `e2e/files-docs-history.spec.ts` and avoid full E2E validation until the orchestrator opens that phase.

### 2026-06-08 fourth recovery tranche

- Spec commit: `c1b0a1650604daa0a739fc7d702176ad11598331`
- Files touched:
  - `e2e/files-docs-history.spec.ts`
  - `docs/e2e-parallel-campaign/agents/files-docs-history.md`
- Shared helpers touched: none. `docs/e2e-parallel-campaign/broadcasts.md` did not need an update.
- Scenario counts:
  - Active matrix rows added: 6
  - Skipped product-gap rows added: 0
  - Env-gated external-state rows added: 0
  - Total matrix rows added: 6
  - Cumulative lane matrix rows: 27 active, 3 skipped, 2 env-gated
- Active coverage IDs:
  - `FDH-A22` Markdown preview search counts matches and clears with Escape
  - `FDH-A23` Cancelled valid file rename leaves the tree and disk unchanged
  - `FDH-A24` Unchanged folder rename submissions stay disabled
  - `FDH-A25` History type filters isolate user-authored entries
  - `FDH-A26` History detail Previous/Next navigation crosses seeded entries
  - `FDH-A27` Failed History detail deletion removes the entry from the panel
- Checks run:
  - `npx prettier --write e2e/files-docs-history.spec.ts`
  - `npx prettier --check e2e/files-docs-history.spec.ts`
  - `npx eslint e2e/files-docs-history.spec.ts`
  - `npx tsc --noEmit --target ES2020 --lib ES2020,DOM,DOM.Iterable --module ESNext --skipLibCheck --moduleResolution bundler --allowImportingTsExtensions --resolveJsonModule --isolatedModules --strict --noUnusedLocals --noUnusedParameters --noFallthroughCasesInSwitch --types node,@playwright/test e2e/files-docs-history.spec.ts e2e/fixtures/electron-app.ts`
  - `git diff --check`
- E2E execution deliberately not run:
  - Did not run `npm run test:e2e`, `playwright test`, headed/UI E2E, or `npx playwright test --list`.
  - Did not use the E2E Runner skill.
- Remaining lane target:
  - Source objective remains about 349 additional active scenarios plus skipped/env-gated rows.
  - First four tranches add 27 active rows, leaving roughly 322 active scenarios to author in later tranches.
- Blockers and follow-up:
  - Product gaps from the first tranche remain skipped until matching product controls exist.
  - External/default-app and SSH remote cases still need orchestrator-provided environment state before activation.
  - Later tranches should keep adding compact, matrix-backed rows in `e2e/files-docs-history.spec.ts` and defer full E2E validation to the orchestrator-approved phase.

### 2026-06-08 fifth recovery tranche

- Spec commit: `84ab8c295`
- Files touched:
  - `e2e/files-docs-history.spec.ts`
  - `docs/e2e-parallel-campaign/agents/files-docs-history.md`
- Shared helpers touched: none. `docs/e2e-parallel-campaign/broadcasts.md` did not need an update.
- Scenario counts:
  - Active matrix rows added: 5
  - Skipped product-gap rows added: 0
  - Env-gated external-state rows added: 0
  - Total matrix rows added: 5
  - Cumulative lane matrix rows: 32 active, 3 skipped, 2 env-gated
- Active coverage IDs:
  - `FDH-A28` Filtered File Explorer opens nested `plain.txt` preview
  - `FDH-A29` History USER filter toggles manual entries off and back on
  - `FDH-A30` Failed History delete confirmation can be cancelled
  - `FDH-A31` History no-match search clears with Escape
  - `FDH-A32` Folder delete confirmation closes with Escape without deleting children
- Checks run:
  - `npx prettier --write e2e/files-docs-history.spec.ts`
  - `npx eslint e2e/files-docs-history.spec.ts`
  - `npx tsc --noEmit --target ES2020 --lib ES2020,DOM,DOM.Iterable --module ESNext --skipLibCheck --moduleResolution bundler --allowImportingTsExtensions --resolveJsonModule --isolatedModules --strict --noUnusedLocals --noUnusedParameters --noFallthroughCasesInSwitch --types node,@playwright/test e2e/files-docs-history.spec.ts e2e/fixtures/electron-app.ts`
  - `git diff --check`
- E2E execution deliberately not run:
  - Did not run `npm run test:e2e`, `playwright test`, headed/UI E2E, or `npx playwright test --list`.
  - Did not use the E2E Runner skill.
- Remaining lane target:
  - Source objective remains about 349 additional active scenarios plus skipped/env-gated rows.
  - First five tranches add 32 active rows, leaving roughly 317 active scenarios to author in later tranches.
- Blockers and follow-up:
  - Product gaps from the first tranche remain skipped until matching product controls exist.
  - External/default-app and SSH remote cases still need orchestrator-provided environment state before activation.
  - This tranche was authored as an isolated fallback after all tranche-6 PM2 workers failed before editing because the Codex runtime returned 503 service-unavailable responses.
