# Maestro-lib: Part One Checklist

Source: `Maestro lib plan.md` (Pedram, shared desktop-free agent spawn library).
Full plan has three parts; this tracks **Part One** only - establish the
library boundary and move the settled, provider-neutral pieces with **zero
user-visible behavior change**. Run, session, and streaming are Part Two.
Cue-on-a-server is a separate, later effort.

## Action Items

- [x] Create Maestro definitions and capability flags.
- [x] Move all per-provider output parsers into the library with existing
      tests unchanged.
- [x] Move environment layering, shell-path detection, and remote host
      handling while preserving existing ordering and behavior.
- [x] Convert existing agent spawners, Cue spawn builder, and Cue executor
      into thin library pass-throughs.
- [x] Run existing tests and verify the no-desktop-framework smoke test and
      Windows behavior.
- [ ] macOS binary lookup. NOT verified by this pass, which is why it is split
      out of the item above: that item claimed it while the Known gaps section
      below recorded it as unverified. It was picked up later by separate work
      rather than here, so the box stays unchecked for Part One. See #1631,
      which checked it on real Apple Silicon hardware against a live Copilot
      install and found a detection bug in the process (both known-path tables
      were keyed by agent id while the lookup passes a binary name, so none of
      Copilot's candidates was ever probed); open PR #1643 carries that fix
      into the library copy.

## What actually moved

Library root: `src/shared/maestro-lib/` (chosen over a new top-level
`packages/` workspace because `src/shared/**` is already included by both
`tsconfig.main.json` and `tsconfig.cli.json` - zero build/workspace config
changes needed to make the library importable from both desktop main and the
CLI bundle).

| Piece                       | Old path                              | New path                                             |
| --------------------------- | ------------------------------------- | ---------------------------------------------------- |
| Provider definitions        | `src/main/agents/definitions.ts`      | `src/shared/maestro-lib/providers/definitions.ts`    |
| Capability flags            | `src/main/agents/capabilities.ts`     | `src/shared/maestro-lib/providers/capabilities.ts`   |
| Output parsers (14 files)   | `src/main/parsers/*.ts`               | `src/shared/maestro-lib/parsers/*.ts`                |
| Binary detection            | `src/main/agents/path-prober.ts`      | `src/shared/maestro-lib/launch/path-prober.ts`       |
| Shell PATH probing          | `src/main/runtime/getShellPath.ts`    | `src/shared/maestro-lib/launch/getShellPath.ts`      |
| Argument building           | `src/main/utils/agent-args.ts`        | `src/shared/maestro-lib/launch/agent-args.ts`        |
| Remote (SSH) spawn wrapping | `src/main/utils/ssh-spawn-wrapper.ts` | `src/shared/maestro-lib/launch/ssh-spawn-wrapper.ts` |

Every old path above is now a one-line re-export shim
(`export * from '<new path>'`). This is deliberate and matches the plan's own
Part One rule verbatim: "Leave every existing caller calling what it calls
today. Each old entry point becomes a thin pass-through to the library."

That includes the three callers named in the action items -
`src/cli/services/agent-spawner.ts`, `src/main/cue/cue-spawn-builder.ts`, and
`src/main/cue/cue-executor.ts`. An earlier pass in this session tried
redirecting their import lines straight at the new library paths (skipping
the shim). That was reverted: several existing tests
(`agent-spawner.test.ts`, `cue-spawn-builder.test.ts`, `cue-shell-executor.test.ts`,
`cue-executor.test.ts`) `vi.mock()` these dependencies **by the caller's old
import specifier**, and redirecting the caller's own import breaks that mock
without changing any real behavior - exactly the kind of accidental
behavior/test change Part One is supposed to avoid. So "conversion into thin
library pass-throughs" for these three files is satisfied transitively: their
imports are untouched, and those old paths are now thin re-export shims into
the library, which is what makes them pass-throughs.

## Known gaps / deliberately not done in this pass

- `ssh-spawn-wrapper.ts` still depends on `src/main/utils/ssh-remote-resolver.ts`
  and `src/main/utils/ssh-command-builder.ts`, which stayed in `main/utils`
  (the command builder alone is ~700 lines and pulls in `process-manager`
  image-prompt helpers - out of scope for this pass). The library's remote
  wrapping is therefore not yet fully free of `main/`; full extraction is
  follow-up work, matching the plan's own "roughly a third of the effort will
  go to things not written down yet" caveat.
- The moved parsers still reach back into `src/main/utils/{logger,sentry,terminalFilter}`
  and `src/main/agents/capability-snapshot.ts`. None of them imports Electron at
  module scope, so they don't break the "no desktop framework" smoke test, which
  is a source scan for import specifiers. `sentry.ts` is the one that is not
  Electron-free: it does `await import('@sentry/electron/main')` at `:57`, `:82`
  and `:116`, and `src/shared/maestro-lib/launch/path-prober.ts` reaches it
  through `captureException` (`:25`, called at `:235` and `:325`). Because those
  imports are deferred and wrapped in try/catch, a standalone program still
  loads and still runs; it simply does not report to Sentry. These reach-backs
  are not yet part of the library proper.
- Desktop's own callers (IPC process handlers, group chat, cross-agent router)
  were left importing the old paths (now shims) rather than redirected, since
  they weren't named in the action items and desktop chat's migration is Part
  Two scope per the plan.
- Run, session capture, resume, and the streaming/completion-helper contract
  are explicitly Part Two/Three - not touched here.
- Two parser findings raised in review are recorded here rather than fixed,
  because both are pre-existing behavior rather than anything this pass
  introduced. Both files were diffed against their `rc` originals and differ
  only in import paths, so Part One's "zero behavior change" rule and
  its gate ("if a test must be edited, it is a behavior change and belongs
  later") both put these after Part One:
  - `opencode-output-parser.ts` drops `part.callID` when it builds a
    `tool_use` event. `OpenCodePart.callID` is declared for exactly that
    purpose and `ParsedEvent.toolCallId` exists, with codex, antigravity and
    copilot all populating it, so the id a consumer would merge repeated
    lifecycle updates on never reaches it. The review reports the effect as
    duplicate tool entries; that consequence was not traced through the
    consumer here, only the dropped field confirmed. A one-line fix, but it
    changes emitted events.
  - `factory-droid-output-parser.ts` emits a `result` event with empty text
    when a completion carries no `finalText`. The review asked for empty
    completions to be routed to the parser's error handling; that is declined
    on principle rather than deferred. Deciding whether an empty answer is a
    failure is the completion contract's job (`strictEmptyAnswer`), and the
    library's rule is that it reports facts and never emits a verdict. Putting
    a second rule in the parser is the divergence Part Two exists to remove.

## Verification performed

- [x] `npm run lint` (tsc, all three configs: main, cli, lint/renderer) - clean.
- [x] `npm run test` (full vitest suite).
- [x] Added `src/shared/maestro-lib/__tests__/no-desktop-framework.smoke.test.ts` -
      imports the library's public surface and asserts no `electron` module is
      required transitively.
- [x] Windows: this session ran on Windows - `npm run test` and `npm run lint`
      both executed on Windows directly.

### A real gap the test run caught (fixed, not just noted)

Physically moving a file changes which _internal_ dependency a test's
`vi.mock()` needs to target when that dependency ITSELF also moved. Example:
`claude-output-parser.ts` imports `error-patterns.ts` via a sibling path
(`./error-patterns`) - both moved together into `maestro-lib/parsers/`. A test
that constructs a real `ClaudeOutputParser` and mocks `error-patterns` **by
its old `src/main/parsers/error-patterns` path** no longer intercepts
anything, because the parser's sibling import now resolves straight to the
new file, bypassing the old-path shim entirely. This surfaced as a genuine,
reproducible test failure (`StdoutHandler.test.ts`, only when the whole file
ran, not in isolation) - not a flake.

Fix applied: every `vi.mock()` (and the one `vi.importActual()`) across the
test suite that targeted one of the seven moved-file groups by its **old**
path was mechanically retargeted to the new `maestro-lib` path (28 mock calls
across 22 test files, e.g. `ExitHandler.test.ts`, `StderrHandler.test.ts`,
`session-recovery.test.ts`, `cue-spawn-builder.test.ts`,
`spawnGroupChatAgent.test.ts`, `process.test.ts`, `context-groomer.test.ts`).
This is safe and not a behavior change: mocking the real (new) absolute file
also transparently satisfies any _other_ caller reaching it through the old
shim, since `export * from` forwards live bindings from the same module
instance. Verified by re-running every affected file individually plus the
full suite.

- [ ] macOS binary lookup: **not verified in this session** (no macOS runner
      available here). `probeUnixPaths`/`getUnixKnownPaths` logic was moved
      byte-for-byte with no changes, so behavior should be unchanged, but per
      the plan this still needs a real check on CI/hardware before Part One is
      considered fully closed.
- [ ] Linux CI: not run locally; relies on the project's CI matrix on push.
