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

## Phase 5 (runtime agent registration)

- 2026-06-25: DESIGN CALL - kept the compile-time `AGENT_IDS` tuple as the
  built-in core instead of converting it wholesale to a runtime structure. A full
  tuple->runtime conversion would erase the `AgentId` union's exhaustiveness
  across every `Record<AgentId, X>`, switch, parser, storage and capability table
  (a sweeping, destabilizing change). Instead `src/shared/plugins/agent-registry.ts`
  layers plugin-contributed agents ALONGSIDE the built-ins: built-ins stay fully
  type-checked, runtime agents are plain string ids looked up via the registry.
  The registry refuses to let a plugin shadow a built-in id.
- 2026-06-25: `agent-completeness.test.ts` was NOT loosened in its assertions; it
  already only validated the static tables. I documented the scope boundary in its
  header and added a `runtime agents live outside the static core` block asserting
  a registered runtime agent is known to the registry but absent from AGENT_IDS /
  AGENT_DEFINITIONS. The relaxation is: plugin agents are explicitly exempt from
  the static completeness invariant (covered by the registry instead).
- 2026-06-25: SECURITY/DEFERRED - registration does NOT enable spawning. A
  runtime agent's `binaryName` is validated to a bare command name (no path
  separators, no `..`, no `~`, charset-restricted) but `PluginManager.getAgentRegistry()`
  only exposes agents for discovery/UI. Actually launching one is arbitrary binary
  execution and must go through the same dedicated review as `agents.dispatch` /
  `process.spawn` (still unwired). Spawn wiring + Left Bar creation of plugin
  agents is the follow-on. `src/main/plugins/plugin-manager.ts:getAgentRegistry`.
- 2026-06-25: `contributes.agents` is tier-1 gated (like commands/panels) since a
  runtime agent runs a CLI. The registry is not yet surfaced over IPC to the
  renderer - the Left Bar "new agent" picker does not list plugin agents yet
  (pairs with the deferred spawn wiring above).

## Consumption wiring (item 4)

- 2026-06-25: Built the renderer read seam: `usePluginContributions` hook
  (fetch on mount + re-fetch on a new `plugins.onChanged` preload event; empty
  when Encore off) and `theme-bridge.ts` (pure: overlay a plugin theme's loose
  colors onto a base palette, filtering to recognized ThemeColors keys).
- 2026-06-25: THEMES - plugin themes now appear in the Settings theme picker
  (`AppStandaloneModals` merges them into the `themes` prop) and are selectable.
  `App.tsx` resolves an active plugin theme id (outside the built-in ThemeId
  union) and falls back to dracula if the plugin was removed, so the app never
  renders an undefined theme. Base palettes: dracula (dark), github-light (light)
  via `renderer/utils/pluginThemes.ts`. Plugin themes are not editable like the
  custom theme; that is acceptable (contributions are read-only).
- 2026-06-25: COMMAND MACROS - surfaced in the Cmd-K palette as
  'Macro: <title>' actions; selecting one sends the templated prompt to the
  active agent via `processInput` (threaded App -> AppModals -> AppUtilityModals
  -> QuickActionsModal as `onRunPromptMacro`). `processInput(text)` is the same
  path a typed message takes, so this is the canonical send, not a fragile
  inputValue/autoSend hack.
- 2026-06-25: PROMPTS - plugin prompts appear in Settings > Maestro Prompts under
  a read-only 'Plugin Prompts' category (save/reset/edit/preview disabled, content
  shown read-only). DEFERRED: plugin prompts are view-only there; one-click
  "insert/run this prompt" (like macros) is a possible later enhancement. Kept the
  explicit catalog-vs-palette split from the directive. `MaestroPromptsTab.tsx`.
- 2026-06-25: `contributes.settings` is aggregated/exposed but still NOT consumed
  by any settings UI (no host surface renders plugin-declared settings yet). The
  other three Phase 1 buckets (themes/prompts/commandMacros) are now consumed.
