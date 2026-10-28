import { lazy, Suspense, memo, useCallback, useMemo } from 'react';
import type {
	Theme,
	Session,
	Group,
	GroupChat,
	Shortcut,
	KeyboardMasteryStats,
	AutoRunStats,
	MaestroUsageStats,
	LeaderboardRegistration,
} from '../../types';

// Info/Display Modal Components
import { AboutModal } from '../AboutModal';
import { FeedbackModal } from '../FeedbackModal';
import { ShortcutsHelpModal } from '../ShortcutsHelpModal';
import { UpdateCheckModal } from '../UpdateCheckModal';
import {
	getModalActions,
	selectModalData,
	selectModalOpen,
	useModalStore,
} from '../../stores/modalStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { filterLiveAgents } from '../../../shared/agentVisibility';

// Lazy-loaded heavy modals (rarely used, loaded on-demand)
const ProcessMonitor = lazy(() =>
	import('../ProcessMonitor').then((m) => ({ default: m.ProcessMonitor }))
);
const UsageDashboardModal = lazy(() =>
	import('../UsageDashboard').then((m) => ({ default: m.UsageDashboardModal }))
);
const DelegationGraphModal = lazy(() =>
	import('../DelegationGraph/DelegationGraphModal').then((m) => ({
		default: m.DelegationGraphModal,
	}))
);
const AgentRunDashboardModal = lazy(() =>
	import('../AgentRunDashboard').then((m) => ({ default: m.AgentRunDashboardModal }))
);

/**
 * Props for the AppInfoModals component
 */
export interface AppInfoModalsProps {
	theme: Theme;

	// Shortcuts Help Modal
	shortcutsHelpOpen: boolean;
	onCloseShortcutsHelp: () => void;
	shortcuts: Record<string, Shortcut>;
	tabShortcuts: Record<string, Shortcut>;
	hasNoAgents: boolean;
	keyboardMasteryStats: KeyboardMasteryStats;

	// About Modal
	aboutModalOpen: boolean;
	onCloseAboutModal: () => void;
	feedbackModalOpen: boolean;
	onCloseFeedbackModal: () => void;
	autoRunStats: AutoRunStats;
	usageStats?: MaestroUsageStats | null;
	onSwitchToSession: (sessionId: string) => void;
	/** Global hands-on time in milliseconds (from settings) */
	handsOnTimeMs: number;
	onOpenLeaderboardRegistration: () => void;
	isLeaderboardRegistered: boolean;
	leaderboardRegistration?: LeaderboardRegistration | null;

	// Update Check Modal
	updateCheckModalOpen: boolean;
	onCloseUpdateCheckModal: () => void;

	// Process Monitor
	processMonitorOpen: boolean;
	onCloseProcessMonitor: () => void;
	sessions: Session[]; // Used by ProcessMonitor
	groups: Group[];
	groupChats: GroupChat[];
	onNavigateToSession: (sessionId: string, tabId?: string, processType?: string) => void;
	onNavigateToGroupChat: (groupChatId: string) => void;

	// Usage Dashboard Modal
	usageDashboardOpen: boolean;
	onCloseUsageDashboard: () => void;
	/** Default time range for the Usage Dashboard from settings */
	defaultStatsTimeRange?: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all';
	/** Enable colorblind-friendly colors for dashboard charts */
	colorBlindMode?: boolean;
	// AgentRun Dashboard Modal
	agentRunDashboardOpen: boolean;
	onCloseAgentRunDashboard: () => void;
}

/**
 * AppInfoModals - Renders info/display modals (overlay modals only)
 *
 * Contains:
 * - ShortcutsHelpModal: Shows keyboard shortcuts reference
 * - AboutModal: Shows app info and stats
 * - UpdateCheckModal: Shows update status
 * - ProcessMonitor: Shows running processes
 * - UsageDashboardModal: Shows usage analytics and visualizations
 * - DelegationGraphModal: Draws which agent can consult or delegate to which
 *
 * NOTE: LogViewer is intentionally excluded - it's a content replacement component
 * that needs to be positioned in the flex layout, not an overlay modal.
 */
export const AppInfoModals = memo(function AppInfoModals({
	theme,
	// Shortcuts Help Modal
	shortcutsHelpOpen,
	onCloseShortcutsHelp,
	shortcuts,
	tabShortcuts,
	hasNoAgents,
	keyboardMasteryStats,
	// About Modal
	aboutModalOpen,
	onCloseAboutModal,
	feedbackModalOpen,
	onCloseFeedbackModal,
	autoRunStats,
	usageStats,
	onSwitchToSession,
	handsOnTimeMs,
	onOpenLeaderboardRegistration,
	isLeaderboardRegistered,
	leaderboardRegistration,
	// Update Check Modal
	updateCheckModalOpen,
	onCloseUpdateCheckModal,
	// Process Monitor
	processMonitorOpen,
	onCloseProcessMonitor,
	sessions,
	groups,
	groupChats,
	onNavigateToSession,
	onNavigateToGroupChat,
	// Usage Dashboard Modal
	usageDashboardOpen,
	onCloseUsageDashboard,
	defaultStatsTimeRange,
	colorBlindMode,
	// AgentRun Dashboard Modal
	agentRunDashboardOpen,
	onCloseAgentRunDashboard,
}: AppInfoModalsProps) {
	// The Delegation Graph reads the fleet from the session store itself, so it
	// subscribes to the modal store here and takes no props from App.tsx. It is
	// mounted in THIS host on purpose: its Peers link opens the Edit Agent modal
	// (AppSessionModals, later in the DOM), which must paint on top of it.
	const delegationGraphOpen = useModalStore(selectModalOpen('delegationGraph'));
	const delegationGraphData = useModalStore(selectModalData('delegationGraph'));
	const closeDelegationGraph = useCallback(
		() => useModalStore.getState().closeModal('delegationGraph'),
		[]
	);

	// Live agents only: a dormant Pianola (flag off) is not counted, listed, or
	// offered by any of these surfaces.
	const pianolaEnabled = useSettingsStore((s) => s.encoreFeatures.pianola);
	const liveSessions = useMemo(
		() => filterLiveAgents(sessions, { pianola: pianolaEnabled }),
		[sessions, pianolaEnabled]
	);
	return (
		<>
			{/* --- SHORTCUTS HELP MODAL --- */}
			{shortcutsHelpOpen && (
				<ShortcutsHelpModal
					theme={theme}
					shortcuts={shortcuts}
					tabShortcuts={tabShortcuts}
					onClose={onCloseShortcutsHelp}
					hasNoAgents={hasNoAgents}
					keyboardMasteryStats={keyboardMasteryStats}
					onOpenShortcutSettings={() => {
						// Close the overlay first: Settings opens on top of it otherwise,
						// leaving the user to dismiss two surfaces to get back to work.
						onCloseShortcutsHelp();
						getModalActions().openSettings('shortcuts');
					}}
				/>
			)}

			{/* --- ABOUT MODAL --- */}
			{aboutModalOpen && (
				<AboutModal
					theme={theme}
					autoRunStats={autoRunStats}
					usageStats={usageStats}
					handsOnTimeMs={handsOnTimeMs}
					onClose={onCloseAboutModal}
					onOpenLeaderboardRegistration={onOpenLeaderboardRegistration}
					isLeaderboardRegistered={isLeaderboardRegistered}
					leaderboardRegistration={leaderboardRegistration}
				/>
			)}

			{/* --- FEEDBACK MODAL --- */}
			{feedbackModalOpen && (
				<FeedbackModal
					theme={theme}
					sessions={liveSessions}
					onClose={onCloseFeedbackModal}
					onSwitchToSession={onSwitchToSession}
				/>
			)}

			{/* --- UPDATE CHECK MODAL --- */}
			{updateCheckModalOpen && <UpdateCheckModal theme={theme} onClose={onCloseUpdateCheckModal} />}

			{/* --- PROCESS MONITOR (lazy-loaded) --- */}
			{processMonitorOpen && (
				<Suspense fallback={null}>
					<ProcessMonitor
						theme={theme}
						sessions={liveSessions}
						groups={groups}
						groupChats={groupChats}
						onClose={onCloseProcessMonitor}
						onNavigateToSession={onNavigateToSession}
						onNavigateToGroupChat={onNavigateToGroupChat}
					/>
				</Suspense>
			)}

			{/* --- USAGE DASHBOARD MODAL (lazy-loaded) --- */}
			{usageDashboardOpen && (
				<Suspense fallback={null}>
					<UsageDashboardModal
						isOpen={usageDashboardOpen}
						onClose={onCloseUsageDashboard}
						theme={theme}
						defaultTimeRange={defaultStatsTimeRange}
						colorBlindMode={colorBlindMode}
						sessions={liveSessions}
						autoRunStats={autoRunStats}
						usageStats={usageStats}
						handsOnTimeMs={handsOnTimeMs}
						leaderboardRegistration={leaderboardRegistration}
					/>
				</Suspense>
			)}

			{/* --- DELEGATION GRAPH MODAL (lazy-loaded) --- */}
			{delegationGraphOpen && (
				<Suspense fallback={null}>
					<DelegationGraphModal
						theme={theme}
						onClose={closeDelegationGraph}
						scope={delegationGraphData?.scope}
					/>
				</Suspense>
			)}

			{/* --- AGENTRUN DASHBOARD MODAL (lazy-loaded) --- */}
			{agentRunDashboardOpen && (
				<Suspense fallback={null}>
					<AgentRunDashboardModal
						isOpen={agentRunDashboardOpen}
						onClose={onCloseAgentRunDashboard}
						theme={theme}
						onNavigateToSession={onNavigateToSession}
					/>
				</Suspense>
			)}
		</>
	);
});
