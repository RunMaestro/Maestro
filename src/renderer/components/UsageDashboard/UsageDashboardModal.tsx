/**
 * UsageDashboardModal
 *
 * Main modal container for the Usage Dashboard with Recharts visualizations.
 * Displays AI usage patterns across all sessions and agents with time-based filtering.
 *
 * Features:
 * - Time range selector (Day, Week, Month, Year, All Time)
 * - View mode tabs for different visualization focuses
 * - Summary stats cards
 * - Activity heatmap, agent comparison, source distribution charts
 * - Responsive grid layout (2 columns on wide screens, 1 on narrow)
 * - Theme-aware styling
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { StatsTimeRange, StatsAggregation } from '../../../shared/stats-types';
import { X, BarChart3, Calendar, Download, Database } from 'lucide-react';
import { SummaryCards } from './SummaryCards';
import { AgentOverviewCards } from './AgentOverviewCards';
import { AgentDetailModal } from './AgentDetailModal';
import { ActivityHeatmap } from './ActivityHeatmap';
import { AgentComparisonChart } from './AgentComparisonChart';
import { ProviderTrendsChart } from './ProviderTrendsChart';
import { SourceDistributionChart, type CueSourceTotals } from './SourceDistributionChart';
import { LocationDistributionChart } from './LocationDistributionChart';
import { RadialActivityChart } from './RadialActivityChart';
import { YearInPixelsStrip } from './YearInPixelsStrip';
import { DurationTrendsChart } from './DurationTrendsChart';
import { AgentUsageChart } from './AgentUsageChart';
import { AutoRunStats } from './AutoRunStats';
import { SessionStats } from './SessionStats';
import { ClaudePlanUsage } from './ClaudePlanUsage';
import { CodexPlanUsage } from './CodexPlanUsage';
import { WorktreeAnalytics } from './WorktreeAnalytics';
import { AgentEfficiencyChart } from './AgentEfficiencyChart';
import { WeekdayComparisonChart } from './WeekdayComparisonChart';
import { TasksByHourChart } from './TasksByHourChart';
import { LongestAutoRunsTable } from './LongestAutoRunsTable';
import { EmptyState } from './EmptyState';
import { DashboardSkeleton } from './ChartSkeletons';
import { ChartErrorBoundary } from './ChartErrorBoundary';
import { CueStats } from './CueStats';
import { KeyboardStats } from './KeyboardStats';
import { PercentilesCard } from './PercentilesCard';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import type {
	Theme,
	Session,
	AutoRunStats as AutoRunStatsType,
	MaestroUsageStats,
	LeaderboardRegistration,
	UsageDashboardViewMode as ViewMode,
} from '../../types';
import {
	AchievementShareButton,
	type AchievementShareGlobalStats,
} from '../AchievementShareButton';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { useClaudeUsageStore, type ClaudeUsageSnapshot } from '../../stores/claudeUsageStore';
import { useCodexUsageStore, type CodexUsageSnapshot } from '../../stores/codexUsageStore';
import { useGlobalAgentStats } from '../../hooks/stats/useGlobalAgentStats';
import { getRendererPerfMetrics, logger } from '../../utils/logger';
import { PERFORMANCE_THRESHOLDS } from '../../../shared/performance-metrics';

// Section IDs for keyboard navigation
const OVERVIEW_SECTIONS = [
	'year-in-pixels',
	'summary-cards',
	'query-percentiles',
	'agent-comparison',
	'provider-trends',
	'source-distribution',
	'location-distribution',
	'radial-activity',
] as const;
const AGENTS_SECTIONS = ['agent-overview-cards'] as const;
const AGENT_OVERVIEW_SECTIONS = ['session-stats', 'agent-efficiency', 'agent-usage'] as const;
const ACTIVITY_SECTIONS = ['activity-heatmap', 'weekday-comparison', 'duration-trends'] as const;
const AUTORUN_SECTIONS = [
	'autorun-stats',
	'autorun-task-percentiles',
	'tasks-by-hour',
	'longest-autoruns',
] as const;
const ANTHROPIC_USAGE_SECTIONS = ['anthropic-usage'] as const;
const CODEX_USAGE_SECTIONS = ['codex-usage'] as const;

type SectionId =
	| (typeof OVERVIEW_SECTIONS)[number]
	| (typeof AGENTS_SECTIONS)[number]
	| (typeof AGENT_OVERVIEW_SECTIONS)[number]
	| (typeof ACTIVITY_SECTIONS)[number]
	| (typeof AUTORUN_SECTIONS)[number]
	| (typeof ANTHROPIC_USAGE_SECTIONS)[number]
	| (typeof CODEX_USAGE_SECTIONS)[number];

// Performance metrics instance for dashboard
const perfMetrics = getRendererPerfMetrics('UsageDashboard');

// StatsTimeRange and StatsAggregation imported from shared/stats-types above

// View mode options for the dashboard
interface UsageDashboardModalProps {
	isOpen: boolean;
	onClose: () => void;
	theme: Theme;
	/** Enable colorblind-friendly colors for charts */
	colorBlindMode?: boolean;
	/** Default time range from settings (default: 'week') */
	defaultTimeRange?: StatsTimeRange;
	/** Sessions for displaying session statistics in Agents tab */
	sessions?: Session[];
	/** Cumulative AutoRun stats - required for the achievement share button. */
	autoRunStats?: AutoRunStatsType;
	/** Optional global stats - drives the Sessions/Tokens row in the share image. */
	globalStats?: AchievementShareGlobalStats | null;
	/** Maestro peak-usage stats - drives the bottom row of the share image. */
	usageStats?: MaestroUsageStats | null;
	/** Global hands-on time, in ms, sourced from settings. */
	handsOnTimeMs?: number;
	/** Leaderboard registration (display name + social handles) for personalization. */
	leaderboardRegistration?: LeaderboardRegistration | null;
}

/**
 * Format database size in human-readable format
 * @param bytes - Size in bytes
 * @returns Formatted string (e.g., "1.5 MB")
 */
function formatDatabaseSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	} else if (bytes < 1024 * 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	} else {
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
	}
}

// Time range options for the dropdown
const TIME_RANGE_OPTIONS: { value: StatsTimeRange; label: string }[] = [
	{ value: 'day', label: 'Today' },
	{ value: 'week', label: 'This Week' },
	{ value: 'month', label: 'This Month' },
	{ value: 'quarter', label: 'This Quarter' },
	{ value: 'year', label: 'This Year' },
	{ value: 'all', label: 'All Time' },
];

// View mode tabs (base list - Cue is appended dynamically when the Encore flag is on)
const BASE_VIEW_MODE_TABS: { value: ViewMode; label: string }[] = [
	{ value: 'overview', label: 'Overview' },
	{ value: 'agent-overview', label: 'Agent Overview' },
	{ value: 'agents', label: 'Agents' },
	{ value: 'activity', label: 'Activity' },
	{ value: 'autorun', label: 'Auto Run' },
	{ value: 'shortcuts', label: 'Shortcuts' },
];

const EMPTY_SESSIONS: Session[] = [];

function hasValidQuotaWindow(window: { percent: number; resetsAt?: string } | undefined): boolean {
	if (!window) return false;
	if (!Number.isFinite(window.percent)) return false;
	if (window.percent < 0) return false;
	return typeof window.resetsAt === 'string' && window.resetsAt.length > 0;
}

function hasUsefulAnthropicQuotaDetails(snapshot: ClaudeUsageSnapshot): boolean {
	if (snapshot.authState === 'unauthenticated') return false;
	return (
		hasValidQuotaWindow(snapshot.session) ||
		hasValidQuotaWindow(snapshot.weekAllModels) ||
		hasValidQuotaWindow(snapshot.weekSonnetOnly)
	);
}

function hasUsefulCodexQuotaDetails(snapshot: CodexUsageSnapshot): boolean {
	if (snapshot.authState !== 'authenticated') return false;
	return (
		hasValidQuotaWindow(snapshot.session) ||
		hasValidQuotaWindow(snapshot.weekly) ||
		(snapshot.additionalLimits ?? []).some(hasValidQuotaWindow)
	);
}

export function UsageDashboardModal({
	isOpen,
	onClose,
	theme,
	colorBlindMode = false,
	defaultTimeRange = 'week',
	sessions = EMPTY_SESSIONS,
	autoRunStats,
	globalStats: globalStatsProp,
	usageStats,
	handsOnTimeMs,
	leaderboardRegistration,
}: UsageDashboardModalProps) {
	// The Achievement share image (in this modal's header) needs cross-provider
	// session/token totals. About Modal fetches them on mount via the shared
	// hook; mirror that here so callers don't have to thread the prop through.
	// Only fetch while the modal is actually open - the lazy-loaded modal
	// stays mounted across opens once the user opens it the first time.
	const { globalStats: fetchedGlobalStats } = useGlobalAgentStats(isOpen && !globalStatsProp);
	const globalStats = globalStatsProp ?? fetchedGlobalStats;
	// Tab visibility must match the IPC handler's gating: both Encore flags
	// have to be on, otherwise the renderer hits a generic error/retry state
	// instead of the friendly disabled note.
	const usageStatsTabEnabled = useSettingsStore((s) => s.encoreFeatures.usageStats);
	const cueTabEnabled = useSettingsStore(
		(s) => s.encoreFeatures.maestroCue && s.encoreFeatures.usageStats
	);
	const claudeUsageSnapshots = useClaudeUsageStore((s) => s.snapshots);
	const codexUsageSnapshots = useCodexUsageStore((s) => s.snapshots);
	const hasAnthropicUsageDetails =
		usageStatsTabEnabled &&
		Object.values(claudeUsageSnapshots).some(hasUsefulAnthropicQuotaDetails);
	const hasCodexUsageDetails =
		usageStatsTabEnabled && Object.values(codexUsageSnapshots).some(hasUsefulCodexQuotaDetails);
	const VIEW_MODE_TABS = useMemo<{ value: ViewMode; label: string }[]>(() => {
		const tabs: { value: ViewMode; label: string }[] = [];
		for (const tab of BASE_VIEW_MODE_TABS) {
			tabs.push(tab);
			// Cue sits immediately after Auto Run, before Shortcuts.
			if (tab.value === 'autorun' && cueTabEnabled) {
				tabs.push({ value: 'cue', label: 'Cue' });
			}
		}
		if (hasAnthropicUsageDetails) {
			tabs.push({ value: 'anthropic-usage', label: 'Anthropic Usage' });
		}
		if (hasCodexUsageDetails) {
			tabs.push({ value: 'codex-usage', label: 'OpenAI Usage' });
		}
		return tabs;
	}, [cueTabEnabled, hasAnthropicUsageDetails, hasCodexUsageDetails]);

	const [timeRange, setTimeRange] = useState<StatsTimeRange>(defaultTimeRange);
	// Restore the tab the user last left off on. The store is in-memory, so this
	// survives closing and reopening the dashboard but resets to 'overview' on
	// app restart. Persist every switch back to the store via setUsageDashboardViewMode.
	const setUsageDashboardViewMode = useUIStore((s) => s.setUsageDashboardViewMode);
	const [viewMode, setViewMode] = useState<ViewMode>(
		() => useUIStore.getState().usageDashboardViewMode
	);
	const [data, setData] = useState<StatsAggregation | null>(null);
	// Cue run totals for the Overview "Activity Source" donut. Lives in a
	// separate stats system from query_events, so it's fetched alongside the
	// main aggregation only when the Cue tab is enabled. null = no Cue slice.
	const [cueSourceTotals, setCueSourceTotals] = useState<CueSourceTotals | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [isExporting, setIsExporting] = useState(false);
	const [containerWidth, setContainerWidth] = useState(0);
	const [showNewDataIndicator, setShowNewDataIndicator] = useState(false);
	const [databaseSize, setDatabaseSize] = useState<number | null>(null);
	const [focusedSection, setFocusedSection] = useState<SectionId | null>(null);
	const [detailSession, setDetailSession] = useState<Session | null>(null);

	const containerRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const tabsRef = useRef<HTMLDivElement>(null);
	const sectionRefs = useRef<Map<SectionId, HTMLDivElement>>(new Map());
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const viewModeRef = useRef(viewMode);
	viewModeRef.current = viewMode;

	// Reset time range to default when modal opens
	useEffect(() => {
		if (isOpen) {
			setTimeRange(defaultTimeRange);
		}
	}, [isOpen, defaultTimeRange]);

	// Register with layer stack for proper Escape handling.
	useModalLayer(
		MODAL_PRIORITIES.USAGE_DASHBOARD,
		undefined,
		() => {
			onCloseRef.current();
		},
		{
			focusTrap: 'lenient',
			enabled: isOpen,
		}
	);

	// Fetch stats data when range changes
	const fetchStats = useCallback(
		async (isRealTimeUpdate = false) => {
			const fetchStart = perfMetrics.start();

			if (!isRealTimeUpdate) {
				setLoading(true);
			}
			setError(null);

			try {
				// Fetch stats and database size in parallel. Cue totals come from a
				// separate stats system and only when the Cue tab is enabled; a
				// failure there must not break the rest of the dashboard, so it
				// resolves to null rather than rejecting the Promise.all.
				const [stats, dbSize, cueAgg] = await Promise.all([
					window.maestro.stats.getAggregation(timeRange),
					window.maestro.stats.getDatabaseSize(),
					cueTabEnabled
						? window.maestro.cueStats.getAggregation(timeRange).catch((err) => {
								logger.warn('Failed to fetch Cue totals for source chart:', undefined, err);
								return null;
							})
						: Promise.resolve(null),
				]);
				setData(stats);
				setDatabaseSize(dbSize);
				setCueSourceTotals(
					cueAgg
						? {
								occurrences: cueAgg.totals.occurrences,
								totalDurationMs: cueAgg.totals.totalDurationMs,
							}
						: null
				);

				// Log fetch performance
				const fetchDuration = perfMetrics.end(fetchStart, 'fetchStats', {
					timeRange,
					totalQueries: stats?.totalQueries,
					isRealTimeUpdate,
				});

				// Warn if fetch is slow
				if (fetchDuration > PERFORMANCE_THRESHOLDS.DASHBOARD_LOAD) {
					logger.warn(
						`[UsageDashboard] fetchStats took ${fetchDuration.toFixed(0)}ms (threshold: ${PERFORMANCE_THRESHOLDS.DASHBOARD_LOAD}ms)`,
						undefined,
						{ timeRange, totalQueries: stats?.totalQueries }
					);
				}

				// Show "new data" indicator for real-time updates
				if (isRealTimeUpdate) {
					setShowNewDataIndicator(true);
					setTimeout(() => setShowNewDataIndicator(false), 3000);
				}
			} catch (err) {
				logger.error('Failed to fetch usage stats:', undefined, err);
				setError(err instanceof Error ? err.message : 'Failed to load stats');
				perfMetrics.end(fetchStart, 'fetchStats:error', { timeRange, error: String(err) });
			} finally {
				setLoading(false);
			}
		},
		[timeRange, cueTabEnabled]
	);

	// Populate the quota provider tabs when the dashboard opens. We always
	// mirror cached main-process state first (cheap), then - only for a provider
	// that still has no useful cached snapshot - trigger one sampling pass so the
	// tab can appear at all. Without this, the tabs are a closed loop: the tab
	// only renders once a snapshot exists, but the sampler that would create the
	// first snapshot never runs (boot sampling uses a strict recent-session
	// filter and the panels mount with autoRefresh={false}). Sampling is gated
	// to once per open and skipped entirely when data is already present, so the
	// expensive paths (Claude's maestro-p spawn, Codex's quota HTTP request) only
	// fire when there is genuinely nothing to show.
	const quotaSampledForOpenRef = useRef(false);
	useEffect(() => {
		if (!isOpen) {
			quotaSampledForOpenRef.current = false;
			return;
		}
		if (!usageStatsTabEnabled) return;
		if (quotaSampledForOpenRef.current) return;
		quotaSampledForOpenRef.current = true;

		void (async () => {
			// Mirror first so we don't re-sample a provider that already has data.
			await Promise.all([
				useClaudeUsageStore.getState().refresh(),
				useCodexUsageStore.getState().refresh(),
			]);

			const claudeHasData = Object.values(useClaudeUsageStore.getState().snapshots).some(
				hasUsefulAnthropicQuotaDetails
			);
			const codexHasData = Object.values(useCodexUsageStore.getState().snapshots).some(
				hasUsefulCodexQuotaDetails
			);

			const jobs: Promise<unknown>[] = [];
			if (!claudeHasData) {
				jobs.push(
					window.maestro.agents
						.refreshClaudeUsageSnapshots()
						.then(() => useClaudeUsageStore.getState().refresh())
						.catch(() => {
							// Sampler failures surface in main logs; the tab simply
							// stays hidden rather than blocking the dashboard.
						})
				);
			}
			if (!codexHasData) {
				jobs.push(
					window.maestro.agents
						.refreshCodexUsageSnapshots()
						.then(() => useCodexUsageStore.getState().refresh())
						.catch(() => {})
				);
			}
			await Promise.all(jobs);
		})();
	}, [isOpen, usageStatsTabEnabled]);

	// Initial fetch and real-time updates subscription
	useEffect(() => {
		if (!isOpen) return;

		fetchStats();

		// Subscribe to stats updates with debounce
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		const unsubscribe = window.maestro.stats.onStatsUpdate(() => {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				fetchStats(true);
			}, 1000); // 1 second debounce
		});

		return () => {
			unsubscribe();
			if (debounceTimer) clearTimeout(debounceTimer);
		};
	}, [isOpen, fetchStats]);

	// Focus container on open
	useEffect(() => {
		if (isOpen) {
			containerRef.current?.focus();
		}
	}, [isOpen]);

	const switchViewMode = useCallback(
		(mode: ViewMode) => {
			setViewMode(mode);
			// Remember the selection so reopening the dashboard returns here.
			setUsageDashboardViewMode(mode);
			setFocusedSection(null);
			// Anchor the newly selected tab to the top. The scroll container
			// (contentRef) persists across tab switches, so without this the new
			// tab would inherit the previous tab's scroll position.
			if (contentRef.current) {
				contentRef.current.scrollTop = 0;
			}
		},
		[setUsageDashboardViewMode]
	);

	// Handle Cmd+Shift+[ and Cmd+Shift+] for tab navigation
	useEffect(() => {
		if (!isOpen) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			// Check for Cmd+Shift+[ or Cmd+Shift+]
			if (e.metaKey && e.shiftKey && (e.key === '[' || e.key === ']')) {
				e.preventDefault();
				e.stopPropagation();

				const currentIndex = VIEW_MODE_TABS.findIndex((tab) => tab.value === viewModeRef.current);

				if (e.key === '[') {
					// Previous tab
					const prevIndex = currentIndex > 0 ? currentIndex - 1 : VIEW_MODE_TABS.length - 1;
					switchViewMode(VIEW_MODE_TABS[prevIndex].value);
				} else {
					// Next tab
					const nextIndex = currentIndex < VIEW_MODE_TABS.length - 1 ? currentIndex + 1 : 0;
					switchViewMode(VIEW_MODE_TABS[nextIndex].value);
				}
			}
		};

		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [isOpen, switchViewMode, VIEW_MODE_TABS]);

	// Track container width for responsive layout
	useEffect(() => {
		if (!isOpen || !contentRef.current) return;

		const updateWidth = () => {
			if (contentRef.current) {
				setContainerWidth(contentRef.current.offsetWidth);
			}
		};

		// Initial measurement
		updateWidth();

		// Use ResizeObserver to detect width changes
		const resizeObserver = new ResizeObserver(updateWidth);
		resizeObserver.observe(contentRef.current);

		return () => resizeObserver.disconnect();
	}, [isOpen]);

	// Determine responsive breakpoints based on container width
	const layout = useMemo(() => {
		// Breakpoints: narrow < 600px, medium 600-900px, wide > 900px
		const isNarrow = containerWidth > 0 && containerWidth < 600;
		const isMedium = containerWidth >= 600 && containerWidth < 900;
		const isWide = containerWidth >= 900;

		return {
			isNarrow,
			isMedium,
			isWide,
			// Chart grid: 1 col on narrow, 2 cols on medium/wide
			chartGridCols: isNarrow ? 1 : 2,
			// Summary cards: 2 cols on narrow, 3 on medium/wide (2 rows × 3 cols)
			summaryCardsCols: isNarrow ? 2 : 3,
			// AutoRun stats: 2 cols on narrow, 3 on medium, 6 on wide
			autoRunStatsCols: isNarrow ? 2 : isMedium ? 3 : 6,
		};
	}, [containerWidth]);

	// Get sections for current view mode.
	const currentSections = useMemo((): readonly SectionId[] => {
		switch (viewMode) {
			case 'overview':
				return OVERVIEW_SECTIONS;
			case 'agents':
				return AGENTS_SECTIONS;
			case 'agent-overview':
				return AGENT_OVERVIEW_SECTIONS;
			case 'activity':
				return ACTIVITY_SECTIONS;
			case 'autorun':
				return AUTORUN_SECTIONS;
			case 'anthropic-usage':
				return ANTHROPIC_USAGE_SECTIONS;
			case 'codex-usage':
				return CODEX_USAGE_SECTIONS;
			case 'cue':
				return [];
			case 'shortcuts':
				return [];
			default:
				return OVERVIEW_SECTIONS;
		}
	}, [viewMode]);

	// Fall back to 'overview' if a dynamic provider/Cue tab disappears.
	useEffect(() => {
		if (!VIEW_MODE_TABS.some((tab) => tab.value === viewMode)) {
			switchViewMode('overview');
		}
	}, [VIEW_MODE_TABS, viewMode, switchViewMode]);

	// Get section label for accessibility
	const getSectionLabel = useCallback((sectionId: SectionId): string => {
		const labels: Record<SectionId, string> = {
			'year-in-pixels': 'Past Year Activity Strip',
			'summary-cards': 'Summary Cards',
			'query-percentiles': 'Query Duration Percentiles',
			'autorun-task-percentiles': 'Auto Run Task Duration Percentiles',
			'agent-overview-cards': 'Active Agents Overview',
			'session-stats': 'Agent Statistics',
			'anthropic-usage': 'Anthropic Usage',
			'codex-usage': 'OpenAI Usage',
			'agent-efficiency': 'Agent Efficiency Chart',
			'agent-comparison': 'Provider Comparison Chart',
			'provider-trends': 'Provider Trends Over Time',
			'agent-usage': 'Agent Usage Chart',
			'source-distribution': 'Session Type Chart',
			'location-distribution': 'Location Distribution Chart',
			'radial-activity': 'Activity by Hour and Day of Week',
			'activity-heatmap': 'Activity Heatmap',
			'weekday-comparison': 'Weekday vs Weekend Chart',
			'duration-trends': 'Duration Trends Chart',
			'autorun-stats': 'Auto Run Statistics',
			'tasks-by-hour': 'Tasks by Time of Day Chart',
			'longest-autoruns': 'Top 25 Longest Auto Runs',
		};
		return labels[sectionId] || sectionId;
	}, []);

	// Navigate to a section
	const navigateToSection = useCallback((sectionId: SectionId) => {
		setFocusedSection(sectionId);
		const sectionEl = sectionRefs.current.get(sectionId);
		if (sectionEl) {
			sectionEl.focus();
			sectionEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		}
	}, []);

	// Handle keyboard navigation for view mode tabs
	const handleTabKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			const currentIndex = VIEW_MODE_TABS.findIndex((tab) => tab.value === viewMode);

			if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
				event.preventDefault();
				const prevIndex = currentIndex > 0 ? currentIndex - 1 : VIEW_MODE_TABS.length - 1;
				switchViewMode(VIEW_MODE_TABS[prevIndex].value);
			} else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
				event.preventDefault();
				const nextIndex = currentIndex < VIEW_MODE_TABS.length - 1 ? currentIndex + 1 : 0;
				switchViewMode(VIEW_MODE_TABS[nextIndex].value);
			} else if (event.key === 'Tab' && !event.shiftKey) {
				// Tab into content area - focus first section
				if (currentSections.length > 0 && data) {
					event.preventDefault();
					navigateToSection(currentSections[0]);
				}
			}
		},
		[viewMode, switchViewMode, currentSections, data, navigateToSection, VIEW_MODE_TABS]
	);

	// Handle keyboard navigation for chart sections
	const handleSectionKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>, sectionId: SectionId) => {
			const sectionIndex = currentSections.indexOf(sectionId);

			if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
				event.preventDefault();
				if (sectionIndex > 0) {
					// Move to previous section
					navigateToSection(currentSections[sectionIndex - 1]);
				} else {
					// Move focus back to tabs
					setFocusedSection(null);
					tabsRef.current?.focus();
				}
			} else if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
				event.preventDefault();
				if (sectionIndex < currentSections.length - 1) {
					// Move to next section
					navigateToSection(currentSections[sectionIndex + 1]);
				} else {
					// Stay on last section (or could cycle back to first)
					// For now, just stay on the last section
				}
			} else if (event.key === 'Home') {
				event.preventDefault();
				navigateToSection(currentSections[0]);
			} else if (event.key === 'End') {
				event.preventDefault();
				navigateToSection(currentSections[currentSections.length - 1]);
			}
		},
		[currentSections, navigateToSection]
	);

	// Create a ref callback for section elements
	const setSectionRef = useCallback(
		(sectionId: SectionId) => (el: HTMLDivElement | null) => {
			if (el) {
				sectionRefs.current.set(sectionId, el);
			} else {
				sectionRefs.current.delete(sectionId);
			}
		},
		[]
	);

	// Handle export to CSV
	const handleExport = async () => {
		setIsExporting(true);
		try {
			// Show save dialog to let user choose file location
			const defaultFilename = `maestro-usage-${timeRange}-${new Date().toISOString().split('T')[0]}.csv`;
			const filePath = await window.maestro.dialog.saveFile({
				defaultPath: defaultFilename,
				filters: [{ name: 'CSV Files', extensions: ['csv'] }],
				title: 'Export Usage Data',
			});

			// User cancelled the dialog
			if (!filePath) {
				return;
			}

			// Get CSV data and write to selected file
			const csv = await window.maestro.stats.exportCsv(timeRange);
			await window.maestro.fs.writeFile(filePath, csv);
		} catch (err) {
			logger.error('Failed to export CSV:', undefined, err);
		} finally {
			setIsExporting(false);
		}
	};

	if (!isOpen) return null;

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999] animate-in fade-in duration-100"
			onClick={onClose}
		>
			<button
				type="button"
				className="absolute inset-0"
				tabIndex={-1}
				onClick={(e) => {
					e.stopPropagation();
					onClose();
				}}
				aria-label="Close usage dashboard"
			/>
			<div
				ref={containerRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label="Usage Dashboard"
				className="relative z-10 rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none select-none"
				onClick={(e) => e.stopPropagation()}
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
					width: '80vw',
					maxWidth: '2200px',
					height: '85vh',
					maxHeight: '1400px',
				}}
			>
				{/* Header */}
				<div
					className="px-6 py-4 border-b flex items-center justify-between flex-shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-3">
						<BarChart3 className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
							Usage Dashboard
						</h2>
						{/* New Data Indicator - appears briefly when real-time data arrives */}
						{showNewDataIndicator && (
							<div
								className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium"
								style={{
									backgroundColor: `${theme.colors.accent}20`,
									color: theme.colors.accent,
									animation: 'pulse-fade 3s ease-out forwards',
								}}
								data-testid="new-data-indicator"
							>
								<span
									className="w-2 h-2 rounded-full"
									style={{
										backgroundColor: theme.colors.accent,
										animation: 'pulse-dot 1s ease-in-out 3',
									}}
								/>
								Updated
							</div>
						)}
					</div>

					<div className="flex items-center gap-3">
						{/* Time Range Dropdown */}
						<div className="relative flex items-center">
							<Calendar
								className="w-4 h-4 absolute left-2.5 pointer-events-none"
								style={{ color: theme.colors.textDim }}
							/>
							<select
								value={timeRange}
								onChange={(e) => setTimeRange(e.target.value as StatsTimeRange)}
								className="pl-8 pr-6 py-1.5 rounded text-sm border cursor-pointer outline-none appearance-none"
								style={{
									backgroundColor: theme.colors.bgMain,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							>
								{TIME_RANGE_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
							{/* Custom dropdown indicator */}
							<div
								className="absolute right-2 pointer-events-none"
								style={{ color: theme.colors.textDim }}
							>
								<svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor">
									<path
										d="M1 1L5 5L9 1"
										stroke="currentColor"
										strokeWidth="1.5"
										strokeLinecap="round"
										strokeLinejoin="round"
										fill="none"
									/>
								</svg>
							</div>
						</div>

						{/* Export Button */}
						<button
							onClick={handleExport}
							className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm hover:bg-opacity-10 transition-colors"
							style={{
								color: theme.colors.textMain,
								backgroundColor: `${theme.colors.accent}15`,
							}}
							onMouseEnter={(e) =>
								(e.currentTarget.style.backgroundColor = `${theme.colors.accent}25`)
							}
							onMouseLeave={(e) =>
								(e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`)
							}
							disabled={isExporting}
						>
							<Download className={`w-4 h-4 ${isExporting ? 'animate-pulse' : ''}`} />
							Export CSV
						</button>

						{/* Share Achievements - sits next to Export CSV. Only renders when
						    we have AutoRun stats (the achievement system requires them);
						    if the parent didn't thread them in, the button is hidden so
						    we don't ship a visibly-broken affordance. */}
						{autoRunStats && (
							<AchievementShareButton
								theme={theme}
								autoRunStats={autoRunStats}
								globalStats={globalStats}
								usageStats={usageStats}
								handsOnTimeMs={handsOnTimeMs}
								leaderboardRegistration={leaderboardRegistration}
								variant="header"
								title="Share achievements"
							/>
						)}

						{/* Close Button */}
						<button
							onClick={onClose}
							className="p-1.5 rounded hover:bg-opacity-10 transition-colors"
							style={{ color: theme.colors.textDim }}
							onMouseEnter={(e) =>
								(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
							}
							onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
							title="Close (Esc)"
						>
							<X className="w-4 h-4" />
						</button>
					</div>
				</div>

				{/* View Mode Tabs */}
				<div
					ref={tabsRef}
					className="px-6 py-2 border-b flex items-center gap-1 flex-shrink-0 outline-none"
					style={{ borderColor: theme.colors.border }}
					role="tablist"
					aria-label="Dashboard view modes"
					tabIndex={0}
					onKeyDown={handleTabKeyDown}
					data-testid="view-mode-tabs"
				>
					{VIEW_MODE_TABS.map((tab) => (
						<button
							key={tab.value}
							onClick={() => switchViewMode(tab.value)}
							className="px-4 py-2 rounded-lg text-sm font-medium transition-colors outline-none"
							style={{
								backgroundColor:
									viewMode === tab.value ? `${theme.colors.accent}20` : 'transparent',
								color: viewMode === tab.value ? theme.colors.accent : theme.colors.textDim,
							}}
							onMouseEnter={(e) => {
								if (viewMode !== tab.value) {
									e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
								}
							}}
							onMouseLeave={(e) => {
								if (viewMode !== tab.value) {
									e.currentTarget.style.backgroundColor = 'transparent';
								}
							}}
							role="tab"
							aria-selected={viewMode === tab.value}
							aria-controls={`tabpanel-${tab.value}`}
							id={`tab-${tab.value}`}
							tabIndex={-1}
						>
							{tab.label}
						</button>
					))}
				</div>

				{/* Main Content */}
				<div
					ref={contentRef}
					className="flex-1 overflow-y-auto scrollbar-thin p-6"
					style={{ backgroundColor: theme.colors.bgMain }}
				>
					{loading && !data ? (
						<DashboardSkeleton
							theme={theme}
							viewMode={
								viewMode === 'cue' ||
								viewMode === 'agent-overview' ||
								viewMode === 'shortcuts' ||
								viewMode === 'anthropic-usage' ||
								viewMode === 'codex-usage'
									? 'overview'
									: viewMode
							}
							chartGridCols={layout.chartGridCols}
							summaryCardsCols={layout.summaryCardsCols}
							autoRunStatsCols={layout.autoRunStatsCols}
						/>
					) : error ? (
						<div
							className="h-full flex flex-col items-center justify-center gap-4"
							style={{ color: theme.colors.textDim }}
						>
							<p>Failed to load usage data</p>
							<button
								onClick={() => fetchStats()}
								className="px-4 py-2 rounded text-sm"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.bgMain,
								}}
							>
								Retry
							</button>
						</div>
					) : viewMode === 'shortcuts' ? (
						// The Shortcuts tab depends on its own data sources (settings store
						// + shortcut_usage_daily) and renders fine without any AI queries,
						// so it bypasses the AI-query empty-state gate.
						<div
							key={viewMode}
							className="space-y-6 dashboard-content-enter"
							data-testid="usage-dashboard-content"
							role="tabpanel"
							id={`tabpanel-${viewMode}`}
							aria-labelledby={`tab-${viewMode}`}
						>
							<KeyboardStats timeRange={timeRange} theme={theme} />
						</div>
					) : viewMode === 'anthropic-usage' ? (
						// Quota snapshots come from provider-specific samplers, not stats.db.
						// Keep this tab visible even when the analytics database has no AI-query rows.
						<div
							key={viewMode}
							className="space-y-6 dashboard-content-enter"
							data-testid="usage-dashboard-content"
							role="tabpanel"
							id={`tabpanel-${viewMode}`}
							aria-labelledby={`tab-${viewMode}`}
						>
							<div
								ref={setSectionRef('anthropic-usage')}
								tabIndex={0}
								role="region"
								aria-label={getSectionLabel('anthropic-usage')}
								onKeyDown={(e) => handleSectionKeyDown(e, 'anthropic-usage')}
								className="outline-none rounded-lg transition-shadow dashboard-section-enter"
								style={{
									boxShadow:
										focusedSection === 'anthropic-usage'
											? `0 0 0 2px ${theme.colors.accent}`
											: 'none',
								}}
								data-testid="section-anthropic-usage"
							>
								<ChartErrorBoundary theme={theme} chartName="Anthropic Usage">
									<ClaudePlanUsage theme={theme} showAllAccounts autoRefresh={false} />
								</ChartErrorBoundary>
							</div>
						</div>
					) : viewMode === 'codex-usage' ? (
						// Quota snapshots come from provider-specific samplers, not stats.db.
						// Keep this tab visible even when the analytics database has no AI-query rows.
						<div
							key={viewMode}
							className="space-y-6 dashboard-content-enter"
							data-testid="usage-dashboard-content"
							role="tabpanel"
							id={`tabpanel-${viewMode}`}
							aria-labelledby={`tab-${viewMode}`}
						>
							<div
								ref={setSectionRef('codex-usage')}
								tabIndex={0}
								role="region"
								aria-label={getSectionLabel('codex-usage')}
								onKeyDown={(e) => handleSectionKeyDown(e, 'codex-usage')}
								className="outline-none rounded-lg transition-shadow dashboard-section-enter"
								style={{
									boxShadow:
										focusedSection === 'codex-usage' ? `0 0 0 2px ${theme.colors.accent}` : 'none',
								}}
								data-testid="section-codex-usage"
							>
								<ChartErrorBoundary theme={theme} chartName="OpenAI Usage">
									<CodexPlanUsage theme={theme} showAllAccounts autoRefresh={false} />
								</ChartErrorBoundary>
							</div>
						</div>
					) : !data ||
					  (data.totalQueries === 0 && data.bySource.user === 0 && data.bySource.auto === 0) ? (
						/* Empty State Component */
						<EmptyState theme={theme} />
					) : (
						<div
							key={viewMode} // Re-mount content when view mode changes to trigger animations
							className="space-y-6 dashboard-content-enter"
							data-testid="usage-dashboard-content"
							role="tabpanel"
							id={`tabpanel-${viewMode}`}
							aria-labelledby={`tab-${viewMode}`}
						>
							{/* View-specific content based on viewMode */}
							{viewMode === 'overview' && (
								<>
									{/* Year-in-pixels hero strip - single-row signature graphic
									    showing the past 365 days at a glance. Self-hides when the
									    user has no activity in the lookback window. */}
									<div
										ref={setSectionRef('year-in-pixels')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('year-in-pixels')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'year-in-pixels')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											boxShadow:
												focusedSection === 'year-in-pixels'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '0ms',
										}}
										data-testid="section-year-in-pixels"
									>
										<ChartErrorBoundary theme={theme} chartName="Year In Pixels">
											<YearInPixelsStrip
												data={data}
												theme={theme}
												colorBlindMode={colorBlindMode}
												timeRange={timeRange}
											/>
										</ChartErrorBoundary>
									</div>

									{/* Summary Stats Cards - Horizontal row at top, responsive */}
									<div
										ref={setSectionRef('summary-cards')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('summary-cards')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'summary-cards')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											boxShadow:
												focusedSection === 'summary-cards'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '0ms',
										}}
										data-testid="section-summary-cards"
									>
										<ChartErrorBoundary theme={theme} chartName="Summary Cards">
											<SummaryCards
												data={data}
												theme={theme}
												columns={layout.summaryCardsCols}
												sessions={sessions}
											/>
										</ChartErrorBoundary>
									</div>

									{/* Query Duration Percentiles - long-tail view an average hides */}
									<div
										ref={setSectionRef('query-percentiles')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('query-percentiles')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'query-percentiles')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											boxShadow:
												focusedSection === 'query-percentiles'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '50ms',
										}}
										data-testid="section-query-percentiles"
									>
										<ChartErrorBoundary theme={theme} chartName="Query Duration Percentiles">
											<PercentilesCard
												theme={theme}
												title="Query Duration Percentiles"
												unitLabel="queries"
												distribution={data.queryDurationPercentiles}
												breakdown={Object.entries(data.queryDurationPercentilesByAgent ?? {}).map(
													([agentType, distribution]) => ({
														label: getAgentDisplayName(agentType),
														distribution,
													})
												)}
											/>
										</ChartErrorBoundary>
									</div>

									{/* Provider Comparison Chart - Full width bar chart */}
									<div
										ref={setSectionRef('agent-comparison')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('agent-comparison')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'agent-comparison')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											minHeight: '180px',
											boxShadow:
												focusedSection === 'agent-comparison'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '100ms',
										}}
										data-testid="section-agent-comparison"
									>
										<ChartErrorBoundary theme={theme} chartName="Provider Comparison">
											<AgentComparisonChart
												data={data}
												theme={theme}
												colorBlindMode={colorBlindMode}
												sessions={sessions}
											/>
										</ChartErrorBoundary>
									</div>

									{/* Provider Trends Over Time - stacked bars per day so drift
									    between providers (e.g. Claude Code → Codex) is visible. */}
									<div
										ref={setSectionRef('provider-trends')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('provider-trends')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'provider-trends')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											minHeight: '260px',
											boxShadow:
												focusedSection === 'provider-trends'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '125ms',
										}}
										data-testid="section-provider-trends"
									>
										<ChartErrorBoundary theme={theme} chartName="Provider Trends">
											<ProviderTrendsChart
												data={data}
												timeRange={timeRange}
												theme={theme}
												colorBlindMode={colorBlindMode}
												sessions={sessions}
											/>
										</ChartErrorBoundary>
									</div>

									{/* Distribution Charts Grid - 2 columns for donut charts */}
									<div
										className="grid gap-6 dashboard-section-enter"
										style={{
											gridTemplateColumns: `repeat(${layout.chartGridCols}, minmax(0, 1fr))`,
											animationDelay: '150ms',
										}}
									>
										{/* Source Distribution Chart */}
										<div
											ref={setSectionRef('source-distribution')}
											tabIndex={0}
											role="region"
											aria-label={getSectionLabel('source-distribution')}
											onKeyDown={(e) => handleSectionKeyDown(e, 'source-distribution')}
											className="outline-none rounded-lg transition-shadow"
											style={{
												minHeight: '240px',
												boxShadow:
													focusedSection === 'source-distribution'
														? `0 0 0 2px ${theme.colors.accent}`
														: 'none',
											}}
											data-testid="section-source-distribution"
										>
											<ChartErrorBoundary theme={theme} chartName="Source Distribution">
												<SourceDistributionChart
													data={data}
													theme={theme}
													colorBlindMode={colorBlindMode}
													cueTotals={cueSourceTotals}
												/>
											</ChartErrorBoundary>
										</div>

										{/* Location Distribution Chart */}
										<div
											ref={setSectionRef('location-distribution')}
											tabIndex={0}
											role="region"
											aria-label={getSectionLabel('location-distribution')}
											onKeyDown={(e) => handleSectionKeyDown(e, 'location-distribution')}
											className="outline-none rounded-lg transition-shadow"
											style={{
												minHeight: '240px',
												boxShadow:
													focusedSection === 'location-distribution'
														? `0 0 0 2px ${theme.colors.accent}`
														: 'none',
											}}
											data-testid="section-location-distribution"
										>
											<ChartErrorBoundary theme={theme} chartName="Location Distribution">
												<LocationDistributionChart
													data={data}
													theme={theme}
													colorBlindMode={colorBlindMode}
												/>
											</ChartErrorBoundary>
										</div>
									</div>

									{/* Radial activity pair - replaces the flat Peak Hours bar chart.
									    Two side-by-side polar charts: one for hour-of-day, one for
									    day-of-week. Stacks to a single column on narrow viewports. */}
									<div
										ref={setSectionRef('radial-activity')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('radial-activity')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'radial-activity')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											minHeight: '320px',
											boxShadow:
												focusedSection === 'radial-activity'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '175ms',
										}}
										data-testid="section-radial-activity"
									>
										<div
											className="grid gap-6"
											style={{
												gridTemplateColumns: `repeat(${layout.chartGridCols}, minmax(0, 1fr))`,
											}}
										>
											<ChartErrorBoundary theme={theme} chartName="Activity by Hour">
												<RadialActivityChart
													mode="hours"
													data={data}
													theme={theme}
													colorBlindMode={colorBlindMode}
												/>
											</ChartErrorBoundary>
											<ChartErrorBoundary theme={theme} chartName="Activity by Day of Week">
												<RadialActivityChart
													mode="weekday"
													data={data}
													theme={theme}
													colorBlindMode={colorBlindMode}
												/>
											</ChartErrorBoundary>
										</div>
									</div>
								</>
							)}

							{viewMode === 'agents' && (
								<div
									ref={setSectionRef('agent-overview-cards')}
									tabIndex={0}
									role="region"
									aria-label={getSectionLabel('agent-overview-cards')}
									onKeyDown={(e) => handleSectionKeyDown(e, 'agent-overview-cards')}
									className="outline-none rounded-lg transition-shadow dashboard-section-enter"
									style={{
										boxShadow:
											focusedSection === 'agent-overview-cards'
												? `0 0 0 2px ${theme.colors.accent}`
												: 'none',
										animationDelay: '0ms',
									}}
									data-testid="section-agent-overview-cards"
								>
									{sessions.some((s) => s.toolType !== 'terminal') ? (
										<ChartErrorBoundary theme={theme} chartName="Agent Overview">
											<AgentOverviewCards
												sessions={sessions}
												data={data}
												theme={theme}
												onShowAgentDetails={setDetailSession}
											/>
										</ChartErrorBoundary>
									) : (
										<div
											className="p-6 rounded-lg text-center text-sm"
											style={{
												backgroundColor: theme.colors.bgMain,
												color: theme.colors.textDim,
											}}
										>
											No active agents
										</div>
									)}
								</div>
							)}

							{viewMode === 'agent-overview' && (
								<>
									{/* Agent Statistics */}
									<div
										ref={setSectionRef('session-stats')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('session-stats')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'session-stats')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											boxShadow:
												focusedSection === 'session-stats'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '0ms',
										}}
										data-testid="section-session-stats"
									>
										<ChartErrorBoundary theme={theme} chartName="Agent Statistics">
											<SessionStats
												sessions={sessions}
												theme={theme}
												colorBlindMode={colorBlindMode}
											/>
										</ChartErrorBoundary>
									</div>

									{/* Worktree Analytics - only shown when at least one worktree
									    session exists. WorktreeAnalytics provides its own role="region"
									    + aria-label, so it sits outside the keyboard-navigable sections
									    (same pattern as AgentOverviewCards in the Overview tab). */}
									{sessions.some((s) => !!s.parentSessionId) && (
										<ChartErrorBoundary theme={theme} chartName="Worktree Analytics">
											<WorktreeAnalytics sessions={sessions} data={data} theme={theme} />
										</ChartErrorBoundary>
									)}

									{/* Agent Efficiency */}
									<div
										ref={setSectionRef('agent-efficiency')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('agent-efficiency')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'agent-efficiency')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											minHeight: '180px',
											boxShadow:
												focusedSection === 'agent-efficiency'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '50ms',
										}}
										data-testid="section-agent-efficiency"
									>
										<ChartErrorBoundary theme={theme} chartName="Agent Efficiency">
											<AgentEfficiencyChart
												data={data}
												theme={theme}
												colorBlindMode={colorBlindMode}
												sessions={sessions}
											/>
										</ChartErrorBoundary>
									</div>

									{/* Agent Usage Over Time */}
									<div
										ref={setSectionRef('agent-usage')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('agent-usage')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'agent-usage')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											minHeight: '280px',
											boxShadow:
												focusedSection === 'agent-usage'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '200ms',
										}}
										data-testid="section-agent-usage"
									>
										<ChartErrorBoundary theme={theme} chartName="Agent Usage">
											<AgentUsageChart
												data={data}
												timeRange={timeRange}
												theme={theme}
												colorBlindMode={colorBlindMode}
												sessions={sessions}
											/>
										</ChartErrorBoundary>
									</div>
								</>
							)}

							{viewMode === 'activity' && (
								<>
									{/* Activity-focused view */}
									<div
										ref={setSectionRef('activity-heatmap')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('activity-heatmap')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'activity-heatmap')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											minHeight: '300px',
											boxShadow:
												focusedSection === 'activity-heatmap'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '0ms',
										}}
										data-testid="section-activity-heatmap"
									>
										<ChartErrorBoundary theme={theme} chartName="Activity Heatmap">
											<ActivityHeatmap
												data={data}
												timeRange={timeRange}
												theme={theme}
												colorBlindMode={colorBlindMode}
											/>
										</ChartErrorBoundary>
									</div>

									{/* Weekday vs Weekend Comparison */}
									<div
										ref={setSectionRef('weekday-comparison')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('weekday-comparison')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'weekday-comparison')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											boxShadow:
												focusedSection === 'weekday-comparison'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '50ms',
										}}
										data-testid="section-weekday-comparison"
									>
										<ChartErrorBoundary theme={theme} chartName="Weekday Comparison">
											<WeekdayComparisonChart
												data={data}
												theme={theme}
												colorBlindMode={colorBlindMode}
											/>
										</ChartErrorBoundary>
									</div>

									<div
										ref={setSectionRef('duration-trends')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('duration-trends')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'duration-trends')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											minHeight: '280px',
											boxShadow:
												focusedSection === 'duration-trends'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '100ms',
										}}
										data-testid="section-duration-trends"
									>
										<ChartErrorBoundary theme={theme} chartName="Duration Trends">
											<DurationTrendsChart
												data={data}
												timeRange={timeRange}
												theme={theme}
												colorBlindMode={colorBlindMode}
											/>
										</ChartErrorBoundary>
									</div>
								</>
							)}

							{viewMode === 'autorun' && (
								<>
									{/* Auto Run-focused view */}
									<div
										ref={setSectionRef('autorun-stats')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('autorun-stats')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'autorun-stats')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											boxShadow:
												focusedSection === 'autorun-stats'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '0ms',
										}}
										data-testid="section-autorun-stats"
									>
										<ChartErrorBoundary theme={theme} chartName="Auto Run Stats">
											<AutoRunStats
												timeRange={timeRange}
												theme={theme}
												columns={layout.autoRunStatsCols}
											/>
										</ChartErrorBoundary>
									</div>

									{/* Auto Run Task Duration Percentiles - per-task long-tail */}
									<div
										ref={setSectionRef('autorun-task-percentiles')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('autorun-task-percentiles')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'autorun-task-percentiles')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											boxShadow:
												focusedSection === 'autorun-task-percentiles'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '50ms',
										}}
										data-testid="section-autorun-task-percentiles"
									>
										<ChartErrorBoundary
											theme={theme}
											chartName="Auto Run Task Duration Percentiles"
										>
											<PercentilesCard
												theme={theme}
												title="Task Duration Percentiles"
												unitLabel="tasks"
												distribution={data.autoRunTaskDurationPercentiles}
											/>
										</ChartErrorBoundary>
									</div>

									{/* Tasks by Time of Day */}
									<div
										ref={setSectionRef('tasks-by-hour')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('tasks-by-hour')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'tasks-by-hour')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											boxShadow:
												focusedSection === 'tasks-by-hour'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '100ms',
										}}
										data-testid="section-tasks-by-hour"
									>
										<ChartErrorBoundary theme={theme} chartName="Tasks by Hour">
											<TasksByHourChart timeRange={timeRange} theme={theme} />
										</ChartErrorBoundary>
									</div>

									{/* Top 25 Longest Auto Runs */}
									<div
										ref={setSectionRef('longest-autoruns')}
										tabIndex={0}
										role="region"
										aria-label={getSectionLabel('longest-autoruns')}
										onKeyDown={(e) => handleSectionKeyDown(e, 'longest-autoruns')}
										className="outline-none rounded-lg transition-shadow dashboard-section-enter"
										style={{
											boxShadow:
												focusedSection === 'longest-autoruns'
													? `0 0 0 2px ${theme.colors.accent}`
													: 'none',
											animationDelay: '200ms',
										}}
										data-testid="section-longest-autoruns"
									>
										<ChartErrorBoundary theme={theme} chartName="Longest Auto Runs">
											<LongestAutoRunsTable timeRange={timeRange} theme={theme} />
										</ChartErrorBoundary>
									</div>
								</>
							)}

							{viewMode === 'cue' && (
								<CueStats timeRange={timeRange} theme={theme} colorBlindMode={colorBlindMode} />
							)}
						</div>
					)}
				</div>

				{/* Footer */}
				<div
					className="px-6 py-3 border-t flex items-center justify-between text-xs flex-shrink-0"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textDim,
					}}
				>
					<div className="flex items-center gap-4">
						<span>
							{data && data.totalQueries > 0
								? `Showing ${TIME_RANGE_OPTIONS.find((o) => o.value === timeRange)?.label.toLowerCase()} data`
								: 'No data for selected time range'}
						</span>
						{/* Database size indicator */}
						{databaseSize !== null && (
							<span
								className="flex items-center gap-1"
								style={{ opacity: 0.7 }}
								title="Stats database size"
								data-testid="database-size-indicator"
							>
								<Database className="w-3 h-3" />
								{formatDatabaseSize(databaseSize)}
							</span>
						)}
					</div>
					<span style={{ opacity: 0.7 }}>Press Esc to close</span>
				</div>
			</div>

			{detailSession && data && (
				<AgentDetailModal
					session={detailSession}
					data={data}
					theme={theme}
					allSessions={sessions}
					onClose={() => setDetailSession(null)}
				/>
			)}
		</div>
	);
}
