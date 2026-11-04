---
type: reference
title: Isolated rendered Board fixture
created: 2026-11-04
tags:
  - board
  - testing
  - isolation
related:
  - '[[board]]'
---

# Isolated rendered Board fixture

This developer fixture uses the current `BoardModal`, renderer stores, layer stack,
styles and production preload. Its owned Electron main process registers the real
Board IPC handlers over the admitted SQLite facade and real isolated Electron
stores. It does not import the general desktop bootstrap/index or start a Cue
engine, worker runtime, provider, SSH adapter or installed CLI bridge.

## Build and prepare

Run from a canonical registered checkout with local dependencies and a Node-compatible
SQLite addon selected. Building does not rebuild or switch native addons.

```bash
node scripts/board-rendered-build.cjs
node --test scripts/board-rendered-fixture.test.cjs
node scripts/board-rendered-prepare.cjs 100 /absolute/checkout/path/to/electron-sqlite.node
node scripts/board-rendered-contract.cjs /absolute/checkout/isolated/board-performance-ID/rendered.json
```

The build reuses `build:main` and the production Vite configuration, including its
CSS minifier and local fonts. Only the fixture renderer entry replaces the main
application shell. Output lives in `dist/board-rendered`; production `dist/renderer`
is retained. The preparation command supports `0`, `100` and `500` cards and prints
one manifest path. Tests use the active Node addon as an admission-test payload;
that does not establish its compatibility with Electron. Prepare a real launch
with an independently qualified Electron addon belonging to this checkout.

Preparation reuses the existing performance profile seeder, then materializes 50
local Git roots and empty legacy Board files through the real migration planner
and SQLite adapter. The capture catalog must contain 100 agents, 20 groups and 50
repositories; SQLite must contain 50 source locations and migrations, the selected
card count, zero workers and zero runs. Agent and group membership are real fixture
registrations. Every fixture is a newly created root with mode `0700`.

`rendered.json` binds the complete current main/shared/types and fixture renderer
build file sets, renderer/host sources, entry script, production preload,
Electron executable, selected SQLite addon, preparation manifest and exact bytes
of agent/source/group/settings registries. Any source or build change requires a
new build and fresh preparation. Admission rechecks canonical paths, registered
checkout identity and private root permissions before opening stores.

## Executable launcher

`scripts/board-rendered-launch.cjs` owns preparation and one native lifecycle.
After the build, run it with the selected card count, a checkout-local qualified
Electron ABI145 addon, and the existing native qualification receipt:

```bash
node scripts/board-rendered-launch.cjs 100 /absolute/checkout/electron-abi145.node /absolute/checkout/qualified-checks.json
```

The receipt must contain successful R14b Node ABI137 facade/child checks and R15b
Electron ABI145 execution, with hashes matching both preserved bindings and the
installed dependency's Electron version. This reuses native ABI qualification;
it does not treat those historical checks as acceptance of current Board code.

The launcher creates a fresh manifest through `board-rendered-prepare.cjs`, admits
current source/build/catalog bytes, obtains an owned Xvfb display and loopback CDP
port, and passes only the admitted environment and canonical parent contract.
It waits for the matching host readiness record and renderer CDP target. Its
default action then sends `finish` through the existing file observer and waits
for an explicit successful Electron exit. DOM interactions belong to the next
smoke task; a successful lifecycle alone leaves `nativeAcceptance` false.

The exported `launchRendered({ count, addon, qualificationPath, exercise })` can
run a scenario while resources are owned. `exercise` receives `root`, `target`,
`cdpUrl`, `signal`, and `observe('begin' | 'end')` for raw host samples. Close any
scenario CDP connections in its own `finally`; the launcher sends the final
observer command. Scenario rejection, startup failure, timeout and SIGINT/SIGTERM
all enter the same cleanup and addon restoration path.

An exclusive worktree addon lease refuses concurrent launchers. The active Node
binding is hashed and backed up before selection; replacement is atomic and does
not overwrite hard-linked node-gyp artifacts. Cleanup stops owned detached
processes and recorded descendants through existing termination utilities, then
restores and verifies the original binding. No rebuild is performed. The total
budget is 300 seconds, including a ten-second cleanup reserve. An uncatchable
process termination cannot run JavaScript `finally`; the backup and lease remain
available for diagnosis in that case.

Each admitted run writes `xvfb.log`, `electron.log`, `launcher-node-abi137.node`
and `rendered-launch.json` below its private root. The JSON records source/build
hashes, the manifest and qualification receipt hashes, exact child environment,
arguments, cwd, process exits, restoration and cleanup failures. A consumed
manifest is refused; a later persistence/reopen test needs a fresh parent-bound
admission for the same database rather than reusing this run's manifest.

Lifecycle regression tests use real SQLite preparation/admission and disposable
addon files, with process and CDP doubles. They never load a native Electron
window or swap the active dependency's addon:

```bash
node --test --test-concurrency=1 scripts/board-rendered-launch.test.cjs
```

## Owned native entry

The executable entry is
`src/__tests__/integration/fixtures/board-rendered-entry.cjs`. An owned launcher
must pass the absolute `rendered.json` path as the first application argument,
the manifest's exact environment plus `BOARD_ISOLATION_CONTRACT` from the existing
`boardIsolationChildEnv()` helper, and an owned Xvfb `DISPLAY`. Optional Xauthority
must reside inside the fixture root. No inherited credentials, `NODE_OPTIONS`,
provider configuration or proxy environment are accepted. HOME and CODEX_HOME are
not reassigned.

The active worktree-local SQLite addon must match the bound Electron addon before
launch. The launcher owns any addon switch and restoration; the entry never
rebuilds or copies it. Only loopback CDP with an explicit port and the documented
background-network/GPU/password-store switches are admitted. An exclusive run lock
prevents reuse of a consumed rendered fixture. A 240-second deadline closes the
owned process; the external launcher must also bound and clean up its own children.

The window uses a sandboxed, isolated production preload with Node integration
disabled. HTTP, HTTPS, WebSocket and other nonlocal renderer requests are cancelled;
Node network calls, Electron network calls and external shell opening throw.
Child processes are denied except the Linux fixture's hash-bound `/usr/bin/git`
`rev-parse --show-toplevel` probe, restricted to registered local source roots,
without shell or inherited Git configuration. This permits source revalidation;
it is a fixture boundary, not a general operating-system sandbox. Permission requests, new windows, navigation and webviews are
denied. Each Board IPC call revalidates the fixture catalogs and owning main-frame
sender. Execution controls fail closed because no runtime owner is installed.
Worker registration edits only isolated Board records and cannot spawn a provider.

The fixture shell offers **Open Board** and three theme choices. Board actions use
the production controls. Window-size preferences stay in memory; catalog/settings
files remain bound to their prepared bytes. The main process exposes
`process.boardRenderedFixture` to its owned observer for host timing and teardown;
no test bridge is added to the production preload. `rendered-host.json` records
actual catalog counts, readiness and denied attempts. `ready` means the document
loaded; renderer readiness is separately indicated by `data-board-fixture="ready"`.

## Acceptance boundary

### Controlled transition measurements

The reproducible replacement for the local delivery10 probes is:

```bash
node scripts/board-rendered-transition-scenario.cjs baseline /absolute/checkout/electron-abi145.node /absolute/checkout/qualified-checks.json
```

After a product change, rebuild once and run the same command with a different
label. Each invocation uses a fresh owned 500-card fixture with 100 agents, 20
groups and 50 sources. It measures Cards re-entry, restoration from an empty
status filter, and one selection toggle, both with zero and 250 cards selected.
Each condition has one warm-up and ten recorded repetitions. `selected` in each
sample is the count **after** the action; a selection sample therefore contains
one more selected card than its starting condition.

Timing starts immediately before the DOM click and ends after the expected DOM
state and two animation frames, inside one renderer evaluation. Setup, settling,
host observer calls and result collection are outside that interval. There is no
CPU profiler, concurrent accessibility query or deliberate timer inside a sample.
These programmatic clicks measure the rendered transition; they do not qualify
trusted-input latency. The observer's long-task subset excludes tasks that
started before the sample (including the initiating evaluation), so it cannot
fully attribute elapsed time to JavaScript or layout.

Raw samples and host observations stay in `transition-scenario.json` under the
private fixture root alongside the launcher's source/build and lifecycle receipt.
Assess the recorded distributions against the release goals separately for
each candidate, keeping historical measurements bound to their tested files.

Build, real SQLite preparation and admission tests are source/build evidence.
They do not prove a native window rendered, that interactions passed, or any
latency target. The subsequent owned Xvfb/Electron/CDP smoke must actually open
Board, drive its controls and collect screenshots and raw timings. Final fresh,
migrated/reopened, three-theme, authority and representative-load acceptance remain
separate, as do remote operation, independent review and exact-head CI. No installed
desktop or production data is used by this fixture.

### Controlled persisted-database second launch

Run the reproducible scenario after building, using the same qualified addon and
native qualification receipt as the ordinary launcher:

```bash
node scripts/board-rendered-reopen-scenario.cjs /absolute/checkout/electron-abi145.node /absolute/checkout/qualified-checks.json
```

The first owned launch starts empty, creates an assigned card through the real
rendered form and IPC, and adds a populated historical outcome as isolated fixture
setup. It closes its SQLite connection and exits. Its final host snapshot retains
every table's IDs, revisions, payload/history bytes and migration ledger. The
launcher records the closed database's content hash and filesystem identity, the
host receipt hash, child exits and addon restoration.

`launchRendered({ reopen: previousReceipt, addon, qualificationPath, exercise })`
accepts that exact parent-returned receipt only after checking the successful
previous lifecycle, closed children/database, restored qualified addon, current
source/build fingerprints, original canonical root/DB identity and registry bytes.
It never calls the seeder or resets storage. It atomically reserves the original
root's single `rendered-reopen.lock`, creates a fresh isolation identity and a new
manifest below that root, and consumes a separate run lock. A failed second launch
does not make the authorization reusable. The original consumed manifest and lock
remain intact. Changed roots, replaced databases (even equal bytes), registries,
builds, parent contracts and competing/repeated reuse are refused.

The second host opens the same database with a new parent contract and compares
all persisted tables before and after normal workspace initialization and source
refresh. The scenario verifies the same saved card, assignment, source/collection
IDs and revisions in the actual UI/host, plus original populated history bytes and
50 unchanged migration rows. Its output directory is the fresh identity's child
directory; its `exercise` receives that directory as `root` and the retained DB
path as `contract.db`. Screenshots and raw receipts stay in these private roots.
Both launches retain their own exit and addon-restoration evidence.

This qualifies the controlled local fixture lifecycle. It does not restart the
installed application or demonstrate provider execution, remote persistence,
final public-candidate integration or the remaining full rendered acceptance
matrix. Self-checks are separate from independent review.

## Reproducing a bulk deletion scenario

After building the fixture, pass the checkout-owned Electron SQLite addon and
its qualification receipt explicitly, as with the transition and reopen drivers:

```bash
node scripts/board-rendered-bulk-scenario.cjs commit /absolute/checkout/fixture/electron.node /absolute/checkout/fixture/qualification.json
node scripts/board-rendered-bulk-scenario.cjs stale /absolute/checkout/fixture/electron.node /absolute/checkout/fixture/qualification.json
```

Both scenarios retain the launcher's source, parent, registry and addon checks.
They use fresh owned roots and emit evidence there; no local receipt path is
part of the driver.
