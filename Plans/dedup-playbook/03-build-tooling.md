# Stage 03 - Build, Packaging, CI, and Script Consolidation

## Objective

Consolidate repeated build/network/CDP/native verification plumbing while preserving artifact bytes, package resources, architecture checks, and CI behavior.

## Priorities

**11, 12, 24, 25, 26, 27, 28, 29, 46, 47, 48, 105**

## Dependencies

Stages 00-02 complete. Run this stage before CLI and final integration work because it defines canonical Bun/build verification.

## Global invariants

- Artifact entry points, formats, externals, banners, sourcemaps, output paths, and executable bits remain unchanged unless explicitly approved.
- Packaging resources are compared in unpacked and packaged outputs.
- Native checks cover host and release target architectures.
- Bun/Bunx migration must preserve lifecycle scripts and environment propagation.
- Generated lockfile changes are reviewed, not accepted blindly.

## Work packages

### A. Esbuild helpers - priorities 11 and 25

1. Inventory all esbuild invocations and create a field-by-field option matrix.
2. Separate invariant options from artifact-specific entry/output/platform/format/external settings.
3. Characterize all three reported artifacts by output file list, byte hash where deterministic, import surface, and runtime smoke.
4. Create one parameterized helper under `scripts/lib/build.mjs` with an explicit options type/JSDoc contract.
5. Migrate one artifact, compare output, then migrate the others.
6. Keep artifact-specific configuration at callsites; do not create boolean-option soup.
7. Verify Electron loads the rebuilt main artifact, not stale incremental output.

### B. Refresh HTTP helper - priority 24

1. Compare redirect handling, status checks, timeout, headers, proxy behavior, response encoding, and error messages in each refresh script.
2. Add characterization tests using a local HTTP server for success, redirect, non-2xx, timeout, and truncated response.
3. Extract `scripts/lib/http.mjs::httpsGet` only for compatible policies.
4. Preserve script-specific parsing and destination updates at callsites.
5. Run each refresh script in dry-run or temporary-output mode and compare output.

### C. CDP helpers - priority 26

1. Inventory port discovery, endpoint polling, target selection, timeout, process launch, and cleanup.
2. Extract only the shared CDP connection/readiness core into `scripts/lib/cdp.mjs`.
3. Preserve command-specific browser target and evaluation behavior.
4. Test no-endpoint, delayed endpoint, multiple targets, connection loss, and cleanup.

### D. Native architecture verification - priorities 27 and 28

1. Compare `verify-native-arch.sh`, `rebuild-and-verify-native.sh`, and release workflow steps.
2. Define one parameterized verifier with modes such as verify-only and rebuild-then-verify.
3. Preserve platform-specific binary discovery and clear failure messages.
4. Update `release.yml` to call the canonical script instead of inlining logic.
5. Exercise supported architecture combinations or inspect produced artifacts in CI matrices.
6. Fail when a required binary is missing, wrong-architecture, or silently rebuilt for the host instead of target.

### E. Packaging resources - priority 12

1. Build unpacked packages before editing and inventory included resources with source provenance.
2. Compare repeated Electron Builder resource lists and determine whether they are truly identical per platform/target.
3. Extract one canonical list only for invariant resources; keep platform-specific resources explicit.
4. Build unpacked and packaged outputs after migration.
5. Launch the packaged application and exercise icons, preload, first-party plugins, prompts, native modules, and CLI bridge.

### F. Bun/Bunx migration - priorities 29 and 46

1. Record every npm/npx command, working directory, environment, lifecycle side effect, PATH behavior, and lockfile expectation.
2. Convert `dev.mjs` and `set-version.mjs` first; verify version-file changes and dev process startup/teardown.
3. Convert CI matrix steps only after local parity.
4. Use `bun`/`bunx` directly; do not emulate npm behavior with shell wrappers.
5. Verify clean checkout install, cached install, scripts, native rebuild, tests, build, and package in CI.
6. Review lockfile diff and remove obsolete package-lock assumptions.

### G. Build artifacts and chunking - priorities 47 and 48

**Build icon archives:** trace package config, installer assets, release scripts, design docs, and dynamic paths. Delete only artifacts with zero consumer and a successful packaged-icon inspection.

**Web-desktop chunks:** capture bundle analyzer/output before changes. Confirm manual chunks are actually redundant or harmful. Change only with measured size/load improvement and browser smoke; otherwise record `retain`.

### H. Dead dependency - priority 105

1. Search package scripts, workflows, source imports, dynamic invocations, and documentation for `concurrently`.
2. Remove it only after zero-consumer proof.
3. Run clean `bun install`, relevant scripts, lockfile check, and CI-equivalent build.

## Verification matrix

| Concern             | Required proof                                           |
| ------------------- | -------------------------------------------------------- |
| Esbuild             | All artifacts build and execute; options/output compared |
| HTTP refresh        | Success/redirect/error/timeout characterization          |
| CDP                 | Readiness, selection, failure, cleanup                   |
| Native              | Correct architecture in release matrix                   |
| Packaging           | Unpacked + packaged launch and resource smoke            |
| Bun migration       | Clean install, scripts, tests, build, package            |
| Chunking            | Before/after output evidence and browser smoke           |
| Dependency deletion | Zero consumers and clean lockfile install                |

## Rollback

Keep helper extraction and caller migrations in one revertible sequence. Packaging/CI changes revert independently from source refactors. Preserve before-change artifact inventories for comparison.

## Exit criteria

All 12 priorities have evidence-backed `implemented`, `retained`, or `rejected` dispositions; CI and package matrices pass; no artifact or native verification coverage is lost.

## Investigated execution cards

|   P | Observed source                                                                                                                                                                     | Chosen target and migration                                                                                                                      | Focused proof / rollback                                                                                                                            |
| --: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
|  11 | `scripts/build-cli.mjs`, `build-maestro-p.mjs`, `build-permission-relay-bridge.mjs` repeat esbuild setup with artifact-specific entries/externals.                                  | Make `scripts/lib/build.mjs` accept explicit entry/output/platform/format/externals; migrate one script at a time, preserving its local options. | Run the three `bun run build:*` scripts and execute/import each artifact. Revert the affected caller plus helper change if output differs.          |
|  12 | Repeated Electron Builder `extraResources`/resource arrays in `package.json` build targets.                                                                                         | Extract only byte-identical resources into one JSON object/list; keep platform resources local.                                                  | `bun run build`, unpacked/package build for the host, launch, and inspect prompts/plugins/icons/native modules. Revert packaging config atomically. |
|  24 | `scripts/refresh-{bmad,openspec,speckit}.mjs` carry repeated redirect/status/error `httpsGet`.                                                                                      | Add `scripts/lib/http.mjs::httpsGet`; keep parsing/write logic in each refresh script.                                                           | New `scripts/__tests__/http.test.ts` local-server cases; run all refresh scripts to temporary output and compare bytes.                             |
|  25 | The same three build scripts duplicate the esbuild skeleton beyond P11's initial artifact helper.                                                                                   | Complete migration to `scripts/lib/build.mjs`; reject options that serve only one caller.                                                        | Same artifact matrix as P11 plus `bun run format:check:all`; revert as one helper/caller set.                                                       |
|  26 | CDP connect/readiness/target-selection code repeats across `scripts/cdp-connect.mjs` and other CDP dev scripts.                                                                     | Add `scripts/lib/cdp.mjs` for endpoint polling and connection; leave target/evaluation commands local.                                           | Proposed `scripts/__tests__/cdp.test.ts` for delayed/multiple/no targets plus a real dev CDP smoke.                                                 |
|  27 | `.github/scripts/verify-native-arch.sh` and `rebuild-and-verify-native.sh` repeat discovery/architecture checks for `pty.node`, `better_sqlite3.node`, and Windows conpty binaries. | One parameterized script with verify-only/rebuild-then-verify modes.                                                                             | Run both modes on host and release CI architectures; wrong-arch fixture must fail. Revert script and callers together.                              |
|  28 | `.github/workflows/release.yml` repeats native checks across Windows, Linux, and Linux ARM64 matrix branches.                                                                       | Call the P27 script with matrix parameters; retain platform-only file names explicitly.                                                          | Run/observe every release matrix job and inspect artifact architectures. Revert workflow independently if matrix parity fails.                      |
|  29 | `scripts/dev.mjs` and `set-version.mjs` invoke npm/shell command strings despite Bun policy.                                                                                        | Replace exact npm/npx operations with Bun/Bunx argv and explicit cwd/env; no shell interpolation.                                                | Dev start/stop, version dry-run/package command, clean install, and lockfile check. Revert each script independently.                               |
|  46 | `.github/workflows/ci.yml` still uses npm/npx in install/build/test paths.                                                                                                          | Convert matrix steps after P29 parity; use existing package scripts through `bun run`.                                                           | Full CI matrix from clean checkout, cache hit/miss, native postinstall, tests, and build. Workflow-only rollback.                                   |
|  47 | `build/new-icon/` and `build/archive/` have no proven package/source consumer.                                                                                                      | Trace package resources and release/design scripts; delete only zero-consumer files.                                                             | Host package icon/resource inspection and repository reference search. Restore directory if any packaged target loses assets.                       |
|  48 | `vite.config.web-desktop.mts` contains manual chunk policy not justified by measured output.                                                                                        | Capture bundle graph; change only duplicated/fragmented chunks with measured improvement, otherwise mark retain.                                 | `bun run build:web-desktop`, compare chunk graph/size, serve output, browser smoke routes and lazy imports.                                         |
| 105 | `package.json` declares unused `concurrently`; no package script, workflow, or source call was found.                                                                               | Remove dependency and lock entry after a final dynamic/docs search.                                                                              | Clean `bun install`, `bun run validate:push`, dev script smoke. Restore dependency if any script resolution fails.                                  |
