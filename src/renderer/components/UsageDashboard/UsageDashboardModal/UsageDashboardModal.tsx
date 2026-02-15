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
import { AgentDetailModal } from '../AgentDetailModal';
import { EmptyState } from '../EmptyState';
import { DashboardSkeleton } from '../ChartSkeletons';
import { CueStats } from '../CueStats';
import type { Session } from '../../../types';
import { useModalLayer } from '../../../hooks/ui/useModalLayer';
import { useResizableModal } from '../../../hooks/ui/useResizableModal';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useClaudeUsageStore } from '../../../stores/claudeUsageStore';
import { useCodexUsageStore } from '../../../stores/codexUsageStore';
import { useGlobalAgentStats } from '../../../hooks/stats/useGlobalAgentStats';
import type { UsageDashboardModalProps } from './types';
import { getSectionsForViewMode, type SectionId } from './sections';
import { hasUsefulAnthropicQuotaDetails, hasUsefulCodexQuotaDetails } from './quotaDetails';
import {
	useQuotaTabDiscovery,
	useUsageDashboardData,
	useUsageDashboardExport,
	useUsageDashboardKeyboard,
	useUsageDashboardLayout,
	useUsageDashboardTabs,
} from './hooks';
import { UsageDashboardFooter, UsageDashboardHeader, UsageDashboardTabs } from './components';
import {
	ActivityView,
	AgentOverviewView,
	AgentsView,
	AutoRunView,
	DashboardTabPanel,
	OverviewView,
	ProviderQuotaUsageView,
	ShortcutsView,
} from './views';
import { AccountUsageDashboard } from '../AccountUsageDashboard';
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
	const { data, cueSourceTotals, loading, error, showNewDataIndicator, databaseSize, fetchStats } =
		useUsageDashboardData({
			isOpen,
			timeRange,
			cueTabEnabled,
		});
	const [focusedSection, setFocusedSection] = useState<SectionId | null>(null);
	const [detailSession, setDetailSession] = useState<Session | null>(null);

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
						viewMode === 'cue' ||
						viewMode === 'agent-overview' ||
						viewMode === 'shortcuts' ||
						viewMode === 'anthropic-usage' ||
						viewMode === 'codex-usage' ||
						viewMode === 'accounts'
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

		if (viewMode === 'accounts') {
			return (
				<AccountUsageDashboard key={viewMode} theme={theme} sessions={sessions} onClose={onClose} />
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
					{renderTabContent()}
				</div>

				<UsageDashboardFooter
					theme={theme}
					data={data}
					timeRange={timeRange}
					databaseSize={databaseSize}
				/>
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
