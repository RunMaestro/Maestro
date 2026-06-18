# CLAUDE-PERFORMANCE.md

Performance best practices for the Maestro codebase. For the main guide, see [[CLAUDE.md]].

## React Component Optimization

**Use `React.memo` for list item components:**

```typescript
// Components rendered in arrays (tabs, agents, list items) should be memoized
const Tab = memo(function Tab({ tab, isActive, ... }: TabProps) {
  // Memoize computed values that depend on props
  const displayName = useMemo(() => getTabDisplayName(tab), [tab.name, tab.agentSessionId]);

  // Memoize style objects to prevent new references on every render
  const tabStyle = useMemo(() => ({
    borderRadius: '6px',
    backgroundColor: isActive ? theme.colors.accent : 'transparent',
  } as React.CSSProperties), [isActive, theme.colors.accent]);

  return <div style={tabStyle}>{displayName}</div>;
});
```

**Consolidate chained `useMemo` calls:**

```typescript
// BAD: Multiple dependent useMemo calls create cascade re-computations
const filtered = useMemo(() => agents.filter(...), [agents]);
const sorted = useMemo(() => filtered.sort(...), [filtered]);
const grouped = useMemo(() => groupBy(sorted, ...), [sorted]);

// GOOD: Single useMemo with all transformations
const { filtered, sorted, grouped } = useMemo(() => {
  const filtered = agents.filter(...);
  const sorted = filtered.sort(...);
  const grouped = groupBy(sorted, ...);
  return { filtered, sorted, grouped };
}, [agents]);
```

**Pre-compile regex patterns at module level:**

```typescript
// BAD: Regex compiled on every render
const Component = () => {
	const cleaned = text.replace(/^(\p{Emoji})+\s*/u, '');
};

// GOOD: Compile once at module load
const LEADING_EMOJI_REGEX = /^(\p{Emoji})+\s*/u;
const Component = () => {
	const cleaned = text.replace(LEADING_EMOJI_REGEX, '');
};
```

**Memoize helper function results used in render body:**

```typescript
// BAD: O(n) lookup on every keystroke (runs on every render)
const activeTab = activeSession ? getActiveTab(activeSession) : undefined;
// Then used multiple times in JSX...

// GOOD: Memoize once, use everywhere
const activeTab = useMemo(
	() => (activeSession ? getActiveTab(activeSession) : undefined),
	[activeSession?.aiTabs, activeSession?.activeTabId]
);
// Use activeTab directly in JSX - no repeated lookups
```

## Data Structure Pre-computation

**Build indices once, reuse in renders:**

```typescript
// BAD: O(n) tree traversal on every markdown render
const result = remarkFileLinks({ fileTree, cwd });

// GOOD: Build index once when fileTree changes, pass to renders
const indices = useMemo(() => buildFileTreeIndices(fileTree), [fileTree]);
const result = remarkFileLinks({ indices, cwd });
```

## Main Process (Node.js)

**Cache expensive lookups:**

```typescript
// BAD: Synchronous file check on every shell spawn
fs.accessSync(shellPath, fs.constants.X_OK);

// GOOD: Cache resolved paths
const shellPathCache = new Map<string, string>();
const cached = shellPathCache.get(shell);
if (cached) return cached;
// ... resolve and cache
shellPathCache.set(shell, resolved);
```

**Use async file operations:**

```typescript
// BAD: Blocking the main process
fs.unlinkSync(tempFile);

// GOOD: Non-blocking cleanup
import * as fsPromises from 'fs/promises';
fsPromises.unlink(tempFile).catch(() => {});
```

## Debouncing and Throttling

**Use debouncing for persistence:**

Session persistence is debounced through `useDebouncedPersistence(sessions, initialLoadComplete, delay)`
in `src/renderer/hooks/utils/useDebouncedPersistence.ts` — it returns
`{ isPending, flushNow }`. The hook already wires up `visibilitychange` and
`beforeunload` to flush pending writes internally; do **not** add a second set
of handlers in your component.

**Debounce expensive search operations:**

```typescript
// BAD: Fuzzy matching all files on every keystroke
const suggestions = useMemo(() => {
	return getAtMentionSuggestions(atMentionFilter); // Runs 2000+ fuzzy matches per keystroke
}, [atMentionFilter]);

// GOOD: Debounce the filter value first (100ms is imperceptible)
const debouncedFilter = useDebouncedValue(atMentionFilter, 100);
const suggestions = useMemo(() => {
	return getAtMentionSuggestions(debouncedFilter); // Only runs after user stops typing
}, [debouncedFilter]);
```

**Prefer `useDeferredValue` when the cost is React render work, not I/O:**

`useDebouncedValue` waits a fixed timer; `useDeferredValue` lets React drop
stale work mid-render with no timer. Use it when the heavy operation is a
React re-render (filter + sort + categorize a list, render a markdown subtree)
rather than an external API or fuzzy-search lib. Always keep the input
`value=` bound to the immediate state — only pass the deferred copy to the
heavy consumer.

```typescript
const [filter, setFilter] = useState('');
const deferredFilter = useDeferredValue(filter);

// Input stays responsive (immediate value)
<input value={filter} onChange={(e) => setFilter(e.target.value)} />

// Heavy categorize/sort runs against the deferred copy
const { sortedFilteredSessions } = useSessionCategories(deferredFilter, ...);
```

In jsdom/RTL the deferred value equals the immediate value synchronously, so
existing tests keep passing — see `src/__tests__/renderer/hooks/useInputHandlers.test.ts:353`
for the precedent.

**Use throttling for high-frequency events:**

```typescript
// Scroll handlers should be throttled to ~4ms (240fps max)
const handleScroll = useThrottledCallback(() => {
	// expensive scroll logic
}, 4);
```

## Update Batching

**Batch rapid state updates during streaming:**

```typescript
// During AI streaming, IPC triggers 100+ updates/second
// Without batching: 100+ React re-renders/second
// With batching at 200ms: ~5 renders/second
// See: src/renderer/hooks/session/useBatchedSessionUpdates.ts

// Update types that get batched:
// - appendLog (accumulated via string chunks)
// - setStatus (last wins)
// - updateUsage (accumulated)
// - updateContextUsage (high water mark - never decreases)
```

## Virtual Scrolling

**Use virtual scrolling for large lists (100+ items):**

```typescript
// See: src/renderer/components/HistoryPanel.tsx
import { useVirtualizer } from '@tanstack/react-virtual';

const virtualizer = useVirtualizer({
	count: items.length,
	getScrollElement: () => scrollRef.current,
	estimateSize: () => 40, // estimated row height
});
```

## Per-Row DOM Budget

A list row component should aim for **<30 DOM nodes per row**. CDP profiling
caught the left bar at ~56 nodes/row × 34 rows = 1,907 nodes; at 100+ rows
this dominates layout/style cost even with `React.memo`. When both budgets
(>30 nodes/row AND >30 rows possible) are exceeded:

1. **Slim the row first** — lazy-mount hover-only controls, drop redundant
   wrappers, replace decorative inline `<svg>` with CSS background-mask. Inline
   SVG carries paint cost beyond its node count; reserve it for icons that
   actually re-color or animate per row.
2. **Then virtualize** with `@tanstack/react-virtual` (already installed).
   Be aware: virtualization breaks scroll-to-active, drag-and-drop measurement,
   keyboard nav across off-screen rows, and any `querySelector` over the full
   list. Plan for those.

## IPC Payload Hygiene

When state is large (sessions, history, file trees), avoid IPC patterns that
ship the entire collection on every change:

```typescript
// BAD: clones and ships ALL sessions (with logs, tabs, browser state) on any
// single-session change. Observed >500 MB short-lived heap churn from this
// pattern in CDP profiling — the clone itself is the cost, not the disk write.
window.maestro.sessions.setAll(allSessions);

// GOOD: track dirty IDs in the store; ship only the changed subset.
window.maestro.sessions.setMany([sessionId]);
```

Even when the disk write is debounced, `prepare*ForPersistence` allocates a
full new tree per flush. Add a `setMany`-style IPC path before reaching for
"smarter" diffing.

## React State Bail-out — Don't Over-Guard

`setState(samePrimitive)` is already a render-bail in React. Don't add
manual guards "to prevent re-renders":

```typescript
// UNNECESSARY: React already bails out
if (!isPending) setIsPending(true);

// FINE — same render cost
setIsPending(true);
```

Real perf cost lives in the **work** (data prep, allocations, child re-renders
through unstable refs), not the duplicate set call. Profile before guarding.

## IPC Parallelization

**Parallelize independent async operations:**

```typescript
// BAD: Sequential awaits (4 × 50ms = 200ms)
const branches = await git.branch(cwd);
const remotes = await git.remote(cwd);
const status = await git.status(cwd);

// GOOD: Parallel execution (max 50ms = 4x faster)
const [branches, remotes, status] = await Promise.all([
	git.branch(cwd),
	git.remote(cwd),
	git.status(cwd),
]);
```

## Visibility-Aware Operations

**Pause background operations when app is hidden:**

```typescript
// See: src/renderer/hooks/git/useGitStatusPolling.ts
const handleVisibilityChange = () => {
	if (document.hidden) {
		stopPolling(); // Save battery/CPU when backgrounded
	} else {
		startPolling();
	}
};
document.addEventListener('visibilitychange', handleVisibilityChange);
```

## Context Provider Memoization

**Always memoize context values:**

```typescript
// BAD: New object on every render triggers all consumers to re-render
return <Context.Provider value={{ agents, updateAgent }}>{children}</Context.Provider>;

// GOOD: Memoized value only changes when dependencies change
const contextValue = useMemo(() => ({
  agents,
  updateAgent,
}), [agents, updateAgent]);
return <Context.Provider value={contextValue}>{children}</Context.Provider>;
```

## Event Listeners

Use `useEventListener()` from `src/renderer/hooks/utils/useEventListener.ts`
instead of pairing raw `addEventListener` / `removeEventListener` inside a
`useEffect`. The hook handles cleanup, ref-stable handlers, and SSR safety.
See the canonical-utilities table in [[CLAUDE.md]] for the full rule.

## Performance Profiling

For React DevTools profiling workflow, see [[CONTRIBUTING.md#profiling]].

### CDP Snapshot (dev mode)

Maestro exposes Chrome DevTools Protocol on `ws://localhost:12345` in dev mode
(see `src/main/index.ts` `--remote-debugging-port`). Useful for taking a quick
performance snapshot from a script without opening DevTools:

```bash
# Get the renderer page id
curl -s http://localhost:12345/json/list
```

Then send `Performance.enable` + `Performance.getMetrics` over the page's
`webSocketDebuggerUrl`, optionally followed by `Profiler.start` / wait /
`Profiler.stop` and aggregate `samples`/`timeDeltas` by node id. Force a clean
heap reading first via `HeapProfiler.enable` + `HeapProfiler.collectGarbage`.

Resting-state baselines (no terminals/canvas mounted, post-GC):

| Metric                  | Healthy budget                            |
| ----------------------- | ----------------------------------------- |
| `Nodes`                 | < 5,000                                   |
| `JSEventListeners`      | < 0.2 × visible-DOM-nodes                 |
| `JSHeapUsedSize`        | < 250 MB after GC                         |
| Max frame in 60 samples | < 32 ms (anything larger = jank to chase) |

`Documents: 2` is usually benign (DOMParser/sanitizer doc) — only investigate
if iframes/webviews are also reported by `document.querySelectorAll`.

### Chrome DevTools Performance Traces

**Exporting DevTools Performance traces:**

The Chrome DevTools Performance panel's "Save profile" button fails in Electron with:

```
NotAllowedError: The request is not allowed by the user agent or the platform in the current context.
```

This occurs because Electron 28 doesn't fully support the File System Access API (`showSaveFilePicker`). Full support was added in Electron 30+ ([electron/electron#41419](https://github.com/electron/electron/pull/41419)).

**Workarounds:**

1. **Launch with experimental flag** (enables FSAA):

   ```bash
   # macOS
   /Applications/Maestro.app/Contents/MacOS/Maestro --enable-experimental-web-platform-features

   # Development
   npm run dev -- --enable-experimental-web-platform-features
   ```

2. **Use Maestro's native save dialog** (copy trace JSON from DevTools, then in renderer console):

   ```javascript
   navigator.clipboard
   	.readText()
   	.then((data) => window.maestro.dialog.saveFile({ defaultPath: 'trace.json', content: data }));
   ```

3. **Right-click context menu** - Right-click on the flame graph and select "Save profile..." which may use a different code path.
