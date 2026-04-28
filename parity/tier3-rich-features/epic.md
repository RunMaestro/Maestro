# Tier 3 — Rich features (stub)

High-effort feature ports. Each is a multi-day project on its own.

## Candidate tasks

- Wizard / Tour system on mobile — guided onboarding for first-time mobile users
- Group Chat panel — multi-agent conversations
- Playground panel — system-prompt testing with live execution
- Advanced file preview features — Mermaid rendering, CSV table renderer, Git diff viewer, image diff
- Usage Dashboard — charts, time-series data, cost breakdown
- Document Graph — graph visualization of document relationships

## Why deferred

Each item here is large enough to deserve its own RFC and multi-PR rollout. We don't author task docs until Tier 1 + Tier 2 validate the patterns and we have user signal that any of these are needed on mobile.

## Expansion criteria

Per item:

1. Validate user demand (mobile users actually want this — check feedback, issues)
2. Estimate via spike (~half-day investigation)
3. Decompose into ≥3 independent tasks if possible
4. Promote to its own folder under tier 3 with its own epic + task docs

## Architectural risks

- Mobile bundle size grows with every chart library, graph library, etc. — budget carefully
- Some features (Group Chat especially) require new desktop→web data flows that don't exist yet
- Usage Dashboard depends on `stats-db.ts` being queryable from web — currently desktop-only access pattern
