# CLAUDE-FEATURES.md

Feature documentation for Usage Dashboard and Document Graph. For the main guide, see [[CLAUDE.md]].

## Usage Dashboard

The Usage Dashboard (`src/renderer/components/UsageDashboard/`) provides analytics and visualizations for AI agent usage.

### Architecture

```
src/renderer/components/UsageDashboard/
├── UsageDashboardModal.tsx      # Main modal - view tabs: Overview, Agents, Agent Overview, Activity, Auto Run (+ Cue when both Encore flags are on)
├── SummaryCards.tsx             # 12 metric cards (queries, duration, top agent, streak, best day, active days, worktree %, etc.)
├── AgentOverviewCards.tsx       # Per-agent overview cards (Agents tab) + the fuzzy agent filter
├── AgentDetailModal.tsx         # Per-agent stats sub-modal, opened by clicking an agent card
├── TabBreakdown.tsx             # Per-tab stat tiles inside AgentDetailModal (groups query events by tab_id)
├── EntityTile.tsx               # Shared card-grid tile behind BOTH the agent grid and the tab grid
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
showSessionIdPill: boolean; // Show session UUID pill in main panel header (default: false - opt-in)
showSessionCostPill: boolean; // Show cost pill in main panel header (default: true)
```

---

## Document Graph

The Document Graph (`src/renderer/components/DocumentGraph/`) visualizes markdown file relationships and wiki-link connections.

It renders to a **single HTML canvas**, not to React Flow. `MindMap.tsx` owns one `<canvas>` and draws every node, edge, hull, and caption into it by hand. That is why the graph can hold hundreds of documents without the DOM node count becoming the bottleneck, and it is also the constraint behind most of the patterns below: nothing here is a React component that can be styled or queried, so hit testing, layout, and text truncation are all arithmetic the module has to do itself.

**Three files in this directory are dead.** `DocumentNode.tsx`, `ExternalLinkNode.tsx`, and `layoutAlgorithms.ts` are the React Flow implementation this replaced. They still import `reactflow` and are still referenced by tests, but no production code imports them. Do not extend them, and do not read them to learn how the graph works - they describe a rendering model this feature no longer uses.

### Architecture

```
src/renderer/components/DocumentGraph/
├── DocumentGraphView.tsx        # Modal shell: toolbar, search, preview pane, shortcuts, data loading
├── MindMap.tsx                  # The canvas. Rendering, hit testing, pan/zoom, drag, keyboard nav
├── mindMapLayouts.ts            # All six layout algorithms + the geometry they share
├── layoutTypes.ts               # The layout vocabulary (leaf module, no d3 import)
├── graphDataBuilder.ts          # Scans directory, extracts links, builds graph data
├── clusterColors.ts             # Lobes cluster palette, derived from the theme accent
├── scrollMode.ts                # Whether the wheel zooms or pans
├── previewCharLimit.ts          # The P cycle: Off, 50, 100, 200, 350, 500
├── neighborDepth.ts             # The D cycle: 1-5, then All
├── previewPaneSizing.ts         # In-graph document preview width
├── GraphMiniMap.tsx             # Bottom-left overview, click/drag to jump
├── GraphLegend.tsx              # Help panel: node/edge types, shortcuts, scroll mode toggle
├── NodeContextMenu.tsx          # Right-click context menu
├── NodeBreadcrumb.tsx           # Path breadcrumb for selected node
│
├── DocumentNode.tsx             # UNUSED - React Flow leftover
├── ExternalLinkNode.tsx         # UNUSED - React Flow leftover
└── layoutAlgorithms.ts          # UNUSED - React Flow leftover

src/renderer/utils/
├── markdownLinkParser.ts        # Parses [[wiki-links]] and [markdown](links)
└── documentStats.ts             # Document statistics (word count, mtime, description)

src/main/ipc/handlers/
└── documentGraph.ts             # Chokidar file watcher for real-time updates
```

### Key Patterns

**Building Graph Data:**

`buildGraphData` takes ONE options object, not positional arguments.

```typescript
import { buildGraphData } from './graphDataBuilder';
const { nodes, edges, stats } = await buildGraphData({
	rootPath,
	focusFile, // required - the graph is always centered on something
	maxDepth,
	maxNodes,
	onProgress,
	onPartialUpdate,
	sshRemoteId,
});
```

**Focus mode vs scope mode.** `focusFile` alone walks outward from one document, so a file nothing links to can never become a node. Passing `scopeFiles` or `scopeDirectory` instead makes a node for every file in the set, which is the only way an unlinked document is visible at all. Scope mode also skips `startBacklinkScan`, which would drag in the files the user did not select. See the `BuildOptions.scopeFiles` note in [[CLAUDE.md]].

**Laying out and drawing:**

Data and geometry are separate. `graphDataBuilder` produces `GraphNode[]` / `GraphEdge[]`; `convertToMindMapData()` turns those into the canvas's own `MindMapNode[]` / `MindMapLink[]`; `calculateLayout()` positions them.

```typescript
import { calculateLayout, buildAdjacencyMap } from './mindMapLayouts';
import { convertToMindMapData } from './MindMap';

const { nodes, links } = convertToMindMapData(graphNodes, graphEdges, previewCharLimit);
const layout = calculateLayout(
	layoutType, // 'mindmap' | 'radial' | 'hierarchical' | 'force' | 'lobes' | 'timeline'
	nodes,
	links,
	buildAdjacencyMap(links),
	centerFilePath,
	maxDepth,
	canvasWidth,
	canvasHeight,
	showExternalLinks,
	previewCharLimit,
	spacingScale,
	showOrphans
);
// -> { nodes, links, bounds, axisLabels?, clusters? }
```

Every layout runs through `prepareLayoutInput()` (finds the center, runs the BFS, splits out externals and orphans) and reports `bounds`, which is what zoom-to-fit frames. A layout that positions something outside its own bounds draws it half off screen on open.

**Adding a layout** means: add the name to `layoutTypes.ts` (NOT to `mindMapLayouts.ts`, and not to a third copy - see below), write a `LayoutFunction`, and register it in `LAYOUT_ALGORITHMS`. Nothing else needs to change; the toolbar dropdown, the `L` cycle, and the settings validator all read the same list.

**The layout vocabulary lives in ONE place.** `layoutTypes.ts` is a leaf module with no d3 import precisely so that `settingsStore` and the `Session` interface can name a layout without pulling in the layout engine. The union used to be written out three times, and a layout added to the graph was silently rejected on the way to disk by a copy nobody remembered to update.

**Node width is computed, never assumed.** With previews off a node draws as a filename pill about a third the width of a card, and `calculateNodeWidth(label, previewCharLimit)` is what every layout spaces off. Hard-coding `NODE_WIDTH` makes a pill reserve roughly five times its real footprint, which is what made the radial rings thousands of pixels across and spread the force layout to match.

```typescript
import { calculateNodeWidth, calculateNodeHeight } from './mindMapLayouts';
const width = calculateNodeWidth(node.label, previewCharLimit);
const height = calculateNodeHeight(node.description || node.contentPreview, previewCharLimit);
```

**Layout extras.** Two layouts report more than positions, and both are drawn behind the nodes by `MindMap`'s render pass:

- `axisLabels` (Timeline) - the date captions. A time axis with no dates on it is just an arbitrary left-to-right ordering, so the captions are the layout rather than decoration.
- `clusters` (Lobes) - a convex hull, caption, and colour index per community. **Without these Lobes is indistinguishable from Force**: both relax nodes with links pulling and charge pushing, so a lobe that is not drawn as a lobe is just a differently-seeded force graph. Nodes carry `clusterId` / `clusterIndex` so the renderer can tint a border without re-deriving the partition. `clusterColor()` rotates the theme accent by the golden angle, so cluster 0 IS the accent and no lobe can land on a colour the theme does not use.

**Real-time File Watching:**

```typescript
// Backend watches for .md file changes
window.maestro.documentGraph.watchFolder(rootPath);
const unsubscribe = window.maestro.documentGraph.onFilesChanged((changes) => {
	debouncedRebuildGraph();
});
// Cleanup on modal close
unsubscribe();
window.maestro.documentGraph.unwatchFolder(rootPath);
```

**Keyboard handling is split across two elements, and the order matters.** The canvas (`MindMap`) handles anything about the SELECTED NODE and returns; whatever it does not claim bubbles to the container (`DocumentGraphView`), which handles the view-level controls. A container binding on a key the canvas already claims never fires.

| Handler                    | Keys                                                    |
| -------------------------- | ------------------------------------------------------- |
| Canvas (`MindMap`)         | `Arrows` (spatial navigation), `Enter`, `Space`, `O`    |
| Container (`...GraphView`) | `L`, `D`, `P`, `F`, `S`, `+` / `-`, `Cmd/Ctrl+F`, `Esc` |

The container handler also skips every bare key while a modifier is held or focus is in an `INPUT` / `TEXTAREA`, or searching for "documentation" would cycle the layout four times on the way through.

### Large File Handling

Files over 1MB are truncated to the first 100KB for link extraction, to prevent UI blocking:

```typescript
export const LARGE_FILE_THRESHOLD = 1024 * 1024; // 1MB
export const LARGE_FILE_PARSE_LIMIT = 100 * 1024; // 100KB
```

### Pagination

`DocumentGraphView` loads 200 nodes by default with a "Load more" button for larger directories. Note this is NOT the same number as the `documentGraphMaxNodes` setting, whose default is 50: the setting is the user's ceiling, the constant is the component's fallback when no value is passed.

```typescript
const DEFAULT_MAX_NODES = 200;
const LOAD_MORE_INCREMENT = 25;
```

### Related Settings

```typescript
// In settingsStore.ts
documentGraphShowExternalLinks: boolean; // Show external link nodes (default: false)
documentGraphConfirmClose: boolean; // Prompt before Esc discards the view (default: true)
documentGraphMaxNodes: number; // Pagination limit (default: 50)
documentGraphPreviewCharLimit: number; // Preview text length, 0 = pills (default: 100)
documentGraphLayoutType: DocumentGraphLayoutType; // Default layout (default: 'hierarchical')
```

`DocumentGraphLayoutType` is an alias for `MindMapLayoutType` from `layoutTypes.ts`. A per-agent override lives on `Session.documentGraphLayout`.

### User Documentation

[document-graph.md](docs/document-graph.md) covers the same feature for users: what each layout answers, the scroll modes, and the keyboard summary. A change to the layouts or the shortcuts belongs in both files.
