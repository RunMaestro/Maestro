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

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { StatsTimeRange } from '../../../../shared/stats-types';
import { GroupDetailModal } from '../GroupDetailModal';
import { AgentDetailModal } from '../AgentDetailModal';
import { EmptyState } from '../EmptyState';
import { DashboardSkeleton } from '../ChartSkeletons';
import { CueStats } from '../CueStats';
import { TokenSeriesProvider } from '../TokenSeriesContext';
import { buildModalOwnedFooterSummary } from '../footerSummary';
import type { GroupStatRollup } from '../../../../shared/statsGroupRollup';
import type { Session } from '../../../types';
import { useModalLayer } from '../../../hooks/ui/useModalLayer';
import { useResizableModal } from '../../../hooks/ui/useResizableModal';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import { useSessionStore } from '../../../stores/sessionStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useClaudeUsageStore } from '../../../stores/claudeUsageStore';
import { useCodexUsageStore } from '../../../stores/codexUsageStore';
import { useGlobalAgentStats } from '../../../hooks/stats/useGlobalAgentStats';
import type { UsageDashboardModalProps } from './types';
import { getSectionsForViewMode, type SectionId } from './sections';
import { TIME_RANGE_OPTIONS } from './constants';
import { formatDatabaseSize } from './formatters';
import {
	hasUsefulAnthropicQuotaDetails,
	hasUsefulCodexQuotaDetails,
} from '../../../../shared/usageQuota';
import {
	useQuotaTabDiscovery,
	useUsageDashboardData,
	useUsageDashboardExport,
	useUsageDashboardKeyboard,
	useUsageDashboardLayout,
	useUsageDashboardTabs,
} from './hooks';
import { UsageDashboardHeader, UsageDashboardTabs } from './components';
import { UsageDashboardFooter } from '../UsageDashboardFooter';
import {
	ActivityView,
	AgentOverviewView,
	AgentsView,
	GroupsView,
	AutoRunView,
	DashboardTabPanel,
	OverviewView,
	ProviderQuotaUsageView,
	ShortcutsView,
	TokensView,
} from './views';
import { ResizeHandles } from '../../ui/ResizeHandles';

const EMPTY_SESSIONS: Session[] = [];

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
	// Only fetch while the modal is actually open. The lazy-loaded modal
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
	useQuotaTabDiscovery(isOpen, usageStatsTabEnabled);

	const [timeRange, setTimeRange] = useState<StatsTimeRange>(defaultTimeRange);
	const {
		data,
		cueSourceTotals,
		delegationTotals,
		lifetimeDelegation,
		delegationByDay,
		loading,
		error,
		showNewDataIndicator,
		databaseSize,
		fetchStats,
	} = useUsageDashboardData({
		isOpen,
		timeRange,
		cueTabEnabled,
	});
	const [focusedSection, setFocusedSection] = useState<SectionId | null>(null);
	const [detailSession, setDetailSession] = useState<Session | null>(null);
	// Groups come straight from the store rather than a prop: the dashboard is
	// the only consumer, and threading them through AppInfoModals would add a
	// prop to a component that has no other reason to know about groups.
	const groups = useSessionStore((s) => s.groups);
	// The group whose detail modal is open. Holds the whole rollup rather than an
	// id: the modal renders the same totals the clicked tile showed, and
	// re-deriving them would let the two disagree if the aggregation refreshed
	// underneath (the dashboard polls stats:updated) while the modal was open.
	const [detailGroup, setDetailGroup] = useState<GroupStatRollup | null>(null);

	const containerRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const tabsRef = useRef<HTMLDivElement>(null);
	const sectionRefs = useRef<Map<SectionId, HTMLDivElement>>(new Map());
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const handleViewModeChanged = useCallback(() => setFocusedSection(null), []);
	const { viewMode, viewModeRef, viewModeTabs, switchViewMode } = useUsageDashboardTabs({
		cueTabEnabled,
		hasAnthropicUsageDetails,
		hasCodexUsageDetails,
		contentRef,
		onViewModeChanged: handleViewModeChanged,
	});

	// Clicking a group tile opens its detail modal - the per-agent breakdown of
	// the totals on the tile. It does NOT switch tabs: the Agents tab answers a
	// different question ("show me every agent"), and its own group dropdown
	// covers narrowing that grid.
	const handleSelectGroup = useCallback((rollup: GroupStatRollup) => setDetailGroup(rollup), []);

	// An agent row inside the group modal opens the per-agent modal ON TOP,
	// rather than replacing it - the group stays behind so Escape walks back to
	// the breakdown the user came from instead of dumping them on the grid.
	const handleSelectGroupMember = useCallback((session: Session) => setDetailSession(session), []);

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

	// Focus container on open
	useEffect(() => {
		if (isOpen) {
			containerRef.current?.focus();
		}
	}, [isOpen]);

	const layout = useUsageDashboardLayout(isOpen, contentRef);
	const { isExporting, handleExport } = useUsageDashboardExport(timeRange);

	const hasWorktreeAnalytics = useMemo(
		() => sessions.some((session) => !!session.parentSessionId),
		[sessions]
	);
	// Footer line for the tabs this modal can describe from `data` alone. Tabs
	// backed by a panel that fetches for itself (Cue, Auto Run, Shortcuts, the
	// quota panels) and the two card grids that own their own filter state
	// publish their own line instead, which wins over this one.
	// The footer is presentational: it takes finished strings rather than the
	// range enum and a byte count, so it stays the one component both the split
	// modal and its own test can drive.
	const footerRangeLabel =
		data && data.totalQueries > 0
			? `Showing ${TIME_RANGE_OPTIONS.find((option) => option.value === timeRange)?.label.toLowerCase()} data`
			: 'No data for selected time range';
	const footerDatabaseSizeLabel = databaseSize !== null ? formatDatabaseSize(databaseSize) : null;
	const footerSummary = useMemo(
		() => buildModalOwnedFooterSummary(viewMode, { data, sessions }),
		[viewMode, data, sessions]
	);
	const currentSections = useMemo(
		() => getSectionsForViewMode(viewMode, { hasWorktreeAnalytics }),
		[viewMode, hasWorktreeAnalytics]
	);
	const { handleTabKeyDown, handleSectionKeyDown, setSectionRef } = useUsageDashboardKeyboard({
		isOpen,
		viewMode,
		viewModeRef,
		viewModeTabs,
		switchViewMode,
		currentSections,
		data,
		tabsRef,
		sectionRefs,
		setFocusedSection,
	});
	const resizableModal = useResizableModal({
		resizeKey: 'usage-dashboard',
		defaultSize: { width: 1200, height: 760 },
		minSize: { width: 760, height: 500 },
		// Preserves the previous fixed 80vw/2200px x 85vh/1400px chart-layout
		// ceiling so charts don't stretch past their designed layout on large displays.
		maxSize: { width: 2200, height: 1400 },
		enabled: isOpen,
		externalRef: containerRef,
	});

	const renderTabContent = () => {
		if (loading && !data) {
			return (
				<DashboardSkeleton
					theme={theme}
					viewMode={
						// Groups is a card grid like Agents, so it borrows that
						// skeleton; the rest have no skeleton of their own.
						viewMode === 'groups'
							? 'agents'
							: viewMode === 'cue' ||
								  viewMode === 'agent-overview' ||
								  viewMode === 'shortcuts' ||
								  viewMode === 'tokens' ||
								  viewMode === 'anthropic-usage' ||
								  viewMode === 'codex-usage'
								? 'overview'
								: viewMode
					}
					chartGridCols={layout.chartGridCols}
					summaryCardsCols={layout.summaryCardsCols}
					autoRunStatsCols={layout.autoRunStatsCols}
				/>
			);
		}

		if (error) {
			return (
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
			);
		}

		if (viewMode === 'shortcuts') {
			return <ShortcutsView key={viewMode} timeRange={timeRange} theme={theme} />;
		}

		// Token usage is read from each agent's on-disk transcripts, not the stats
		// DB, so this tab has data even when no query events were recorded. Must
		// stay above the `totalQueries === 0` empty-state gate below.
		if (viewMode === 'tokens') {
			return (
				<TokensView
					key={viewMode}
					timeRange={timeRange}
					theme={theme}
					colorBlindMode={colorBlindMode}
				/>
			);
		}

		if (viewMode === 'anthropic-usage' || viewMode === 'codex-usage') {
			return (
				<ProviderQuotaUsageView
					key={viewMode}
					provider={viewMode === 'anthropic-usage' ? 'anthropic' : 'codex'}
					theme={theme}
					focusedSection={focusedSection}
					setSectionRef={setSectionRef}
					handleSectionKeyDown={handleSectionKeyDown}
				/>
			);
		}

		if (
			!data ||
			(data.totalQueries === 0 && data.bySource.user === 0 && data.bySource.auto === 0)
		) {
			return <EmptyState theme={theme} />;
		}

		switch (viewMode) {
			case 'overview':
				return (
					<OverviewView
						key={viewMode}
						data={data}
						timeRange={timeRange}
						theme={theme}
						colorBlindMode={colorBlindMode}
						sessions={sessions}
						layout={layout}
						cueSourceTotals={cueSourceTotals}
						delegationTotals={delegationTotals}
						lifetimeDelegation={lifetimeDelegation}
						focusedSection={focusedSection}
						setSectionRef={setSectionRef}
						handleSectionKeyDown={handleSectionKeyDown}
					/>
				);
			case 'agents':
				return (
					<AgentsView
						key={viewMode}
						data={data}
						theme={theme}
						sessions={sessions}
						focusedSection={focusedSection}
						setSectionRef={setSectionRef}
						handleSectionKeyDown={handleSectionKeyDown}
						onShowAgentDetails={setDetailSession}
						groups={groups}
					/>
				);
			case 'groups':
				return (
					<GroupsView
						key={viewMode}
						data={data}
						theme={theme}
						sessions={sessions}
						groups={groups}
						activeGroupId={detailGroup?.groupId ?? null}
						onSelectGroup={handleSelectGroup}
						focusedSection={focusedSection}
						setSectionRef={setSectionRef}
						handleSectionKeyDown={handleSectionKeyDown}
					/>
				);
			case 'agent-overview':
				return (
					<AgentOverviewView
						key={viewMode}
						data={data}
						timeRange={timeRange}
						theme={theme}
						colorBlindMode={colorBlindMode}
						sessions={sessions}
						focusedSection={focusedSection}
						setSectionRef={setSectionRef}
						handleSectionKeyDown={handleSectionKeyDown}
					/>
				);
			case 'activity':
				return (
					<ActivityView
						key={viewMode}
						data={data}
						timeRange={timeRange}
						theme={theme}
						colorBlindMode={colorBlindMode}
						delegationByDay={delegationByDay}
						focusedSection={focusedSection}
						setSectionRef={setSectionRef}
						handleSectionKeyDown={handleSectionKeyDown}
					/>
				);
			case 'autorun':
				return (
					<AutoRunView
						key={viewMode}
						data={data}
						timeRange={timeRange}
						theme={theme}
						layout={layout}
						focusedSection={focusedSection}
						setSectionRef={setSectionRef}
						handleSectionKeyDown={handleSectionKeyDown}
					/>
				);
			case 'cue':
				return (
					<DashboardTabPanel key={viewMode} viewMode="cue">
						<CueStats timeRange={timeRange} theme={theme} colorBlindMode={colorBlindMode} />
					</DashboardTabPanel>
				);
			default:
				return null;
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
					...resizableModal.style,
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
				}}
				data-modal-resize-key="usage-dashboard"
			>
				<ResizeHandles
					onResizeStart={resizableModal.onResizeStart}
					accentColor={theme.colors.accent}
					onResetSize={resizableModal.onResetSize}
					canReset={resizableModal.canReset}
				/>

				<UsageDashboardHeader
					theme={theme}
					showNewDataIndicator={showNewDataIndicator}
					timeRange={timeRange}
					onTimeRangeChange={setTimeRange}
					onExport={handleExport}
					isExporting={isExporting}
					onClose={onClose}
					autoRunStats={autoRunStats}
					globalStats={globalStats}
					usageStats={usageStats}
					handsOnTimeMs={handsOnTimeMs}
					leaderboardRegistration={leaderboardRegistration}
				/>

				<UsageDashboardTabs
					ref={tabsRef}
					theme={theme}
					viewMode={viewMode}
					viewModeTabs={viewModeTabs}
					switchViewMode={switchViewMode}
					onKeyDown={handleTabKeyDown}
				/>

				{/* Main Content */}
				<div
					ref={contentRef}
					className="flex-1 overflow-y-auto scrollbar-thin p-6"
					style={{ backgroundColor: theme.colors.bgMain }}
				>
					<TokenSeriesProvider timeRange={timeRange}>{renderTabContent()}</TokenSeriesProvider>
				</div>

				<UsageDashboardFooter
					theme={theme}
					viewMode={viewMode}
					rangeLabel={footerRangeLabel}
					fallbackSummary={footerSummary}
					databaseSizeLabel={footerDatabaseSizeLabel}
				/>
			</div>

			{detailGroup && data && (
				<GroupDetailModal
					rollup={detailGroup}
					sessions={sessions}
					data={data}
					theme={theme}
					onClose={() => setDetailGroup(null)}
					onSelectAgent={handleSelectGroupMember}
				/>
			)}

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
