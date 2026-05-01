# CLAUDE-FEATURES.md

Feature documentation for Usage Dashboard and Document Graph. For the main guide, see [[CLAUDE.md]].

## Usage Dashboard

The Usage Dashboard (`src/renderer/components/UsageDashboard/`) provides analytics and visualizations for AI agent usage.

### Architecture

```
src/renderer/components/UsageDashboard/
├── UsageDashboardModal.tsx      # Main modal — view tabs: Overview, Agents, Agent Overview, Activity, Auto Run (+ Cue when both Encore flags are on)
├── SummaryCards.tsx             # 12 metric cards (queries, duration, top agent, streak, best day, active days, worktree %, etc.)
├── AgentOverviewCards.tsx       # Per-agent overview cards (Agents tab)
├── SessionStats.tsx             # Session statistics (Agent Overview tab)
├── AgentEfficiencyChart.tsx     # Agent efficiency chart (Agent Overview tab)
├── AgentComparisonChart.tsx     # Bar chart comparing provider usage
├── AgentUsageChart.tsx          # Per-agent usage over time
├── WorktreeAnalytics.tsx        # Worktree-child session analytics
├── SourceDistributionChart.tsx  # Pie chart for user vs auto queries
├── LocationDistributionChart.tsx # Local vs remote distribution
├── RadialActivityChart.tsx      # Polar chart pair: hour-of-day + day-of-week (replaces flat Peak Hours)
├── YearInPixelsStrip.tsx        # Time-range-adaptive day-cell hero strip on the Overview tab (week/month/quarter/year/all)
├── ActivityHeatmap.tsx          # Weekly activity heatmap (GitHub-style)
├── WeekdayComparisonChart.tsx   # Weekday vs weekend comparison (Activity tab)
├── DurationTrendsChart.tsx      # Line chart for duration over time
├── AutoRunStats.tsx             # Auto Run-specific statistics
├── TasksByHourChart.tsx         # Auto Run tasks-by-hour chart
├── LongestAutoRunsTable.tsx     # Longest Auto Runs leaderboard
├── CueStats.tsx                 # Cue automation analytics (Cue tab, gated on Encore flags)
├── Sparkline.tsx                # Reusable mini trend line for metric cards
├── chartUtils.ts                # Shared chart helpers (palettes, tooltip clamping)
├── ChartSkeletons.tsx           # Loading skeleton components
├── ChartErrorBoundary.tsx       # Error boundary with retry
└── EmptyState.tsx               # Empty state when no data
```

### Backend Components

```
src/main/
├── stats-db.ts                  # SQLite database (better-sqlite3) with WAL mode
│   ├── query_events table       # AI queries with duration, tokens, cost
│   ├── auto_run_sessions table  # Auto Run session tracking
│   ├── auto_run_tasks table     # Individual task tracking
│   └── _migrations table        # Schema migration tracking
├── ipc/handlers/stats.ts        # IPC handlers for stats operations
└── utils/statsCache.ts          # Query result caching
```

### Key Patterns

**Real-time Updates:**

```typescript
// Backend broadcasts after each database write
mainWindow?.webContents.send('stats:updated');

// Frontend subscribes with debouncing
useEffect(() => {
	const unsubscribe = window.maestro.stats.onStatsUpdated(() => {
		debouncedRefresh();
	});
	return () => unsubscribe?.();
}, []);
```

**Colorblind-Friendly Palettes:**

```typescript
import { COLORBLIND_AGENT_PALETTE, getColorBlindAgentColor } from '../constants/colorblindPalettes';
// Wong-based palette with high contrast for accessibility
```

**Chart Error Boundaries:**

```typescript
<ChartErrorBoundary chartName="Agent Comparison" onRetry={handleRetry}>
  <AgentComparisonChart data={data} colorBlindMode={colorBlindMode} />
</ChartErrorBoundary>
```

### Related Settings

```typescript
// In useSettings.ts
statsCollectionEnabled: boolean; // Enable/disable stats collection (default: true)
defaultStatsTimeRange: 'day' | 'week' | 'month' | 'year' | 'all'; // Default time filter
colorBlindMode: boolean; // Use accessible color palettes
preventSleepEnabled: boolean; // Prevent system sleep while agents are busy (default: false)
showSessionIdPill: boolean; // Show session UUID pill in main panel header (default: false — opt-in)
showSessionCostPill: boolean; // Show cost pill in main panel header (default: true)
```

---

## Document Graph

The Document Graph (`src/renderer/components/DocumentGraph/`) visualizes markdown file relationships and wiki-link connections using React Flow.

### Architecture

```
src/renderer/components/DocumentGraph/
├── DocumentGraphView.tsx        # Main modal with React Flow canvas
├── DocumentNode.tsx             # Document file node component
├── ExternalLinkNode.tsx         # External URL domain node
├── NodeContextMenu.tsx          # Right-click context menu
├── NodeBreadcrumb.tsx           # Path breadcrumb for selected node
├── GraphLegend.tsx              # Collapsible legend explaining node/edge types
├── graphDataBuilder.ts          # Scans directory, extracts links, builds graph data
└── layoutAlgorithms.ts          # Force-directed and hierarchical layout algorithms

src/renderer/utils/
├── markdownLinkParser.ts        # Parses [[wiki-links]] and [markdown](links)
└── documentStats.ts             # Computes document statistics (word count, etc.)

src/main/ipc/handlers/
└── documentGraph.ts             # Chokidar file watcher for real-time updates
```

### Key Patterns

**Building Graph Data:**

```typescript
import { buildGraphData } from './graphDataBuilder';
const { nodes, edges, stats } = await buildGraphData(
	rootPath,
	showExternalLinks,
	maxNodes,
	offset,
	progressCallback
);
```

**Layout Algorithms:**

```typescript
import {
	applyForceLayout,
	applyHierarchicalLayout,
	animateLayoutTransition,
} from './layoutAlgorithms';
const positionedNodes =
	layoutMode === 'force' ? applyForceLayout(nodes, edges) : applyHierarchicalLayout(nodes, edges);
animateLayoutTransition(currentNodes, positionedNodes, setNodes, savePositions);
```

**Node Animation (additions/removals):**

```typescript
import { diffNodes, animateNodesEntering, animateNodesExiting } from './layoutAlgorithms';
const { added, removed, stable } = diffNodes(previousNodes, newNodes);
animateNodesExiting(removed, () => animateNodesEntering(added));
```

**Real-time File Watching:**

```typescript
// Backend watches for .md file changes
window.maestro.documentGraph.watchFolder(rootPath);
window.maestro.documentGraph.onFilesChanged((changes) => {
	debouncedRebuildGraph();
});
// Cleanup on modal close
window.maestro.documentGraph.unwatchFolder(rootPath);
```

**Keyboard Navigation:**

```typescript
// Arrow keys navigate to connected nodes (spatial detection)
// Enter opens selected node
// Tab cycles through connected nodes
// Escape closes modal
```

### Large File Handling

Files over 1MB are truncated to first 100KB for link extraction to prevent UI blocking:

```typescript
const LARGE_FILE_THRESHOLD = 1 * 1024 * 1024; // 1MB
const LARGE_FILE_PARSE_LIMIT = 100 * 1024; // 100KB
```

### Pagination

Default limit of 50 nodes with "Load more" for large directories:

```typescript
const DEFAULT_MAX_NODES = 50;
const LOAD_MORE_INCREMENT = 25;
```

### Related Settings

```typescript
// In useSettings.ts
documentGraphShowExternalLinks: boolean; // Show external link nodes (default: false)
documentGraphMaxNodes: number; // Initial pagination limit (50-1000, default: 50)
```
