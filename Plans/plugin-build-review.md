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

## Deferred / unwired

- 2026-06-25: Phase 1 contributions (themes/prompts/settings/command-macros) are
  validated, aggregated, and exposed via `plugins:contributions`, but NOT yet
  consumed by the host registries (theme picker, prompt catalog, command palette).
  That consumption is item 4 of the build plan.
