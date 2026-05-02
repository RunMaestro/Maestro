import { lazy, Suspense, memo } from 'react';
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

// Lazy-loaded heavy modals (rarely used, loaded on-demand)
const ProcessMonitor = lazy(() =>
	import('../ProcessMonitor').then((m) => ({ default: m.ProcessMonitor }))
);
const UsageDashboardModal = lazy(() =>
	import('../UsageDashboard').then((m) => ({ default: m.UsageDashboardModal }))
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
}: AppInfoModalsProps) {
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
					sessions={sessions}
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
						sessions={sessions}
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
						sessions={sessions}
						autoRunStats={autoRunStats}
						usageStats={usageStats}
						handsOnTimeMs={handsOnTimeMs}
						leaderboardRegistration={leaderboardRegistration}
					/>
				</Suspense>
			)}
		</>
	);
});
