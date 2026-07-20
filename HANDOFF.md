# Maestro Concerto handoff

> Temporary handoff file. Delete `HANDOFF.md` after reading it on the other machine.

## Pull this work

Current feature branch and commit:

- Branch: `codex/concerto-window-taskbar`
- Commit: `854307473 Add Concerto window taskbar`
- Remote: `git@github.com:stevenmgordon/Maestro.git`

If the `personal` remote already exists:

```bash
git fetch personal codex/concerto-window-taskbar
git switch codex/concerto-window-taskbar
git pull
```

If it does not exist:

```bash
git fetch git@github.com:stevenmgordon/Maestro.git codex/concerto-window-taskbar:codex/concerto-window-taskbar
git switch codex/concerto-window-taskbar
```

## What is complete

- The original HTML Concerto work was merged upstream into `origin/rc`.
- This follow-on branch adds minimize controls and an expanding taskbar for open Movement windows.
- Minimized, hidden, or overlapped HTML Movements stay mounted and are surfaced before designer inspection.
- Designer inspection checks the current HTML document revision before capturing it.
- Closing an HTML Movement still releases its in-memory document.
- Movement drag behavior was previously smoothed and is part of the merged upstream work.

## Separate agent-response bugfix

The exit-code-1 and missing-response race is isolated from this feature branch:

- Branch: `codex/fix-agent-response-reconciliation`
- Commit: `d6eb7af31 Fix agent response reconciliation race`
- Draft PR: https://github.com/RunMaestro/Maestro/pull/1249

Root cause: stale renderer state could report an idle tab while its process was still running. A follow-up spawn reused the same composite session ID, killed and unregistered the live process, and discarded its eventual response. The fix reconciles against ProcessManager state, refuses destructive live-agent replacement, and makes exit cleanup generation-safe.

## Designer feedback loop

HTML Movements have a real agent-visible iteration path:

1. The agent creates or updates a self-contained HTML Movement.
2. `maestro-cli movement inspect <id> --output <absolute-path.png> --json` captures the actual Chromium compositor crop of the live iframe.
3. The command returns the PNG, viewport metadata, scale factor, and browser runtime errors.
4. The agent reads the PNG with its image tool.
5. The agent can exercise states with `movement interact <id> --click <selector>` or `--type <selector> --value <text>`.
6. It updates the same HTML file and Movement ID, then inspects again.

The system prompt requires this loop and at least one purposeful refinement pass for design work. This screenshot and interaction loop currently targets HTML Movements, not Cadenzas. It works best with agents that can read local images.

## Validation completed

- Concerto taskbar and store tests: 25 passed.
- Designer bridge, remote integration, compositor capture, message routing, and CLI inspection tests: 295 passed, 2 skipped.
- Agent response regression tests: 272 passed.
- Process spawner regression tests: 95 passed.
- TypeScript, focused ESLint, and Prettier checks passed.

## Live test status at handoff

- Maestro was launched with `npm run dev:prod-data` from this branch.
- The CLI bridge reported healthy on port `49247` with 2 agents.
- Codex was detected and available. Other agent binaries were not detected in this environment.
- The Movement canvas was empty before the live test prompt.
- The monitoring loop was stopped to prepare this handoff before departure.

Recommended live proof on the other machine:

1. Start Maestro with `npm run dev:prod-data`.
2. Ask a Codex agent for a visual mockup without explicitly mentioning Concerto.
3. Confirm it opens an HTML Movement automatically.
4. Confirm its trace runs `movement inspect`, reads the PNG, and updates the same Movement at least once.
5. Inspect the first and final PNGs to judge whether the visual critique materially improved the result.

## Local-only files

`.codex/` contains untracked local visualization artifacts and was intentionally not committed.

Delete this file after consuming the handoff:

```bash
git rm HANDOFF.md
git commit -m "Remove consumed handoff"
```
