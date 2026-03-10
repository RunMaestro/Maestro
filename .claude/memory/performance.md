# Performance Patterns

## React Optimization

- **Memoize list items** with `React.memo` (tabs, agents, list items)
- **Consolidate chained `useMemo`** into single computation
- **Pre-compile regex** at module level, not in render
- **Build Map indices** once for O(1) lookups instead of `Array.find()` in loops

```typescript
// BAD: O(n) per iteration
agents.filter(a => groups.find(g => g.id === a.groupId));
// GOOD: O(1) lookup
const groupsById = useMemo(() => new Map(groups.map(g => [g.id, g])), [groups]);
agents.filter(a => groupsById.get(a.groupId));
```

## Debouncing & Throttling

- **Session persistence**: 2s debounce (`useDebouncedPersistence`)
- **Search/filter**: 100ms debounce on keystroke-driven operations
- **Scroll handlers**: 4ms throttle (~240fps max)
- **Auto Run save**: 5s debounce for document auto-save
- **Always flush** on `visibilitychange` and `beforeunload`

## Update Batching

During AI streaming, IPC triggers 100+ updates/second. Batch at 150ms → ~6 renders/second.
See `src/renderer/hooks/session/useBatchedSessionUpdates.ts`

## Main Process

- **Cache shell paths** in Map for repeated lookups
- **Use async fs** operations (`fs/promises`), never sync in main process
- **Lazy debug logging**: `debugLogLazy('prefix', () => expensiveString)` for hot paths
- **Memory monitoring**: Warns at 500MB heap every 60s (Sentry breadcrumbs)

## Virtual Scrolling

Use `@tanstack/react-virtual` for lists >100 items (see `HistoryPanel.tsx`).

## IPC Parallelization

```typescript
// GOOD: parallel execution
const [branches, remotes, status] = await Promise.all([
  git.branch(cwd), git.remote(cwd), git.status(cwd)
]);
```

## Visibility-Aware Operations

Pause polling/timers when app is backgrounded:
```typescript
if (document.hidden) stopPolling(); else startPolling();
```

## Context Provider Memoization

Always memoize context values to prevent consumer re-renders.
