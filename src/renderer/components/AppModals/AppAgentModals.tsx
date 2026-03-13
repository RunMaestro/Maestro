import { memo } from 'react';
import type {
	Theme,
	Session,
	GroupChat,
	AgentError,
	ToolType,
	KeyboardMasteryStats,
	AutoRunStats,
	LeaderboardRegistration,
} from '../../types';
import type { GroomingProgress, MergeResult } from '../../types/contextMerge';

// Agent/Transfer Modal Components
import { AgentErrorModal, type RecoveryAction } from '../AgentErrorModal';
import { MergeSessionModal, type MergeOptions } from '../MergeSessionModal';
import { SendToAgentModal, type SendToAgentOptions } from '../SendToAgentModal';
import { TransferProgressModal } from '../TransferProgressModal';
import { LeaderboardRegistrationModal } from '../LeaderboardRegistrationModal';

// Re-export types used by consumers
export type { RecoveryAction, MergeOptions, SendToAgentOptions };

/**
 * Group chat error structure (used for displaying agent errors in group chat context)
 */
export interface GroupChatErrorInfo {
	groupChatId: string;
	participantId?: string;
	participantName?: string;
	error: AgentError;
}

/**
 * Props for the AppAgentModals component
 */
export interface AppAgentModalsProps {
	theme: Theme;
	sessions: Session[];
	activeSession: Session | null;
	groupChats: GroupChat[];

	// LeaderboardRegistrationModal
	leaderboardRegistrationOpen: boolean;
	onCloseLeaderboardRegistration: () => void;
	autoRunStats: AutoRunStats;
	keyboardMasteryStats: KeyboardMasteryStats;
	leaderboardRegistration: LeaderboardRegistration | null;
	onSaveLeaderboardRegistration: (registration: LeaderboardRegistration) => void;
	onLeaderboardOptOut: () => void;
	onSyncAutoRunStats?: (stats: {
		cumulativeTimeMs: number;
		totalRuns: number;
		currentBadgeLevel: number;
		longestRunMs: number;
		longestRunTimestamp: number;
	}) => void;

	// AgentErrorModal (for individual agents)
	errorSession: Session | null | undefined;
	/** The effective error to display — live or historical from chat log */
	effectiveAgentError: AgentError | null;
	recoveryActions: RecoveryAction[];
	onDismissAgentError: () => void;

	// AgentErrorModal (for group chats)
	groupChatError: GroupChatErrorInfo | null;
	groupChatRecoveryActions: RecoveryAction[];
	onClearGroupChatError: () => void;

	// MergeSessionModal
	mergeSessionModalOpen: boolean;
	onCloseMergeSession: () => void;
	onMerge: (
		targetSessionId: string,
		targetTabId: string | undefined,
		options: MergeOptions
	) => Promise<MergeResult>;

	// TransferProgressModal
	transferState: 'idle' | 'grooming' | 'creating' | 'complete' | 'error';
	transferProgress: GroomingProgress | null;
	transferSourceAgent: ToolType | null;
	transferTargetAgent: ToolType | null;
	onCancelTransfer: () => void;
	onCompleteTransfer: () => void;

	// SendToAgentModal
	sendToAgentModalOpen: boolean;
	onCloseSendToAgent: () => void;
	onSendToAgent: (targetSessionId: string, options: SendToAgentOptions) => Promise<MergeResult>;
}

/**
 * AppAgentModals - Renders agent error and context transfer modals
 *
 * Contains:
 * - LeaderboardRegistrationModal: Register for the runmaestro.ai leaderboard
 * - AgentErrorModal: Display agent errors with recovery options (agents and group chats)
 * - MergeSessionModal: Merge current context into another session
 * - TransferProgressModal: Show progress during cross-agent context transfer
 * - SendToAgentModal: Send session context to another Maestro session
 */
export const AppAgentModals = memo(function AppAgentModals({
	theme,
	sessions,
	activeSession,
	groupChats,
	// LeaderboardRegistrationModal
	leaderboardRegistrationOpen,
	onCloseLeaderboardRegistration,
	autoRunStats,
	keyboardMasteryStats,
	leaderboardRegistration,
	onSaveLeaderboardRegistration,
	onLeaderboardOptOut,
	onSyncAutoRunStats,
	// AgentErrorModal (for individual agents)
	errorSession,
	effectiveAgentError,
	recoveryActions,
	onDismissAgentError,
	// AgentErrorModal (for group chats)
	groupChatError,
	groupChatRecoveryActions,
	onClearGroupChatError,
	// MergeSessionModal
	mergeSessionModalOpen,
	onCloseMergeSession,
	onMerge,
	// TransferProgressModal
	transferState,
	transferProgress,
	transferSourceAgent,
	transferTargetAgent,
	onCancelTransfer,
	onCompleteTransfer,
	// SendToAgentModal
	sendToAgentModalOpen,
	onCloseSendToAgent,
	onSendToAgent,
}: AppAgentModalsProps) {
	return (
		<>
			{/* --- LEADERBOARD REGISTRATION MODAL --- */}
			{leaderboardRegistrationOpen && (
				<LeaderboardRegistrationModal
					theme={theme}
					autoRunStats={autoRunStats}
					keyboardMasteryStats={keyboardMasteryStats}
					existingRegistration={leaderboardRegistration}
					onClose={onCloseLeaderboardRegistration}
					onSave={onSaveLeaderboardRegistration}
					onOptOut={onLeaderboardOptOut}
					onSyncStats={onSyncAutoRunStats}
				/>
			)}

			{/* --- AGENT ERROR MODAL (individual agents) --- */}
			{effectiveAgentError && (
				<AgentErrorModal
					theme={theme}
					error={effectiveAgentError}
					agentName={
						errorSession
							? errorSession.toolType === 'claude-code'
								? 'Claude Code'
								: errorSession.toolType
							: undefined
					}
					sessionName={errorSession?.name}
					recoveryActions={recoveryActions}
					onDismiss={onDismissAgentError}
					dismissible={effectiveAgentError.recoverable !== false}
				/>
			)}

			{/* --- AGENT ERROR MODAL (group chats) --- */}
			{groupChatError && (
				<AgentErrorModal
					theme={theme}
					error={groupChatError.error}
					agentName={groupChatError.participantName || 'Group Chat'}
					sessionName={
						groupChats.find((c) => c.id === groupChatError.groupChatId)?.name || 'Unknown'
					}
					recoveryActions={groupChatRecoveryActions}
					onDismiss={onClearGroupChatError}
					dismissible={groupChatError.error.recoverable !== false}
				/>
			)}

			{/* --- MERGE SESSION MODAL --- */}
			{mergeSessionModalOpen && activeSession && activeSession.activeTabId && (
				<MergeSessionModal
					theme={theme}
					isOpen={mergeSessionModalOpen}
					sourceSession={activeSession}
					sourceTabId={activeSession.activeTabId}
					allSessions={sessions}
					onClose={onCloseMergeSession}
					onMerge={onMerge}
				/>
			)}

			{/* --- TRANSFER PROGRESS MODAL --- */}
			{(transferState === 'grooming' ||
				transferState === 'creating' ||
				transferState === 'complete') &&
				transferProgress &&
				transferSourceAgent &&
				transferTargetAgent && (
					<TransferProgressModal
						theme={theme}
						isOpen={true}
						progress={transferProgress}
						sourceAgent={transferSourceAgent}
						targetAgent={transferTargetAgent}
						onCancel={onCancelTransfer}
						onComplete={onCompleteTransfer}
					/>
				)}

			{/* --- SEND TO AGENT MODAL --- */}
			{sendToAgentModalOpen && activeSession && activeSession.activeTabId && (
				<SendToAgentModal
					theme={theme}
					isOpen={sendToAgentModalOpen}
					sourceSession={activeSession}
					sourceTabId={activeSession.activeTabId}
					allSessions={sessions}
					onClose={onCloseSendToAgent}
					onSend={onSendToAgent}
				/>
			)}
		</>
	);
});
