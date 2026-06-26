# Plugin build - review log

Running list of things to look at later: unilateral design calls, security
caveats, deferred/unwired capabilities, relaxed tests, TODOs, assumptions.
Append-only, dated. Newest at the bottom of each section.

## Security (Phase 3 sandbox/broker/signing)

- 2026-06-25: A multi-agent security red-team ran over the Phase 3 surface.
  CRITICAL/HIGH findings were all fixed (see commit). Residual notes below.
- 2026-06-25: `vm` is NOT a hard sandbox. We removed host intrinsics from the
  context global, disabled codeGeneration, and wrapped timers, but a determined
  V8 realm escape would get full Node in the (empty-env, secret-free)
  utilityProcess and bypass the broker. Primary defenses remain signature trust +
  consent. `src/main/plugins/plugin-sandbox-entry.ts` threat-model comment.
- 2026-06-25: `agents.dispatch` and `process.spawn` host methods are intentionally
  NOT wired (`src/main/index.ts` plugin handler block) - the broker may grant
  them but the host returns "not implemented". Wire only after a dedicated review
  of the dispatch/SSH path. `src/main/plugins/plugin-host-handlers.ts`.
- 2026-06-25: `net.fetch` forces `redirect:'error'` and allowlists init
  (method/body/headers). It does NOT yet block private-IP/loopback targets when a
  plugin holds an UNSCOPED net grant; the consent copy warns instead. Consider an
  IP-range guard. `src/main/plugins/plugin-host-handlers.ts` net.fetch.
- 2026-06-25: `extractTarget` host scope uses `URL.hostname`; IPv6-mapped forms
  (`[::ffff:127.0.0.1]`) are not normalized to their IPv4 equivalent, so an
  IP-based net grant could be dodged via IPv6 encoding. Low risk (grants are
  usually by domain). `src/shared/plugins/rpc-protocol.ts:hostnameOf`.
- 2026-06-25: `settings.get` uses a broad denylist regex for secret keys. A
  denylist always has gaps; long-term, secrets should not be reachable via the
  generic settings channel at all. `src/main/plugins/plugin-host-handlers.ts`.
- 2026-06-25: Install copies files first, then verifies signature on refresh; an
  invalid-signature plugin lands on disk (marked invalid, never runs) until
  uninstalled. Acceptable but could verify-before-copy. `plugin-manager.ts:install`.

## Phase 2 (scheduler)

- 2026-06-25: Deeper Cue-engine integration is deferred. The Cue engine is
  strictly per-project (cue.yaml per session/root) and flagged complex
  (CLAUDE-CUE.md). Plugin `cueTriggers` are global, so they run on a separate
  supervised scheduler (`plugin-scheduler-host.ts`) instead of being injected
  into the Cue engine. File/agent-completion EVENT triggers (vs time-based) and
  the `dispatch` action are NOT wired - dispatch needs the agents:dispatch
  capability review. Scheduler state is in-memory: interval triggers re-seed on
  app restart (a long interval effectively restarts its clock each launch).

## Phase 4 (UI contributions)

- 2026-06-25: SECURITY CAVEAT - a plugin PANEL's iframe (`PluginPanelHost.tsx`)
  runs with `sandbox="allow-scripts"` (no allow-same-origin, opaque origin, no
  app DOM/cookies/storage access, no top-nav). BUT iframe script can still make
  arbitrary `fetch`/network requests directly - that path is NOT the permission
  broker (the broker only gates the utilityProcess sandbox's RPC). A panel can
  therefore exfiltrate over the network outside the capability model. Reasonable
  mitigation later: serve panel assets over a custom Electron protocol with a
  strict CSP response header (a CSP cannot be trusted from inside srcDoc). For
  now, enabling a tier-1 plugin is the consent gate. `PluginPanelHost.tsx`.
- 2026-06-25: Plugin commands/panels are surfaced in the Plugins settings panel
  only (per-plugin buttons). They are NOT yet merged into the global command
  palette (QuickActions) - that is consumption item 4.
- 2026-06-25: PluginsPanel.tsx is growing; if it crosses ~800 lines, split the
  row + commands/panels section into a child component.

## Deferred / unwired

- 2026-06-25: Phase 1 contributions (themes/prompts/settings/command-macros) are
  validated, aggregated, and exposed via `plugins:contributions`, but NOT yet
  consumed by the host registries (theme picker, prompt catalog, command palette).
  That consumption is item 4 of the build plan.
