import { memo, useCallback, useMemo } from 'react';
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
import { AuthRecoveryModal } from '../AuthRecoveryModal';
import { AuthResendModal, type AuthResendRow } from '../AuthResendModal';
import { MergeSessionModal, type MergeOptions } from '../MergeSessionModal';
import { SendToAgentModal, type SendToAgentOptions } from '../SendToAgentModal';
import { TransferProgressModal } from '../TransferProgressModal';
import { LeaderboardRegistrationModal } from '../LeaderboardRegistrationModal';

import { useEventListener } from '../../hooks/utils/useEventListener';
import { getModalActions, selectModalData, useModalStore } from '../../stores/modalStore';
import { getSessionsForIdentity, useProviderAuthStore } from '../../stores/providerAuthStore';
import {
	discardBlockedPrompts,
	getBlockedPrompts,
	resendBlockedPrompts,
	useRetryStore,
} from '../../stores/retryStore';
import { getTabDisplayName } from '../../utils/tabHelpers';

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
	/** The effective error to display - live or historical from chat log */
	effectiveAgentError: AgentError | null;
	recoveryActions: RecoveryAction[];
	onDismissAgentError: () => void;
	/**
	 * When provided, the modal renders a "Jump to failing tab" button that
	 * switches the Left Bar selection to the failing agent and activates the
	 * failing tab. Should be undefined when not applicable (e.g. user is
	 * already on the failing tab, or the error is historical).
	 */
	onJumpToAgent?: () => void;

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
 * Provider auth recovery slot.
 *
 * Self-sourced from `modalStore` rather than prop-threaded through App.tsx, the
 * same shape the snooze and startup-command modals use. Open state is keyed by
 * CREDENTIAL, so all three entry points (the Left Bar auth indicator, the
 * logged-out toast, the command palette) hand over an identity key and land on
 * the same modal.
 *
 * Renders nothing when the key has no stored snapshot. Every entry point derives
 * its key FROM a snapshot, so that means the record was cleared between the
 * click and this render - and a modal that cannot name the account it is
 * repairing is exactly the modal this phase exists to avoid.
 */
const AuthRecoveryModalSlot = memo(function AuthRecoveryModalSlot({
	theme,
	sessions,
}: {
	theme: Theme;
	sessions: Session[];
}) {
	const identityKey = useModalStore(selectModalData('authRecovery'))?.identityKey ?? null;

	// The toast states the intent as data (so it survives the IPC bridge); this is
	// the listener that performs it.
	useEventListener('maestro:openProviderAuthRecovery', (e: Event) => {
		const detail = (e as CustomEvent<{ identityKey?: string }>).detail;
		if (detail?.identityKey) getModalActions().openAuthRecovery(detail.identityKey);
	});

	const identity = useProviderAuthStore((s) =>
		identityKey ? (s.snapshots[identityKey]?.identity ?? null) : null
	);

	// Recomputed when the agent list changes, which is what keeps the "unblocks N
	// agents" count honest while the modal is open.
	// `sessions` is the invalidation signal only - the lookup itself reads the
	// session store, so the identity resolution stays in one place.
	const blockedSessions = useMemo(
		() => (identityKey ? getSessionsForIdentity(identityKey) : []),
		[identityKey, sessions]
	);

	const handleClose = useCallback(() => getModalActions().closeAuthRecovery(), []);

	if (!identityKey || !identity) return null;

	return (
		<AuthRecoveryModal
			identity={identity}
			blockedSessions={blockedSessions}
			theme={theme}
			onClose={handleClose}
		/>
	);
});

/**
 * Post-login resume slot.
 *
 * Opened by `verifyAuthRecovery` when a repaired credential still has prompts
 * parked against it. Everything on screen is resolved HERE rather than carried
 * in the modal data: the user spends time in the login flow, and an agent
 * deleted (or a prompt re-sent by hand) while they were signing in must drop
 * off the list instead of being offered and then silently skipped.
 */
const AuthResendModalSlot = memo(function AuthResendModalSlot({
	theme,
	sessions,
}: {
	theme: Theme;
	sessions: Session[];
}) {
	const identityKey = useModalStore(selectModalData('authResend'))?.identityKey ?? null;

	const identity = useProviderAuthStore((s) =>
		identityKey ? (s.snapshots[identityKey]?.identity ?? null) : null
	);

	// The parked-prompt map is the invalidation signal - a prompt superseded
	// while this modal is open disappears from the list rather than going out
	// when the user clicks Resend.
	const blocked = useRetryStore((s) => s.blocked);

	const sessionIds = useMemo(
		() => (identityKey ? getSessionsForIdentity(identityKey).map((s) => s.id) : []),
		[identityKey, sessions]
	);

	const rows = useMemo<AuthResendRow[]>(
		() =>
			getBlockedPrompts(sessionIds).map((prompt) => {
				const session = sessions.find((s) => s.id === prompt.sessionId);
				const tab = session?.aiTabs.find((t) => t.id === prompt.tabId);
				return {
					key: prompt.key,
					agentName: session?.name ?? 'Agent',
					tabName: tab ? getTabDisplayName(tab) : '',
					preview: prompt.preview,
					failedAt: prompt.failedAt,
				};
			}),
		[sessionIds, sessions, blocked]
	);

	const handleResend = useCallback(() => {
		getModalActions().closeAuthResend();
		void resendBlockedPrompts(sessionIds);
	}, [sessionIds]);

	const handleDecline = useCallback(() => {
		getModalActions().closeAuthResend();
		discardBlockedPrompts(sessionIds);
	}, [sessionIds]);

	if (!identityKey || !identity || rows.length === 0) return null;

	return (
		<AuthResendModal
			identity={identity}
			rows={rows}
			theme={theme}
			onResend={handleResend}
			onDecline={handleDecline}
		/>
	);
});

/**
 * AppAgentModals - Renders agent error and context transfer modals
 *
 * Contains:
 * - LeaderboardRegistrationModal: Register for the runmaestro.ai leaderboard
 * - AgentErrorModal: Display agent errors with recovery options (agents and group chats)
 * - AuthRecoveryModal: Repair one expired provider login (layers above AgentErrorModal)
 * - AuthResendModal: Ask whether to resume the prompts that login had blocked
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
	onJumpToAgent,
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
					onJumpToAgent={onJumpToAgent}
				/>
			)}

			{/* --- PROVIDER AUTH RECOVERY MODAL --- */}
			<AuthRecoveryModalSlot theme={theme} sessions={sessions} />

			{/* --- POST-LOGIN RESUME CONFIRMATION --- */}
			<AuthResendModalSlot theme={theme} sessions={sessions} />

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
