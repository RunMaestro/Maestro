# Goal: make `mae` (Maestro TUI) feature complete

Branch: `feat/maestro-coding-agent`. Companion to `Plans/maestro-coding-agent-design.md`
(architecture) and its section 11 (implementation status). This document defines
what "feature complete" means, the gap from today, and the workstreams + the
single end-to-end demo that proves it.

## 1. Goal (one sentence)

Make the three integration pillars work **end-to-end against the real Maestro
desktop app and a live `omp` session**: pick up Maestro sessions from the
terminal, have Maestro track every TUI run live, and let the omp agent use the
real Maestro toolset - all behind the per-run scoped-token security model
already specified.

## 2. Definition of "feature complete" (the acceptance demo)

Feature complete = this scripted run passes with a real Maestro desktop app
running and a real omp/auth available, with NO general CLI token handed to omp:

1. `mae` launched in a repo opens omp's TUI with the Maestro profile + bridge.
2. Within ~1s the session appears in the Maestro desktop **session list**, live.
3. A real turn streams status/transcript metadata into the GUI as it runs.
4. Inside the run, `maestro_sessions` returns the user's **real** sessions,
   `maestro_playbook_list` the **real** playbooks, `maestro_cue` real cue state,
   and `maestro_notify` raises a **real** toast in the app.
5. Quit `mae`; the session is present in the GUI and can be reopened there.
6. From a fresh terminal, `mae resume` lists that session and **continues it**
   with full engine state (omp-native true resume).
7. A session **created in the GUI** (omp engine) can also be picked up by
   `mae resume`; a non-omp GUI session imports as transcript context with a
   clear banner.
8. `maestro_dispatch` / `maestro_playbook_run` / `maestro_cue_emit` still return
   "requires Phase 4" (correctly inert).

When all 8 hold, the feature is complete.

## 3. Out of scope (so "complete" is bounded)

- **Phase 4** dispatch-equivalent verbs (`agents:dispatch` / `process:spawn` /
  `cue:emit`) stay inert. Their being unavailable is by design, not
  incompleteness (see design sections 4.2, 5, and `plugin-phase4-high-risk-verbs.md`).
- **Phase 5** ACP live GUI co-view / handoff.
- Multi-user / collab session sharing beyond what omp already provides.

## 4. Current state (done, verified in isolation)

The omp-side product under `src/mae/` is implemented and green: launcher,
bridge extension, protocol/contract, session-map, scoped client, and a
`node:http` reference ingest server. 34 `bun test` tests pass, `tsc -p
tsconfig.mae.json` is clean, esbuild builds the `dist` artifacts, and the built
launcher resolves its extension/assets. Shipping wiring is in place (root
`bin.mae`, `build:mae`, `typecheck:mae` in `lint`, `test-mae` CI job,
`extraResources`, lockfile). See design section 11.

The gap is everything that requires the **real desktop app** and a **live omp
run** - none of which is implemented or exercised yet.

## 5. Workstreams

Each names where it lands, the change, its acceptance, and how it is verified.
The contract is already fixed in `src/mae/protocol.ts`; the desktop side mirrors
`src/mae/reference-server.ts`.

### W1 - Desktop ingest host (BLOCKING, large)

- Where: Electron main process (`src/main/...`); new module e.g.
  `src/main/mae/mae-bridge-host.ts`. CRITICAL: this is a SEPARATE
  **loopback-only (127.0.0.1)** `http.Server`, NOT mounted on the existing
  `WebServer` (which binds `0.0.0.0` for remote web access and would LAN-expose
  the bootstrap-secret exchange). The discovery URL is `http://127.0.0.1:<port>`.
- Change: host `POST /v1/sessions/issue` and `POST /v1/bridge` exactly per
  `protocol.ts`, mint per-run scoped tokens (bound to runId + omp pid, with
  expiry), enforce the live-verb allowlist, refuse dispatch-equivalent verbs
  (403), and write/refresh the `mae-bridge.json` discovery file into Maestro's
  **shared config dir** with a rotating bootstrap secret. CRITICAL: the desktop
  writer and `mae`'s reader (`discoveryPathFor`) must use the SAME resolution as
  `src/shared/cli-server-discovery.ts` `getConfigDir()` - honoring
  `MAESTRO_USER_DATA` and the per-platform userData location (macOS
  `~/Library/Application Support/maestro`, Windows `%APPDATA%/maestro`, Linux
  `$XDG_CONFIG_HOME|~/.config/maestro`, lowercase `maestro`), NOT a hardcoded
  `~/.maestro`. (`mae`'s `discoveryPathFor` was aligned to this in the launcher;
  the desktop writer must match it.) Tear down tokens on session end / app quit.
- Acceptance: with the app running, `mae` obtains a token, registers a session,
  and the app records it; an invalid token -> 401; a dispatch verb -> 403; the
  general CLI/WS token is never accepted by these routes.
- Verify: integration test in the app's suite that drives the routes (reuse the
  `reference-server.ts` test shape); manual run with the app up.
- Depends on: nothing (contract is fixed).

### W2 - Real ecosystem handlers behind live verbs (medium)

- Where: the bridge host (W1) dispatch table -> Maestro's real services.
- Change: back `sessions.list` with real session metadata (id, title, agentId,
  status, timestamps, projectPath - metadata only, never raw transcript),
  `playbook.list` with the real playbook registry, `cue.observe` with real cue
  subscriptions/recent events, `notify.toast` with the real toast system.
- Acceptance: each `maestro_*` read tool returns real data; `maestro_notify`
  shows a real toast.
- Verify: manual run (demo steps 4); unit tests for each handler mapping with a
  faked service layer.
- Depends on: W1.

### W3 - Session registration -> real store + GUI surface (large)

- Where: main session store/service + renderer session list.
- Change: `session.register` creates/updates a tracked-session record (engine
  `omp`, external origin), `session.event` updates live status/transcript
  metadata, `session.end` finalizes; the renderer shows tracked/external
  sessions in the list with a live indicator and a "reopen / resume" affordance.
- Acceptance: demo steps 2, 3, 5 - a TUI run appears live and is reopenable.
- Verify: manual run with the app; renderer component test for the new list
  entry/state; main-process test for the ingest -> store path.
- Depends on: W1 (transport), W2 (shapes).

### W4 - Maestro -> identity-map for pickup (medium)

- Where: `src/mae/launcher.ts` (`resolveResume`) + a new resolver that consults
  the desktop (via `sessions.list`) and/or the real session store, plus the
  identity map.
- Change: `mae resume` lists real Maestro sessions (not just mae's own map
  entries). For omp-native sessions, resolve the omp resume key for true resume;
  for non-omp sessions, fetch the transcript and start a seeded omp session with
  an explicit "imported as context" banner.
- Acceptance: demo steps 6, 7.
- Verify: launcher test against a faked sessions source; manual run for both
  omp-native and cross-engine cases.
- Depends on: W1/W2 (to query real sessions) and W3 (so GUI-created sessions are
  in the map / queryable).

### W5 - Security hardening to spec (medium, overlaps W1)

- Where: the bridge host.
- Change: route every verb through the plugin security spine model -
  PermissionBroker default-deny, ActionGuard rate/concurrency + audit-before,
  net-egress posture, and the fs/userData exclusions from
  `plugin-build-contract.md:28-62`. Token lifecycle: short TTL, single runId
  binding, revoke on session end, never reuse. Confirm the discovery secret is
  not world-readable.
- Acceptance: rate-limit + audit observable; token cannot be replayed after
  session end; no route reachable without a valid scoped token.
- Verify: targeted tests (rate cap, expiry, replay, dispatch refusal); security
  review against the invariants checklist.
- Depends on: W1.

### W6 - Live-omp verification harness (medium)

- Where: a scripted e2e (outside the unit suite) + a short manual playbook.
- Change: actually launch `omp` with `-e dist/mae/maestro-bridge.extension.mjs`
  in a throwaway repo against a test ingest host (or the real app), drive one
  real turn, and assert: tools register, lifecycle events fire, the session
  registers/streams/ends, and resume works. This closes the "never run in a live
  omp" gap.
- Acceptance: the harness run is green; the 8-step demo is reproducible.
- Verify: the harness itself; recorded run.
- Depends on: W1-W4.

### W7 - Real config overlay defaults (small)

- Where: `src/mae/assets/maestro.config.yml`.
- Change: replace the no-op overlay with confirmed omp config keys (default
  model role, thinking level, approval mode) per omp `config-usage.md`.
- Acceptance: `mae` starts with the intended Maestro defaults.
- Verify: dry-run shows `--config`; live run reflects the defaults.
- Depends on: confirming the omp config schema (research task).

### W8 - Docs + release wiring (small)

- Where: user docs + release pipeline.
- Change: a short "Maestro TUI (`mae`)" how-to (install, `mae`, `mae resume`,
  what the tools do, the Phase 4 note); confirm `build:mae` runs in the release
  build and the `extraResources` land in packaged installs; add the live-omp
  harness to CI where a bun + omp runtime is available (or document as manual).
- Acceptance: a new user can install and run `mae`; packaged app ships the
  launcher + extension.
- Verify: package an install and confirm `mae` + `mae/` resources are present
  and runnable.
- Depends on: W1-W6 (so the docs describe working behavior).

## 6. Sequencing

```
W1 (host) ──┬──> W2 (real handlers) ──┐
            ├──> W5 (security)        ├──> W6 (live-omp e2e) ──> W8 (docs/release)
            └──> W3 (store + GUI) ────┤
                          W4 (pickup) ─┘
W7 (config) is independent; do alongside W1.
```

- **Critical path:** W1 -> {W2, W3} -> W4 -> W6 -> W8. W5 overlaps W1. W7 parallel.
- W1 is the single blocking prerequisite; nothing on the desktop side works until
  the ingest host exists.

## 7. Verification strategy

- Unit/integration on the desktop side mirror `reference-server.ts`'s tests
  (issue, verb allowlist, dispatch refusal, ingest) but against the real
  services with faked dependencies.
- The **authoritative gate is the 8-step demo in section 2**, run manually with
  the real Maestro desktop app + a live omp. Automated coverage reduces manual
  surface but does not replace the demo, because tracking + GUI + live omp can
  only be proven with the app running.
- Keep `bun test src/mae` (omp-side) and the new desktop tests both green.

## 8. Risks and open questions

- **Electron verification loop:** the desktop side can only be validated with the
  app running; budget for manual verification, not just unit tests.
- **Session-store model fit:** Maestro's session store must represent an
  externally-run, omp-engine, possibly-remote session with live status. Confirm
  the schema can hold this without abusing existing fields.
- **Pickup of non-omp sessions** is context-import, not true resume - the UX must
  say so (already designed; must be honored in W4).
- **Token/secret hygiene:** discovery secret rotation + file permissions; never
  expose the general CLI/WS token to the bridge routes.
- **omp config schema** for W7 is unconfirmed; treat as a small research spike.
- **omp API drift:** the extension is pinned to the omp extension API; W6 should
  pin/verify the omp version it runs against.

## 9. Done checklist

- [x] W1 host module + discovery + scoped tokens (`mae-bridge-host.ts`) AND wired
      into the app: `src/main/mae/mae-bridge.ts` (`startMaeBridge`) + `index.ts`
      bootstrap + `before-quit` close + preload `mae` API. Compile-verified
      (tsc-main + eslint). [ ] Runtime behavior needs the running app.
- [x] W2 live-verb binding (`host-service.ts` + `host-mappers.ts`) wired to real
      services in `mae-bridge.ts` (sessions store / playbooks dir / cue engine /
      Electron Notification). Tested (binding) + compile-verified (real services).
- [~] W3 main->preload IPC channel + renderer TYPE contract done + verified
  (`preload/mae.ts` `mae:session*`; `window.maestro.mae` in `global.d.ts`).
  Renderer CONSUMPTION now IMPLEMENTED + compile/lint-verified + **logic
  behavior-tested** (vitest + jsdom, `useMaeBridge.test.ts`, 5 cases:
  buffer-then-flush + arrival order, invalid-payload reject, `maestroSessionId`
  reuse with no dup/clobber, `turn_end` -> idle, end-keeps-row; live GUI
  rendering still needs the running app): `src/renderer/hooks/session/useMaeBridge.ts`
  (wired in `App.tsx`) subscribes to `window.maestro.mae`, validates payloads
  with the protocol guards, and upserts a type-complete synthetic `Session`
  (mirrors `useSessionCrud`; `aiPid: 0`). Correctness baked in: store writes are
  buffered until `sessionsLoaded` then flushed in arrival order (avoids both the
  restoration-clobber race and dropping events the host replays on connect);
  `maestroSessionId` reuses the real row + patches state-only (never overwrites a
  resumed session, no dup); `turn_start/turn_end` -> busy/idle; finalize-but-keep
  on end (reopenable).
  [ ] REMAINING (renderer rendering + the app — NOT an emit change): surface the
  live status the events already carry. The extension emits transcript METADATA
  (`{role,usage}` per message, `{toolName,status}` per tool), which is correct
  per the metadata-only security model (W5: never raw transcript over the
  bridge). The hook maps turn state -> busy/idle today; richer live status (last
  tool, token usage, an activity indicator on the row) is renderer rendering that
  needs the running app to verify. Full conversation view is loaded app-side when
  the session is opened, NOT streamed over the bridge. Plus interaction semantics
  for a process-less external session (don't spawn a local PTY on message-send).
- [~] W4 local-map resume done + tested; contract + mapper carry the resume key
  (`engine`/`ompSessionId`). Host-side GUI-session source now wired + tested:
  `resolveOmpSessionId` extracts the omp resume key from `aiTabs[].agentSessionId`
  (active tab, else first with a key) so `sessions.list` exposes it for
  GUI-created omp sessions. [ ] Runtime (real store data through the app) +
  cross-engine import still need the app.
- [x] W5 security invariants enforced + tested: `bridge-core.ts` (tokens, runId
      binding, caps, 403, revoke) + the emit boundary is metadata-only by test
      (`pickMessageData`/`pickToolData` drop transcript text/content/tool results,
      and `usage` is whitelisted to numeric token fields so nested content can't
      leak; `extension.test.ts`), enforcing "never raw transcript over the bridge".
- [~] W6 live-omp harness written (`harness/live-omp-smoke.ts`); [ ] not run
  (needs a real omp + provider auth).
- [x] W7 config overlay finalized (documented no-op; per-session via passthrough).
- [~] W8 release wiring DONE + verified (`build:mae` artifacts + built launcher
  run; root `bin.mae` / `build:mae` / `typecheck:mae` in lint / `test-mae`
  CI job / `extraResources` / lockfile; `build:main` emits the host CJS).
  Docs DONE: `src/mae/README.md` (architecture + dev orientation + user how-to:
  install, `mae` / `mae resume` / `--mae-dry-run`, in-session tools, Phase 4
  note), CLI grammar verified against the built launcher.
  [ ] Running the actual electron-builder packaged installer is release-env-gated.
- [ ] **The 8-step acceptance demo (section 2) passes end-to-end** (NOT verified;
      requires the running Electron app + live omp, not available in this env).

---

## 10. Implementation status + the exact remaining wiring

### Built and verified in this branch (`src/mae/`)

Verified (current state): `bun test src/mae` -> 68 pass / 0 fail (10 files); the
renderer hook is behavior-tested under vitest + jsdom (`useMaeBridge.test.ts` ->
5 pass), and a `SessionList.test.tsx` case renders an external process-less
`pi`/mae session row (acceptance step 2 at the component level -> 1 pass);
`tsc -p tsconfig.mae.json`, `tsc -p tsconfig.main.json`, `tsc -p
tsconfig.lint.json` (renderer) -> 0 errors each; `eslint` -> 0; prettier clean;
`build:mae` produces `dist/cli/mae.js` + `dist/mae/maestro-bridge.extension.mjs`
and the built launcher resolves them. The host was also smoke-tested **under
Node v24** (the real main-process runtime, not just Bun): bundled to CJS,
started, issued a scoped token, served `sessions.list` (200), and refused
`agent.dispatch` (403). The shipped extension bundle
(`dist/mae/maestro-bridge.extension.mjs`) was likewise smoke-tested under Bun: it
loads and registers all 7 tools + 6 lifecycle handlers against a mock `pi`.
Modules:

- `bridge-core.ts` - the shared security/dispatch core (W1 + W5): per-run scoped
  tokens, TTL expiry, **runId binding** (a token can only touch its own run),
  rate/concurrency caps, dispatch-equivalent refusal (403), revoke-on-end.
- `mae-bridge-host.ts` - the host (W1 module): **loopback-only** `node:http`
  (rejects non-loopback binds), 0600 discovery write, fail-safe teardown if the
  discovery write fails.
- `paths.ts` - shared config-dir + discovery I/O, aligned with Maestro's
  `getConfigDir` (`MAESTRO_USER_DATA` + per-platform, lowercase `maestro`).
- `host-mappers.ts` + `host-service.ts` - W2/W3 binding: pure mappers
  (StoredSession/Cue/Playbook -> bridge metadata) + `createMaeHandlers(deps)`
  that wires injected service callbacks into `BridgeHandlers` (awaitable ingest).
- `reference-server.ts` - refactored onto the core (the literal spec/test target).
- `launcher.ts` - refactored onto `paths.ts`; local-map resume.
- `harness/live-omp-smoke.ts` (W6), `assets/maestro.config.yml` (W7).

### Remaining: the Electron glue (NOT verifiable in this environment)

The MAIN-PROCESS half of this is now IMPLEMENTED and compile-verified (tsc-main +
eslint); only the renderer consumption + the live demo remain (they need the
running app). Status per item below.

**Compilation-boundary constraint (RESOLVED):** `tsconfig.main.json` was
`target/lib: ES2020`, and the `src/mae` host uses `Promise.withResolvers`
(ES2024, mandated by repo rules). Resolved by bumping `tsconfig.main.json` `lib`
to `["ES2024"]` (target stays ES2020 so CJS emit is unchanged; lib only affects
the type surface). Verified: the existing main build still typechecks, and the
main process now imports `src/mae` directly via `host-entry.ts` (no separate
bundle needed - `build:main` emits the imported `src/mae` files as CJS into
`dist/mae/*.js`). The alternative bundle-and-require approach is no longer
needed.

Status of the wiring:

1. [DONE - implemented + tsc-main/eslint verified] `src/main/mae/mae-bridge.ts`: build `MaeHostDeps` (host-service) from
   real services and call `startBridgeHost(createMaeHandlers(deps))`:
   - `getStoredSessions` <- `getSessionsStore().get('sessions', [])`
   - `getPlaybookFiles` <- read `<userData>/playbooks/*.json`
   - `getCueGraph`/`getCueActivity` <- `getCueEngine().getGraphData()` /
     `.getActivityLog(limit)` (guard a null engine)
   - `showToast` <- `new Notification({ title, body }).show()` (electron)
   - `onSessionRegister/Event/End` <- `getMainWindow().webContents.send(
'mae:sessionRegistered'|'mae:sessionEvent'|'mae:sessionEnded', payload)`
2. [DONE] `src/main/index.ts` (after `createWindow()`): `maeBridge = await
startMaeBridge({ getMainWindow, getCueEngine })`; handle held at module scope.
3. [DONE (fallback)] teardown via `app.once('before-quit', () => maeBridge?.close())`
   in `index.ts`. REFINEMENT: for deterministic cleanup, thread a `closeMaeBridge`
   callback into `quit-handler.ts`'s async shutdown path (beside
   `deleteCliServerInfo()`); a lingering discovery file is otherwise harmless
   (rotated + 0600 + overwritten next launch).
4. [DONE] `src/main/preload/index.ts` + `preload/mae.ts`: `mae: createMaeApi()` exposing
   `onMaeSessionRegistered/Event/Ended(cb)` (copy the `preload/sessions.ts`
   `ipcRenderer.on -> unsubscribe` pattern).
5. [DONE - implemented + tsc/eslint verified; runtime needs the app]
   `src/renderer/hooks/session/useMaeBridge.ts` (registered in `App.tsx`):
   validates each payload with the protocol guards
   (`parseSessionRegister/Event/End`), then upserts into `useSessionStore` -
   subscribes immediately but buffers store writes until `sessionsLoaded`, then
   flushes in arrival order (no clobber, no drop). Keys off `maestroSessionId`
   when a run resumed a real Maestro session (reuse + state-only patch, never a
   blind `addSession` that would clobber/duplicate); else creates a
   `mae:<ompSessionId>` synthetic `Session` mirroring `useSessionCrud` (~line
   220: all required fields + one `AITab`); `toolType: 'pi'` avoids an `AGENT_IDS`
   exhaustiveness ripple; `turn_start` -> `busy`, `turn_end` -> `idle`,
   `session.end` -> finalize to `idle` but KEEP (reopenable, acceptance step 5);
   never `removeSession` on end. CAUTION (still needs the live app): an
   externally-run session has no LOCAL process (`aiPid: 0`), so interaction
   semantics - the renderer must NOT spawn a PTY / route input on message-send -
   are unverified and a remaining refinement. Optionally add an "OMP" badge in
   `SessionItem`.
6. [DONE host-side - tsc/bun verified; runtime needs app] W4: the omp resume key
   (`ompSessionId`) is surfaced on omp-native `sessions.list` entries via
   `resolveOmpSessionId` in `host-mappers.ts` - it reads the active omp
   `aiTabs[].agentSessionId` (else the first tab with one), since GUI-created
   sessions keep the key in the tab, not at the top level. Unit-tested.
   [ ] Real store data + non-omp cross-engine import (fetch transcript -> seeded
   omp session) still need the running app.

### Acceptance audit (section 2, current state)

The 8-step live demo is the authoritative gate and is **NOT verified** - it
needs the running app + live omp. Per step: (1) launcher composes a valid omp
invocation [verified via dry-run]; (2-5) the main-side host + ingest + real
toolset are now wired into the app and compile-verified (tsc-main + eslint), and
the renderer consumption (item 5) is implemented + compile/lint-verified and its
logic is behavior-tested; step (2) "appears in the list" is verified at the
component level (SessionList renders the external process-less session); the live
end-to-end GUI + interaction still need the running app; (6-7) resume now has its
host-side session source wired + unit-tested
(item 6: `resolveOmpSessionId` extracts the omp key from the aiTab) [real store
data + cross-engine import still app-gated];
(8) dispatch verbs are inert [verified: core + host tests]. The renderer
consumption (item 5) has now landed (compile/lint-verified); the goal remains
active until its runtime behavior + the 8-step demo are proven against a real app.

## 11. Seamless-integration roadmap (beyond the bridge)

§2 defines "feature complete" as the live demo; this section captures what makes
the integration feel SEAMLESS in the GUI, grounded in the real ecosystem. Full
end-to-end seamlessness needs the running app, but several subitems are
compile/unit-verifiable here once the branches are reconciled (id unification +
mapper/hook/component updates and their tests - as W4 and the SessionList test
already showed). The live launch/theme/transcript behavior is the app-gated part.

**Key reframe - two INTENTIONAL, complementary omp products (NOT one to merge):**

- `.worktrees/omp-agent` (`feat/omp-agent`): omp as a HEADLESS JSON-line agent
  (id `'omp'`, `command:'omp'`, `-p` batch prefix, `--mode json`, `--resume`),
  for users who do NOT want the TUI. Ships independently; no bridge.
- this branch (`feat/maestro-coding-agent`): `mae`, the Maestro-BRANDED
  interactive TUI with deep ecosystem integration (reach-back tools + live
  tracking + resume via the bridge).

Seamless = each product is polished on its own AND the two coexist without
colliding (distinct identities, shared session store + resume key). They are
deliberately NOT collapsed into a single agent.

1. **GUI launch (highest impact).** `mae` is terminal-CLI-only today. Add a
   NewInstanceModal "Maestro TUI (omp)" entry that opens an interactive PTY
   terminal tab running `mae` (Maestro already has xterm terminal tabs and a
   `'terminal'` agent id). Then a user starts a tracked omp TUI from the GUI, not
   by hand in a shell.
2. **Branded identity for the TUI - DONE (compile/unit-verified).** `mae`'s
   tracked sessions now carry a dedicated `'mae'` `AGENT_ID` (display "Maestro
   TUI", `agentIcons` 🎼), distinct from the headless `'omp'` agent. Implemented:
   `'mae'` in `AGENT_IDS` + `AGENT_DISPLAY_NAMES` / `BETA_AGENTS`; a hidden,
   `requiresPty` `AGENT_DEFINITIONS` entry (`command:'mae'`) + conservative
   `AGENT_CAPABILITIES` mirroring `terminal`; excluded from create/spawn
   `VALID_TYPES` (create-agent + messageHandlers) like `terminal`; `useMaeBridge`
   - `host-mappers` + the SessionList test switched to `'mae'`. BACKWARD-COMPAT:
     `isOmpEngine` still accepts `omp | mae | pi`, so legacy/`'pi'` rows resolve +
     resume. Verified: all tsc gates 0; `agent-completeness` green (incl. new "mae
     is a hidden PTY identity, not a JSON-spawn agent" assertions); bun mae + the
     renderer tests pass. The two products coexist (`'omp'` headless vs `'mae'` TUI),
     sharing only `ompSessionId` (item 3).
   * **Recursive-spawn foot-gun - GUARDED (code + test).** The `'mae'` definition
     carries `command:'mae'`, so a stored `toolType:'mae'` reaching the spawner
     would launch `mae` recursively on send. The `process:spawn` IPC handler now
     rejects `toolType === 'mae'` up front (returns `{pid:-1, success:false}`
     before `getAgent`/spawn), tested in `process.test.ts` (asserts spawn +
     getAgent are never called). GUI launch (item 1) will run mae as a terminal
     tab, not via this agent path. RESIDUAL (app-gated): the full tracked-session
     interaction UX (what the GUI shows when you open/select a process-less mae
     row) still needs the running app, but the dangerous recursive spawn is closed.
3. **Shared session store + resume.** W4 `resolveOmpSessionId` reads
   `aiTabs[].agentSessionId`, exactly where BOTH paths store omp's resume key -
   so `mae resume` can continue a session whether it was started headless or in
   the TUI, as long as both write the same shared session store. Mostly handled;
   confirm on merge.
4. **Theme passthrough.** Pass Maestro's active theme into omp's TUI (config
   overlay or env) so the terminal matches the app visually. Polish.
5. **Cross-engine transcript view.** Opening a tracked mae/omp session in the GUI
   should render its conversation by loading omp's session file APP-SIDE on open;
   the metadata-only bridge stays unchanged (never streams raw transcript).
6. **Later / Phase-4-gated.** Symphony + cue-emit participation (mae sessions
   addressable by orchestration / able to fire cues) ride the same dispatch-verb
   gating as §3. Surfacing mae defaults (model, approval mode, thinking) in the
   Maestro Settings UI is optional polish over the existing `--config` overlay.
7. **First-run config import - DONE (implemented + tested).** Because `mae` runs
   omp under an isolated `--profile maestro`, it doesn't inherit the user's
   existing omp config. `src/mae/omp-settings.ts` (`detectCopyableOmpSettings` +
   `copyOmpSettings`) detects a default omp setup (`~/.omp/agent`); on a fresh
   Maestro profile the launcher offers to copy declarative config (`config.yml`,
   `settings.json`, `mcp.json`, `lsp.json`, `skills/ rules/ prompts/ instructions/
commands/ hooks/ tools/ extensions/`) into `~/.omp/profiles/maestro/agent`.
   TTY-only prompt (scripts skip); flags `--copy-omp-settings` /
   `--no-copy-omp-settings`; never on `--mae-dry-run`/resume; backs up existing
   profile files (`*.pre-mae-*`), never reads contents. SECURITY: never copies the
   auth/login store (`agent.db`) or state, and the prompt states the copied config
   may include user-set secrets. Verified by `omp-settings.test.ts` (detect,
   allowlist copy, exclusions, backup) + offer-orchestration tests.

**Non-gaps (confirmed in code):** provider auth needs no passthrough - each agent
CLI (omp included) manages its own auth, and agent defs already support
`defaultEnvVars` / `readOnlyEnvOverrides` / `batchModeEnvVars` if env is ever
needed.
