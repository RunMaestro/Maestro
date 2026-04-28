# Tier 4 — Heavy IPC features (stub)

Very-high-effort features that require deep desktop↔web plumbing changes. Likely require an RFC and architectural decision before any task work begins.

## Candidate tasks

- Full Settings UI on mobile — currently broadcast read-only; making it editable requires bidirectional sync + permission gating
- Marketplace modal — plugin/template browsing with installation actions
- Symphony modal — batch playbook runner UI
- Leaderboard registration — auth flow, profile management
- Director's Notes editor — currently read-only stub; editing changes the data model
- Worktree management UI — create/delete/merge worktrees from mobile

## Why "very high effort"

Each item requires:

- New WebSocket message types (web → desktop write requests)
- Permission/authentication model (mobile clients are remote — must we allow them to mutate settings?)
- Conflict resolution (what if desktop and mobile edit the same setting simultaneously?)
- New bundles/libraries that bloat mobile

## Expansion criteria

Do not author task docs in this tier until:

1. Tier 1, 2, and at least one Tier 3 feature have shipped
2. A maintainer-approved RFC exists for the bidirectional-write pattern
3. User signal justifies the cost (concrete asks, not speculative wants)

## Architectural decisions needed (RFC topics)

- **Authoritative ownership.** Desktop owns mutation today. Does that change, or do we add a "mobile requests write, desktop confirms" flow?
- **Auth model.** Web clients connect via security token in the URL. For mutations, do we layer on per-session permissions?
- **Conflict resolution.** Last-write-wins? Optimistic with rollback? Lock-based?

Until these are answered, anything in this tier is premature.
