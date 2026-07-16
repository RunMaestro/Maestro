# Stage 15 - CLI Contracts and Transport Helpers

## Objective

Consolidate compatible CLI mechanics while preserving stdout/stderr formats, exit codes, shell-independent parsing, and server command semantics.

## Priorities

- **23:** CLI error-output contracts.
- **68:** Duration formatting.
- **72:** Environment parsing.
- **73:** Cadenza/Movement body and send helpers.

## Dependencies

Stages 02-05 and Stage 03 Bun migration complete. Stage 06 settings CLI work should land first if shared command wrappers overlap.

## CLI invariants

- Machine-readable stdout remains parseable and free of incidental logs.
- Human-readable stderr and exit codes remain stable unless a documented contract correction is approved.
- `--` end-of-options behavior and Unicode dash handling remain correct.
- No shell evaluation is introduced.
- Network/session command helpers preserve timeouts, cancellation, and error envelopes.

## Priority 23 - Error envelopes

1. Inventory every command's success/error stdout, stderr, JSON shape, exit code, throw behavior, and usage-error path.
2. Group only compatible families; command-specific diagnostics and partial-success output stay local.
3. Add subprocess-level contract tests before changing wrappers.
4. Extract narrow helpers for identical JSON/error/exit behavior.
5. Migrate one family per commit and compare exact output bytes.
6. Do not catch programming errors merely to force a generic envelope.

## Priority 68 - Duration formatter

Compare `formatDurationMs` and `formatDurationDecimal` for units, precision, rounding, thresholds, zero, negatives, and localization. Add table tests from actual CLI outputs. Replace only after exact parity or an approved output change; preserve stable snapshots/help text.

## Priority 72 - Environment parsing

Extract pure parsing of relevant CLI environment variables: absent/empty, booleans, numbers, paths, delimiters, casing, and invalid values. Keep process environment access at the command boundary so tests pass plain records. Do not parse secrets into logs. Add table tests and migrate compatible commands.

## Priority 73 - Cadenza/Movement send helpers

Compare request body fields, command discriminants, target/session resolution, transport, timeout, response, and error mapping. Extract a typed body builder and send core only for identical transport policy. Keep domain operations/types explicit. Test success, invalid body, missing target, server unavailable, timeout, and server rejection for both command families.

## Verification

- Subprocess tests assert exact stdout, stderr, and exit status.
- `--` and quoted/Unicode-dash message cases pass.
- Commands run against a local Maestro instance for real transport smoke.
- Cadenza and Movement dispatch produce the same server-observed payloads.
- Help output and examples remain accurate.
- CLI TypeScript build and package entry point execute under Bun.

## Rollback

Revert per command family. Keep helpers and all migrated callers consistent; do not reintroduce duplicate wrappers as compatibility shims.

## Exit criteria

All four priorities have evidence-backed dispositions; compatible commands share exact mechanics; output and exit contracts are characterized and preserved; real CLI-to-Maestro smoke passes.

## Investigated execution cards

|   P | Observed contract                                                                                                                        | Canonical target/order                                                                                                                                            | Focused proof / rollback                                                                                              |
| --: | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
|  23 | `src/cli/commands/agent-start.ts` and `mcp.ts` share success/failure text shapes but stdout, stderr, JSON, and exit behavior may differ. | Capture exact subprocess golden outputs; extract only byte-identical writer/envelope; migrate simplest success/failure path, then remaining commands.             | CLI tests for human/JSON, TTY/non-TTY, daemon absent, validation, IPC error. Revert per command family.               |
|  68 | Duration formatting repeats in CLI commands/utilities with potentially different rounding and sentinel copy.                             | Build input/output matrix; create CLI-local formatter with explicit unit/rounding policy only for identical rows; migrate callsites.                              | Table tests for negative/zero/subsecond/minute/hour/day/infinite and exact output snapshots.                          |
|  72 | Shell-independent parsing/error transport repeats across CLI entry/commands.                                                             | Add typed CLI result/error envelope and presentation adapter after P23 characterization; migrate one command vertical slice before broader use.                   | Spawn real CLI for success/usage/invalid/daemon-down/timeout; assert stdout/stderr/status and shell independence.     |
|  73 | `src/main/server/Server.ts` command handlers repeat request decode/dispatch/response mechanics but own distinct operations.              | Add server-local typed command registration helper with validator and error mapping; migrate read-only commands, then mutations; retain stream/cancel exceptions. | Server/CLI integration tests for malformed, unknown, concurrent, disconnect, thrown error; real CLI-to-Maestro smoke. |
