# Vitest micro-suite reconciliation onto rc

## Base and scope

The cleanup branch is based on rc commit `ccd7cbd594f21e80ac978290b97b247accec9347`.
The consolidation was reconstructed from the current test sources at the earlier
rc commit `ef1f51c3cf868fc7c0ff8f19e7eaeedafe570c02`, then rebased onto the newer rc.
None of the newer rc changes overlap the 511 consolidated source files. The newer
bridge tests and assertions therefore remain intact. Inherited Lite feature changes
are not part of this change.

- Consolidate 511 source files into 113 test files: 398 fewer file-isolation boundaries.
- Preserve all 10,087 tests in those source files, including their complete test names.
- Retain 138 candidates as separate files where merging would compromise isolation:
  85 mock/dependency/size conflicts, 49 mock factories capturing non-hoisted file state,
  three collection-time global mutations, and one runtime module-registry mutation.
- Do not resurrect `shared/cli-server-discovery.test.ts` or `shared/userDataDir.test.ts`,
  which rc had already deleted.
- Restore `maxWorkers: 8` while retaining rc's forks pool, separate node/jsdom projects,
  and inherited-environment sanitization. No production code, test exclusions,
  timeouts, or assertions are changed. Consolidated mock factories retain their behavior.

Each merged file identifies its source files in comments. Each source's ordinary
module-local state and hooks remain inside a separate unnamed suite, preserving
existing test names and preventing hooks from applying to neighboring sources.
Static imports and `vi.hoisted` state stay at module scope. Colliding bindings use
source-specific aliases; component aliases retain JSX component capitalization.
Module mocks are shared only when their factories and dependency graphs are compatible.

On the refreshed rc base, a combined runtime run of all 113 consolidated files
and all six new or changed upstream bridge test files passed: 10,310 tests across
119 files. The 10,087 consolidated test names and multiplicities still match their
original rc inputs exactly, and the whole-source structural audit still preserves
all 511 bodies, imports, mocks, and hoisted state.

## Verification

| Check                                                                                             | Observed result                                        |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Affected suites in the actual Vitest forks runtime                                                | 10,087 passed across 113 files                         |
| Runtime test-name multiset, compared per merged output against its rc inputs                      | Zero missing or extra tests                            |
| Structural AST multiset of complete test callbacks and assertion calls                            | 45,533 calls preserved; zero missing or extra          |
| Whole-source structural audit, including hooks, helpers, imports, module mocks, and hoisted state | All 511 source bodies and headers preserved            |
| `npm run lint`                                                                                    | Passed                                                 |
| `npm run lint:eslint`                                                                             | Passed                                                 |
| `npm run build`                                                                                   | Passed                                                 |
| Local native dependency smoke                                                                     | SQLite in-memory query returned `1`; `node-pty` loaded |
| `prettier --check .`                                                                              | Passed                                                 |
| `npm run lint:doc-refs`                                                                           | Passed after repointing three moved-suite references   |

The AST audit checks original-source SHA-256 hashes, then compares parsed test and
assertion expressions after reversing mechanical binding aliases. It ignores comments,
formatting, redundant parentheses, and JSX indentation that does not change rendered
text. Literal values, operators, statement ordering, declarations, callbacks, and
assertions remain part of the comparison. The runtime comparison independently checks
exact test-name multiplicities after removing only the added unnamed suite boundaries.

The first runtime pass caught lowercase generated JSX aliases being treated as custom
DOM elements. Those aliases and their JSX references were corrected; the affected
suite rerun passed without changing assertions or mock factories.

## Baseline and measurement limits

A full clean-rc run before consolidation completed with 59,916 passing tests, one
failing test, and 215 skipped tests. Its file summary reported 38 failed files,
2,649 passing files, and seven skipped files. Most collection failures were missing
local dependencies, including agent SDKs and memory packages; a native-binding assertion
also failed. The locked dependencies were subsequently installed, Electron repaired,
and the Node SQLite binding rebuilt locally, without changing tracked dependency files.
All 10,087 selected consolidation-input tests had passed in that clean-rc run.

The initial post-reconciliation full run collected 60,856 tests in 2,296 files:
60,626 passed, 10 failed, and 220 were skipped. Its file summary was 12 failed,
2,275 passed, and nine skipped. All failures were test or hook deadlines in
unchanged files; none of the 113 consolidated files failed. This run overlapped
with static verification, so resource contention is a possible cause, not a
proven diagnosis. The plugin-scan hook had also timed out in the clean-rc run.
The other timeout failures were not independently established as baseline failures.

Eleven of the failing files were `renderer/rowHoverCss.test.ts`,
`renderer/utils/shiki/languageDetect.test.ts`, `scripts/verify-docs-paths.test.ts`,
`cli/commands/pianola-portfolio.test.ts`, `main/app-lifecycle/window-manager.test.ts`,
`main/lite/host-discovery.test.ts`,
`main/pianola/memory-transport.test.ts`, `main/plugins/net-egress-guard.test.ts`,
`main/plugins/relay-ledger.test.ts`, `main/plugins/plugin-scan.test.ts`, and
`shared/dataview/resultCap.test.ts`, all under `src/__tests__/`.
One additional documentation guard is identified in the local full-run receipt.
No assertions, exclusions, retries, or timeout limits were changed to suppress them.

The first normal push ran the repository's unmodified validation hook and was
rejected: 60,635 tests passed, eight failed, and 213 were skipped across 2,296
files. It also caught an impermissible test-path reference introduced in this
report; that reference was removed rather than exempting the report from the guard.
The focused documentation-guard run passed after this correction.
The other failing files were unchanged `main/plugins/plugin-scan.test.ts` and
`src/shared/maestro-lib/runtime/__tests__/consults.test.ts`,
`src/shared/maestro-lib/runtime/__tests__/git.test.ts`, and
`src/shared/maestro-lib/runtime/__tests__/turns.test.ts`; observed errors included
deadlines, Windows `EPERM` during temporary-directory cleanup,
and missing runtime outcomes. No hook was bypassed and no rc push was attempted.

The saved second-push log contains a passing Prettier check followed only by Git's
generic ref-push error; its wrapper exit receipt was not persisted. After resuming,
no previous push job remained registered. The exact Bun formatting and lint commands
were checked independently and each exited zero; no matching application crash event
was found. The historical termination cause and exit code could not be recovered,
so that incomplete log is not treated as a diagnosed type-check or remote rejection.

The clean-rc run is not a controlled speed baseline: its dependency install differed
from the repaired validation environment. This change establishes 398 fewer file
boundaries, not a newly measured wall-clock speedup over current rc. Historical
measurements from the older cleanup branch must not be presented as timings for this base.

## Scanner fixture setup correction

The resumed normal push completed with an exit receipt: formatting, TypeScript,
and ESLint passed; 60,667 tests passed and 213 were skipped across 2,298 files.
The only failing suite was `src/__tests__/main/plugins/plugin-scan.test.ts`, whose
fixture preparation exceeded the unchanged 10-second hook deadline.

A direct setup probe measured a 57 ms worker bundle, 8.88 seconds creating the
fixture with serial writes, and 2.40 seconds with at most 32 asynchronous writes
in flight. Both variants created the same 5,000 files and 20,480,000 bytes; every
file was byte-verified. The setup now uses bounded asynchronous writes and computes
the identical payload hash once. Signing remains deterministic because the
canonical signing payload sorts paths independently of write completion order.
The fixture size, signed bytes, tamper check, fail-closed check, assertions, and
test/hook deadlines are unchanged.

The real scanner suite then passed both existing tests in 4.48 seconds overall.
Its benchmark recorded 5,000 files, 20,480,000 bytes, 639 event-loop ticks during
the worker scan, and a maximum timer gap of 3.10 ms. Production scanner code was
not changed.

## Empty remote-filesystem test fixture

The next normal push passed the scanner suite. It was rejected only by two
10-second deadlines in the unchanged remote-session tests in
`src/__tests__/main/agents/session-storage.test.ts`: the test group used a fixture
SSH hostname without stubbing remote directory I/O. Its intended input was an
empty remote filesystem, but it could wait on real SSH/DNS.

That test group now supplies `{ success: true, data: [] }` at the remote-directory
I/O boundary and restores the spy after each test. Storage methods, SSH configuration,
credentials, test bodies, assertions, and deadlines are unchanged. All 114 tests
in the file passed in 5.06 seconds overall. A structural comparison against current
rc also preserved all 717 existing test/assertion expressions in that file and all
14 in the scanner suite.

## Hosted CI fixture follow-up

On head `07474d6d1a`, the normal local publication hook passed with 60,669 tests
passed and 211 skipped. Greptile explicitly reviewed that head at confidence 5/5
with no substantive finding. Hosted run `41813914860` passed lint/format and two
of four test shards, but identified two remaining fixture-lifecycle failures:

- Windows shard 1/2 exceeded the scanner fixture's unchanged 10-second setup
  deadline. A byte-verifying local probe under the later workload measured
  bounded `writeFile` preparation at 7.93 seconds and bounded native `copyFile`
  preparation at 3.07 seconds. The fixture now copies one payload outside the
  scanned directory into 5,000 independent regular files, still totaling
  20,480,000 bytes. It does not use hard links or change signed contents, tamper
  checks, assertions, or deadlines. Both scanner tests passed in 6.21 seconds
  overall after this change; hosted validation is recorded separately in the PR.
- Ubuntu shard 2/2 passed all 30,349 assertions but reported an uncaught
  `window is not defined` from LightboxModal's copy-feedback timeout after jsdom
  teardown. Its existing copy tests now use automatically advancing fake timers,
  settle pending React work, and clear their timers before returning to real
  timers. All 50 existing Lightbox tests passed. No production component changed.

The structural audit against current rc preserved every existing test/assertion
expression in all three fixture-corrected files: 14 scanner expressions, 717
session-storage expressions, and 236 Lightbox expressions.

## Protected local work

The interrupted index, working tree, and untracked work are retained under
`refs/checkpoints/cleanup-tests-rc-resume-20261104`. Original consolidation inputs,
incidental scratch scripts, and dedup-catalog artifacts are also preserved in the
ignored `.maestro/scratch/cleanup-tests-resume-20261104/` directory. They are not
part of the PR. The original `cleanup-tests` branch remains available separately.
