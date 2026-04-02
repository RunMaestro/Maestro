# Phase 09: Run Metrics And Playbook Analytics

This phase extends existing history and stats paths with scheduler-aware analytics. Do not create a second metrics pipeline.

## Tasks

- [ ] Extend the existing stats and history persistence path so node-level and run-level metrics record scheduler status, queue wait time, duration, retry count, timeout status, verifier verdict, agent strategy, prompt profile, and worktree mode without breaking older records.
- [ ] Add backward-compatible migrations and typed adapters for the new analytics fields in the existing stats modules and shared history types, keeping older Auto Run entries readable without synthetic backfills.
- [ ] Extend the current History and Usage Dashboard surfaces in `src/renderer/components/History/HistoryEntryItem.tsx`, `src/renderer/components/HistoryDetailModal.tsx`, `src/renderer/components/UsageDashboard/AgentEfficiencyChart.tsx`, `src/renderer/components/UsageDashboard/LongestAutoRunsTable.tsx`, and `src/renderer/components/UsageDashboard/SessionStats.tsx` so users can inspect or filter by verifier verdict, scheduler outcome, playbook, prompt profile, agent strategy, and worktree mode using the existing UI patterns instead of introducing a separate analytics interface.
- [ ] Add focused tests for metrics persistence, migration safety, and verdict-aware filtering, then run one sequential playbook and one DAG playbook against real or seeded data to confirm the analytics path is observable from day one.
