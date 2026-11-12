# CLAUDE-FEATURES.md

Feature documentation for Usage Dashboard, Document Graph, and Delegation Graph. For the main guide, see [[CLAUDE.md]].

## Usage Dashboard

The Usage Dashboard (`src/renderer/components/UsageDashboard/`) provides analytics and visualizations for AI agent usage.

### Architecture

```
src/renderer/components/UsageDashboard/
├── UsageDashboardModal/         # Main modal folder: UsageDashboardModal.tsx, views/ (one per tab), hooks/, components/, constants.ts, sections.ts, types.ts
│                                # Tabs in order: Overview, Agent Overview, Agents, Groups, Tokens, Activity, Auto Run (+ Cue when both Encore flags are on), Shortcuts;
│                                # "Anthropic Usage" / "OpenAI Usage" appended when that provider has quota data (constants.ts, hooks/useUsageDashboardTabs.ts)
├── SummaryCards.tsx             # 14 metric cards (agents, open tabs, queries, queries/session, tokens, cost, time, peak hour, top agent, streak, best day, active days, image annotations) + conditional "Interactive vs Auto"
├── AgentOverviewCards.tsx       # Per-agent overview cards (Agents tab) + the fuzzy agent filter
├── AgentDetailModal.tsx         # Per-agent stats sub-modal, opened by clicking an agent card
├── TabBreakdown.tsx             # Per-tab sortable TABLE inside AgentDetailModal (groups query events by tab_id); not a tile grid
├── GroupOverviewCards.tsx       # Per-group cards (Groups tab); GroupDetailModal.tsx is its sub-modal
├── EntityTile.tsx               # Shared card-grid tile behind the agent grid and the group grid (and MetricCard)
├── MetricCard.tsx               # Metric tile; MetricModeToggle.tsx switches its mode
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
├── TokenStats.tsx               # Tokens tab; with TokenSpeedStats, TokenSpeedCards, TokenSeriesContext, useTokenUsage.ts
├── DelegationScoreCard.tsx      # Delegation analytics; with DelegationSplitBar, DelegationTrendChart
├── KeyboardStats.tsx            # Shortcuts tab; siblings WizardStats, ResilienceStats, PromptCadenceStats, PercentilesCard, ProviderTrendsChart, PeakHoursChart
├── ClaudePlanUsage.tsx          # Provider quota tabs (CodexPlanUsage.tsx); shared pieces in quota/
├── UsageDashboardFooter.tsx     # Footer summary (useFooterSummary.ts)
├── useDashboardResource.ts      # useCachedResource + stats:updated refresh for dashboard panels
├── *Utils.ts                    # Pure helpers beside their chart (activityHeatmapUtils, agentOverviewUtils, autoRunStatsUtils, ...)
├── chartUtils.ts                # Shared chart helpers (palettes, tooltip clamping)
├── ChartSkeletons.tsx           # Loading skeleton components (ChartLoadingOverlay.tsx, DetailPrimitives.tsx beside it)
├── Sparkline.tsx                # Re-export shim over components/widgets/output/Sparkline
├── ChartErrorBoundary.tsx       # Re-export shim over components/widgets/output/ChartErrorBoundary
├── ChartTooltip.tsx             # Re-export shim over components/widgets/output/ChartTooltip
└── EmptyState.tsx               # Empty state when no data
```

### Models tab setup links

`ModelUsage/ModelUsageStats.tsx` supplies setup actions to the empty sections in
`ModelUsageSections.tsx`. Tasks links open System One or System Two, the System One
link opens its own panel, and Token Proxy Savings opens Gateway (from its empty line,
and from a toolbar button once it has data). Use `modelsSettingsLocation()` for labels
and `modelsSettingsSubTab()` with `getModalActions().openSettings()` for navigation;
opening Settings closes the dashboard.

The Run On Agents shortcut opens the active non-terminal agent's Models settings
through `openAgentSettings()`, keeping the dashboard open underneath. Read the live
session by ID when clicked so the form receives current values. Hide the shortcut
when there is no active agent or the active session is a terminal.
`Sparkline`, `ChartErrorBoundary`, and `ChartTooltip` live in the widget library (`src/renderer/components/widgets/output/`); the files here are one-line shims kept for the old import path. Import from `components/widgets` in new code.

### Token Proxy Savings (the Models tab's effectiveness section)

`ProxySavingsSection` in `ModelUsage/ModelUsageSections.tsx` draws the shared token proxy
report for the selected range, summary first: three `StatCardGrid` figures (the estimated
reduction with what it is a share of, request coverage, processing time with its sample), a
`MultiLineChart` of the daily original and sent estimates, the mode and route splits
(`TypeBreakdown`), the algorithm bars (`AgentActivityBars`), the provider's own usage, the
per-agent table and the handling lines. It has one fetch owner, `useModelUsage()`: Refresh is
its `reload`, and "Loaded" is its `loadedAt`, the last successful read. `ModelUsage.since` is
where the range starts and is never shown as a freshness. The section starts no timer and
makes no request of its own. Every figure is said through the shared report functions (see
"Saying the Token Proxy Report" in [STATS-ANALYTICS.md](docs/agent-guides/STATS-ANALYTICS.md)),
and the builders for the trend axis and the splits are `proxyTrendView()`,
`proxyModeSlices()` and `proxyRouteSlices()` in `modelUsageView.ts`. Mode configuration stays
in Settings > Models > Gateway: the section has no control that changes what the proxy does.

`ProxyInspectionDetails.tsx` adds a closed-by-default inspection disclosure. Opening it
mounts the existing `useTokenProxyReport()` owner once; closing it unmounts that owner.
`TokenProxyObservations` is shared with Gateway and displays app-lifetime observations
across agents, independent of the selected date range. An explicit Audit button calls
`context.getFootprint()` with the selected stored agent ID and renders the canonical
plain-text inventory, with configured/delivered/window evidence kept distinct. Changing
agents discards the prior inventory and late replies. Continuity opens the existing
`continuityPreview` modal for that agent's selected AI tab. No transformation is activated;
the inspection remains available when range statistics are empty or fail.

### Backend Components

```
src/main/
├── stats/                       # SQLite database (better-sqlite3) with WAL mode, split across ~25 modules
│   ├── stats-db.ts              # The StatsDB class; schema.ts + migrations.ts own the tables
│   ├── aggregations.ts          # Dashboard aggregate queries
│   ├── query-events-buffer.ts   # Buffered query_events inserts
│   ├── wizard-runs.ts           # wizard_runs reads/writes
│   ├── usage-export.ts          # Export
│   └── tables: query_events, auto_run_sessions, auto_run_tasks, session_lifecycle, image_annotations,
│       shortcut_usage_daily, multi_window_usage_daily, resilience_events, wizard_runs, _meta, _migrations
└── ipc/handlers/stats.ts        # IPC handlers for stats operations
```

`src/main/utils/statsCache.ts` is NOT dashboard caching: it caches Claude session statistics for the session browser.

### Key Patterns

**Real-time Updates:**

```typescript
// Backend broadcasts after each database write
mainWindow?.webContents.send('stats:updated');

// Frontend subscribes with debouncing
useEffect(() => {
	const unsubscribe = window.maestro.stats.onStatsUpdate(() => {
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
<ChartErrorBoundary theme={theme} chartName="Agent Comparison" onRetry={handleRetry}>
  <AgentComparisonChart data={data} colorBlindMode={colorBlindMode} />
</ChartErrorBoundary>
```

### Related Settings

```typescript
// In settingsStore.ts
statsCollectionEnabled: boolean; // Enable/disable stats collection (default: true)
defaultStatsTimeRange: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all'; // Default time filter (default: 'week')
colorBlindMode: boolean; // Use accessible color palettes
preventSleepEnabled: boolean; // Prevent system sleep while agents are busy (default: false)
showSessionIdPill: boolean; // Show session UUID pill in main panel header (default: false - opt-in)
showSessionCostPill: boolean; // Show cost pill in main panel header (default: true)
```

---

## Document Graph

The Document Graph (`src/renderer/components/DocumentGraph/`) visualizes markdown file relationships and wiki-link connections.

It renders to a **single HTML canvas**, not to React Flow. `MindMap.tsx` owns one `<canvas>` and its zoom, pan, and pointer handling; `mindMapCanvas.ts` paints the node cards, pills, icons, and links into it by hand so the painted glyph and the click hit test cannot drift. That is why the graph can hold hundreds of documents without the DOM node count becoming the bottleneck, and it is also the constraint behind most of the patterns below: nothing here is a React component that can be styled or queried, so hit testing, layout, and text truncation are all arithmetic the module has to do itself.

**Two node components in this directory are unused.** `DocumentNode.tsx` and `ExternalLinkNode.tsx` belong to the former React Flow renderer. `layoutAlgorithms.ts` still supplies the Delegation Graph's React Flow editor; it does not drive the Document Graph canvas.

### Architecture

```
src/renderer/components/DocumentGraph/
├── DocumentGraphView.tsx        # Modal shell: toolbar, search, preview pane, shortcuts, data loading
├── MindMap.tsx                  # The canvas. Hit testing, pan/zoom, drag, keyboard nav, render pass
├── mindMapCanvas.ts             # Canvas painting: node cards, pills, icons, links, open-file box
├── viewportResize.ts            # On canvas resize: re-fit an untouched view, keep zoom/pan on a touched one
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
└── layoutAlgorithms.ts          # Shared React Flow layouts used by the delegation editor

src/renderer/utils/
├── markdownLinkParser.ts        # Parses [[wiki-links]] and [markdown](links)
├── documentStats.ts             # Document statistics (word count, mtime, description)
└── graphEdgeGeometry.ts         # Shared directed-edge routing for canvas and React Flow

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

| Handler                    | Keys                                                  |
| -------------------------- | ----------------------------------------------------- |
| Canvas (`MindMap`)         | `Arrows` (spatial navigation), `Enter`, `Space`, `O`  |
| Container (`...GraphView`) | `L`, `D`, `P`, `F`, `S`, `C`, `+` / `-`, `Cmd/Ctrl+F` |

`Esc` is not in the container handler: it is the layer stack's, via `useModalLayer(MODAL_PRIORITIES.DOCUMENT_GRAPH, undefined, handleEscapeRequest)`. The container handler also skips every bare key while a modifier is held or focus is in an `INPUT` / `TEXTAREA`, or searching for "documentation" would cycle the layout four times on the way through.

**Screenshots go through the compositor, not the canvas.** `C` (and the camera button in the footer) opens a chooser that copies the graph to the clipboard or writes it to disk, via `window.maestro.shell.capturePage(rect)`. Serializing `MindMap`'s `<canvas>` would be the obvious route and is the wrong one: the markdown preview pane and the legend are React, not canvas, so a canvas export silently drops most of what the user is looking at. `captureGraphImage()` waits two animation frames after dismissing its own modal so the shot is taken from a frame that no longer has the dialog on top of the graph, and both the key and the button are gated on `capturePage` existing, so the web renderer offers neither.

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

## Delegation Graph

`DelegationGraphView.tsx` reuses `<MindMap>` from the Document Graph in View mode and retains the React Flow relationship editor in Edit mode. `delegationMindMapData()` adapts the live peer-roster model to canvas nodes and directed links. Both canvases use `graphEdgeGeometry()` in `src/renderer/utils/graphEdgeGeometry.ts`; do not add a second arrow router.

`buildDelegationGraph()` accepts all-agent, group, and agent scopes. An agent scope follows incoming and outgoing links transitively across groups to show its connected component. Right-clicking an agent with a resolved peer relationship exposes **View Delegation Graph**. The toolbar can isolate the selected agent's cluster or show all agents again. Cmd/Ctrl+K and the hamburger menu open the global graph; `openDelegationGraph` ships with no shortcut assigned.

The global default is `DEFAULT_GLOBAL_DELEGATION_LAYOUT` (`lobes`); group and agent scopes use `DEFAULT_DELEGATION_LAYOUT` (`hierarchical`). The layout vocabulary reuses the Document Graph's leaf labels and excludes Timeline, since relationships have no document timestamps. Layouts and positions are stored separately under `all`, `group:<groupId>`, and `agent:<sessionId>`.

The toolbar wraps the title, scope, mode, layout, and display controls together, with the modal's close button at the right. Document Graph and Delegation Graph share `GraphLayoutMenu` and `GraphToolbarButton` in `src/renderer/components/ui/`. The layout menu supports keyboard navigation, restores focus to its trigger, and registers Escape through the layer stack. Its trigger shows Manual after a node is dragged. The mode control stays together so neither View nor Edit can be squeezed out. **Hide unconnected** is a toggle button with `aria-pressed`.

Cmd/Ctrl+E toggles View/Edit through the same handler as the mode control, consumes the chord, and ignores held-key repeats. Both modes share Document Graph's `L` layout cycle, `F` fit, `S` scroll-mode switch, and `+/-` spacing controls. Shortcuts bubble through the graph container and leave text editing, composition, and open relationship/confirmation editors alone. Other modifier chords and unmodified shortcuts in selectors are ignored. `L` uses the layout dropdown's existing manual-placement confirmation. The legend exposes clickable key hints. View retains canvas arrow navigation, `O` opens Peers, and Space isolates the selected cluster. The modal focuses the active canvas so shortcuts work on opening and after switching modes.

The React Flow editor lays out weak components separately with graphlib and packs their bounding boxes into rows. Mind Map and Lobes expand the shared canvas arrangement to fit agent cards instead of displacing individual collisions downward. They choose the most connected agent as their default center. Saved positions remain authoritative; apply a layout again to replace an older arrangement.

**Hide unconnected** uses `usePersistedToggle('delegationGraph.hideUnconnected')` and `connectedAgentIds()` to filter displayed nodes in both modes without changing peer rosters. It defaults to off and persists across scopes and reopening. Agents added by hand stay visible in Edit so they can be connected; View hides them until they have a relationship. Keep the full model for scope labels and placement eligibility, even when the filter hides every node.

For the fleet view, `<MindMap clusterAllNodes nodeLabel="agent">` includes disconnected communities in Lobes. Directed links remain visible between every pair of displayed endpoints in every layout. Default Document Graph behavior is unchanged: disconnected documents remain in the orphan band unless the caller requests clustering. A canvas drag supplies all displayed positions to the caller so the existing debounced persistence can save the whole arrangement. Manual placement hides algorithm hulls, and Fit measures the displayed coordinates.

User documentation: [agent-delegation.md](docs/agent-delegation.md#the-delegation-graph).
