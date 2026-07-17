# Stage 00 - Operating Model and Preflight

## Objective

Create a reproducible baseline and execution discipline before any deduplication work. This stage changes no production behavior.

## Inputs

- `dedup-report.md`, especially the priority list and the evidence surrounding each priority.
- `Plans/dedup-playbook/README.md`.
- Current project scripts in `package.json`.
- Current CI workflow and Electron packaging configuration.

### Inspected checkout warning

On 2026-07-14 the planning checkout was `fix/1180-idle-codeblock-freeze`, ten commits behind `origin/rc`, with substantial untracked user work including this playbook and audit files. It is not an implementation base. Preserve it untouched. Execution begins from a newly fetched `origin/rc` worktree on branch `dedup/maestro-cleanup`; if that branch name already exists, use a uniquely suffixed equivalent and record it in the ledger. Never copy the inspected checkout's source tree wholesale.

## Deliverables

1. A named integration branch or equivalent tracked base commit.
2. A stage ledger containing priority status, owner, PR, verification, and disposition.
3. Baseline results for type checking, linting, focused tests, application launch, web build, Electron package smoke, and known pre-existing failures.
4. A captured list of tracked merge conflicts and uncommitted user changes.
5. A rollback convention for source, migrations, persisted state, and build artifacts.

## Procedure

### 1. Protect user work

- Inspect the working tree without modifying it.
- Classify every existing change as user work, generated output, known conflict, or playbook documentation.
- Do not reset, restore, clean, or overwrite user work.
- Create worktrees or branches from the agreed base for implementation stages. Stage 01 must receive a clean conflict-resolution branch.

### 2. Establish the baseline

Record exact commands and results for:

- TypeScript project checks used by `package.json` and CI.
- ESLint and Prettier checks.
- The current focused test suites for main, renderer, shared, CLI, web, plugin SDK, and E2E.
- Electron main-process build, including a forced `tsc -b tsconfig.main.json --force` when validating main-process changes. Maestro loads `dist/main/index.js`; stale incremental output is not acceptable proof.
- Web-desktop build and artifact inspection.
- Electron launch through the same entry point used by development.
- Current packaging smoke on the host architecture.

Do not repair unrelated baseline failures here. Record each as `pre-existing`, with command, failure signature, and affected stage.

### 3. Create the execution ledger

The ledger must have one row for every priority P1-P134. P1-P120 are the original audit scope; P121-P134 are Wave 14 additions accepted after saturation review. Each row includes:

- priority number and title;
- stage;
- current disposition: `pending`, `in progress`, `verified`, `deferred`, `already resolved`, or `rejected`;
- source evidence refreshed date;
- exported symbols checked by LSP;
- tests/reproduction added or used;
- PR/commit;
- migration/rollback note;
- final verification result.

The ledger may live in the tracking issue or PR system. Do not create a second canonical source inside production code.

### 4. Define evidence classes

Use these labels consistently:

- **Mechanical:** byte-identical or parameter-only difference; focused parity tests are sufficient.
- **Contract:** shared types, producer/consumer payloads, registries, or public exports; requires reference and boundary verification.
- **Behavioral:** different implementations intended to become one policy; requires characterization tests before editing.
- **Persistence:** disk format, settings, cache, ledger, or session storage; requires old/current/corrupt-state tests and rollback.
- **Security:** trust boundary, path validation, permissions, payload limits, or sandbox; requires negative and abuse-case tests.
- **Destructive:** deletion of file, export, dependency, alias, fixture, or compatibility path; requires reference proof and replacement smoke.
- **Visual:** renderer structure, styling, interaction, focus, timers, or layout; requires browser/Electron verification.

### 5. Define commit and rollback rules

- One priority per commit when the change is independently reversible.
- A shared primitive and all caller migrations may share one commit when intermediate states would not compile.
- Persistence migrations must be reversible or retain a backup/read-old path until the new write is proven.
- Security changes must roll back as a unit; never keep a new permissive parser with an old restrictive validator removed.
- Deletions occur only after replacement commits have passed.

### 6. Refresh every priority before implementation

For each priority, the stage executor must:

1. Read the original evidence around the priority in `dedup-report.md`.
2. Locate current declarations structurally, not by stale line number.
3. Run LSP references for exports.
4. Identify all tests and dynamic consumers, including IPC channel strings, preload exposure, package exports, CSS class strings, file names, and generated imports.
5. Recalculate likely net savings; reject abstractions that now add more code than they remove.
6. Record whether the finding remains valid.

## Global safety gates

### Export gate

No exported symbol changes until LSP references and package/public API consumers are recorded.

### Cross-runtime gate

For IPC, preload, WebSocket, CLI, plugin, and web contracts, document:

`producer -> serializer/transport -> preload or API exposure -> consumer -> tests`.

All nodes must use or deliberately map the canonical contract.

### Persistence gate

Test:

- missing file;
- current valid file;
- previous-version file;
- malformed JSON/YAML;
- invalid field type;
- partial write/interrupted update;
- concurrent or repeated update where applicable.

### Security gate

Test allowed and denied paths, boundary traversal, oversized payloads, malformed encodings, untrusted origins, and fail-closed error behavior.

### UI gate

Render the real flow. Verify keyboard navigation, focus restoration, Escape ownership, pointer cleanup, timer cleanup, reduced motion where relevant, and both themes when presentation changes.

### Deletion gate

A deletion requires:

- textual and symbol references checked;
- dynamic/file-system consumers checked;
- replacement path smoke-tested;
- focused and full relevant tests passed;
- packaging/export maps checked;
- rollback documented.

## Exit criteria

- All baseline commands and known failures are recorded.
- The P1-P134 ledger exists and matches the stage partition in the index.
- Branch/worktree and PR conventions are fixed.
- No production source changed.
- Stage 01 can begin without risking untracked user work.
