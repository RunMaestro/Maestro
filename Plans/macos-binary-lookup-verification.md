# macOS verification: binary lookup and the release build

The maestro-lib workplan asks for this in every part: "Binary lookup on macOS is
a third path (Homebrew, app bundles, /usr/local) and must be checked even if
there is no dedicated Mac runner." It had never been done - the CLI migration's
real-provider runs were all on Windows - so this is that check, plus the
automated coverage the check showed was missing, plus the macOS release build
that had never been run for this work either.

The check found a real detection bug, fixed here (finding 1, and the duplicate
candidate that sat in the same entry). Everything else is recorded, not fixed.

## What the suite covered before

macOS appeared mostly as a label used to switch the Windows branches off. Every
`probeUnixPaths` test rejected every candidate and asserted `null`, so the
per-agent table passed whatever it contained. Elsewhere the macOS assertions
were about PATH-string composition, `findAllBinaryPaths` de-duplication, and
`checkBinaryExists` choosing the probe before the `which` fallback - nothing
about the candidates themselves.

## Added coverage

`src/__tests__/main/agents/path-prober.test.ts`, a `probeUnixPaths on macOS`
block that pins the table's content and order:

- Claude's own install location (`~/.claude/local/claude`) outranks
  `~/.local/bin`, which outranks Apple Silicon Homebrew, which outranks Intel.
- The probe asks `access` for the executable bit. Narrow by construction: `F_OK`
  is 0, so `F_OK | X_OK` is just `X_OK`, and a mocked rejection cannot tell a
  non-executable file from a missing one. It catches the bit being dropped,
  nothing more.
- OpenCode's installer location outranks a Go install.
- Copilot leads with Homebrew over `~/.local/bin`.

A matching Windows case sits in the existing `probeWindowsPaths` block: Copilot
leads with the WinGet install over an npm shim. Those two Copilot tests are the
regression guards for finding 1, one per table, since the key was wrong in both
and a fix to one alone would leave the other silently broken. The obsolete
`should check both existence and executability` test was removed: it asserted
only that `access` had been called, while its comment described a check it did
not make, and the new executable-bit test replaces it.

Nothing was added on the CLI side: its resolution order is already covered
(custom path, resolved PATH entry, bare-name fallback, SSH keeping the bare
name), and finding 3 is a documented divergence rather than something a CLI
test can demonstrate - the CLI behaves identically whether or not the binary
sits in a known location it never probes.

The guards are mutation-checked: swapping the first two Claude candidates fails
the priority test, dropping `X_OK` from the probe fails the executable-bit test,
and restoring the old key in either table fails that table's Copilot test.

## Verified on this machine

macOS 26.6.1 (build 25G76), Apple Silicon. Detection was run through the real
code (`checkBinaryExists` / `probeUnixPaths` / `findAllBinaryPaths`), and the
CLI through a stub binary that prints the path it was invoked as, so the CLI
rows cost nothing.

One live Claude turn did run, by accident and at a cost of $0.37: an attempt to
hide the real binary by stripping PATH failed, because `buildExpandedPath`
re-adds `~/.local/bin` before the lookup. That failure is what established the
scope of finding 3, and the stub approach replaced it afterwards.

| Case                           | Result                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Desktop detection, claude      | Found at `~/.local/bin/claude` by the known-path probe, before any `which` fallback                                                              |
| Desktop detection, copilot     | Before install: `exists: false`. With Copilot CLI 1.0.88 installed: found by `which` only, until finding 1 was fixed; the table now finds it too |
| Desktop detection, codex       | `exists: false` - not installed                                                                                                                  |
| `findAllBinaryPaths('claude')` | One entry, though `which -a` reports `~/.local/bin/claude` twice (a duplicated PATH entry), so the realpath de-duplication holds                 |
| CLI resolution through PATH    | Resolved and spawned the stub found on PATH                                                                                                      |
| CLI, per-agent custom path     | **Ignored** - see finding 4                                                                                                                      |
| CLI, expanded PATH             | Covers `~/.claude/local`, `~/.local/bin`, both Homebrew roots, `~/.npm-global/bin`, `~/bin`, `~/.bun/bin` and the node version managers          |

## Release build on macOS

The workplan pairs "macOS binary lookup checked" with the two CI legs, and no
macOS build had been run for this work either. `npm run build` completes on
this machine in ~27s, every stage green:

| Stage                             | Result                                        |
| --------------------------------- | --------------------------------------------- |
| `build:main` + `build:provenance` | `dist/main/index.js` emitted                  |
| `build:preload`                   | `dist/main/preload.js` emitted                |
| `build:renderer`                  | `dist/renderer/index.html` + assets           |
| `build:web-desktop`               | `dist/web-desktop/` emitted                   |
| `build:cli`                       | `dist/cli/maestro-cli.js`, 5.0 MB             |
| `build:maestro-p`                 | `dist/cli/maestro-p.js`, 199 KB               |
| `build:permission-relay-bridge`   | `dist/cli/permission-relay-bridge.js`, 7.4 KB |

The built binaries run, not merely emit: `maestro-cli --version` reports
`0.18.6-RC` and both `maestro-cli --help` and `maestro-p --help` print their
usage. The renderer build prints its usual chunk-size and
`INEFFECTIVE_DYNAMIC_IMPORT` warnings (Director's Notes), which predate this
work.

Packaging was then run for macOS alone (`electron-builder --mac`; the `package`
script also targets Windows and Linux, which need toolchains this machine does
not have). It produced `release/mac-arm64/Maestro.app` and stopped at
notarization: the bundle is ad-hoc signed (`Signature=adhoc`,
`TeamIdentifier=not set`), so `@electron/notarize` refuses it and no dmg or zip
is emitted. That needs an Apple Developer ID, which is a release-pipeline
credential rather than something to verify locally.

Comparing against the _shipped_ release still needs that release installed
here, so it remains unverified.

## Finding 1, fixed here

**Copilot's known-path table was unreachable on every platform.** Both tables
keyed it `'copilot-cli'` (the agent id) while they are looked up by binary name
(`checkBinaryExists(agentDef.binaryName)`, and copilot-cli's is `copilot`).
None of its candidates were ever probed; detection fell back to `which`/`where`
alone, so a Copilot installed off PATH was invisible to the desktop on both
platforms, the WinGet location included. This is NOT the cause of the Windows
symptom recorded in the CLI migration: the CLI never consults this table at all
(finding 3), so its `where.exe` shim selection is a separate problem.

Every other agent that HAS an entry was already keyed by its binary name. Two
neighbouring gaps predate this work and are left alone: `qwen`, `droid` and
`grok` have no entry in either table, so they stay `which`-only (`droid` is an
Active agent); and the `gh` entries in both tables are unreachable for the same
reason Copilot's were, since no agent definition carries `binaryName: 'gh'` and
nothing else looks that table up.

Demonstrated live after installing GitHub Copilot CLI 1.0.88 here
(`brew install --cask copilot-cli`, landing at `/opt/homebrew/bin/copilot` -
the FIRST entry in its own table):

| Binary    | `probeUnixPaths` before | after                       |
| --------- | ----------------------- | --------------------------- |
| `claude`  | `~/.local/bin/claude`   | unchanged                   |
| `copilot` | **null**                | `/opt/homebrew/bin/copilot` |

The fix keys both tables by `copilot`, with one guard per table. Two tidy-ups
rode along in the same entry, both no-ops for behavior: a duplicated
`/usr/local/bin/copilot` candidate is gone (the Homebrew builder already emits
that exact path one line above, so it was a second copy at a lower priority
index; harmless in practice, since `findAllBinaryPaths` de-duplicates by
realpath and `probeUnixPaths` takes the first hit, though `probeUnixPathsAll`
is exported and does not), and the hand-built `~/.local/bin` path now uses the
`localBin()` builder its siblings use.

## Findings, not fixed here

2. **Copilot 1.0.88 reports usage in a shape the parser does not know, so its
   runs record no tokens at all.** One live tool-using turn (`copilot -p ...
--allow-all --output-format json`, an `apply_patch` that created a file,
   then a final answer) emitted **no `outputTokens` on any `assistant.message`
   and no `session.shutdown`**. Usage arrived as `session.usage_checkpoint`
   with `totalNanoAiu` and `totalPremiumRequests`.

   `copilot-output-parser.ts` handles exactly two shapes: `modelMetrics` on
   `session.shutdown` (<=1.0.5) and `data.outputTokens` on `assistant.message`
   (1.0.39-1.0.43). Neither is emitted by 1.0.88, so token and cost totals for
   Copilot are empty everywhere they are shown.

   This also bounds the Copilot usage P1 raised on the CLI migration: the
   accumulator cannot undercount tokens it never receives, so that finding
   applies to 1.0.39-1.0.43 only. Keying delta-normalization on Codex remains
   right either way.

3. **The CLI has no known-location probe, but the gap is narrow.** The desktop
   probes the per-agent table before falling back to `which`; the CLI tries the
   configured custom path, then `which`, then the bare name. In practice
   `buildExpandedPath` already contains most of that table, so the only macOS
   location that is in the table and NOT in the CLI's expanded PATH is
   `~/go/bin` - where OpenCode's Go install lands. `~/go/bin` is in the
   **Windows** branch of `buildExpandedPath` only.

4. **`maestro-cli update-agent --custom-path` is ignored by `maestro-cli
send`.** The command reports success and writes `customPath` onto the session
   record, but CLI spawn resolution reads `getAgentCustomPath(toolType)`, which
   is the provider-level `maestro-agent-configs.json`. Verified directly: with a
   per-agent custom path set to a stub, `send` still ran the binary found on
   PATH. Desktop honors the session-level value: a Cue run with the same setting
   executed the stub, observed while verifying the Cue migration on
   `feat/maestro-lib-cue-outcomes`, not on this branch. So the two surfaces
   disagree about what "this agent's binary path" means.

5. **No macOS app-bundle probing.** Codex Desktop has rotated-version recovery
   on Windows (`path-prober.ts:39-92`) with no macOS counterpart, and
   `/Applications/*.app` is never probed for any agent.

## Open question

The New Agent dialog listed Copilot-CLI as **Available** while no `copilot`
binary existed anywhere on this machine (PATH, login-shell PATH, both Homebrew
roots, `~/.local/bin`, five nvm node versions, the npm global root,
`/Applications`, VS Code extensions), and detection run directly returned
`exists: false`. The badge renders `agent.available`, which is
`detection.exists`, so the two disagreed.

It can no longer be reproduced here: Copilot CLI has since been installed for
the verification above, so the badge is now correct for the ordinary reason.
Re-checking it needs a machine without Copilot, or this one with the cask
removed.

First suspect when it is re-checked: `AgentDetector.cachedAgents`
(`src/main/agents/detector.ts`) has no TTL and is cleared only on a custom-path
change or an explicit clear, so a badge can outlive the state it was computed
from.
