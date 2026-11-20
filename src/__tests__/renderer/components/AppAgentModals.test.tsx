import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AppAgentModals } from '../../../renderer/components/AppModals';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useAuthOutageStore } from '../../../renderer/stores/authOutageStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Theme, Session, AgentError } from '../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';
import type {
	AppAgentModalsProps,
	GroupChatErrorInfo,
} from '../../../renderer/components/AppModals/AppAgentModals';

vi.mock('../../../renderer/components/AgentErrorModal', () => ({
	AgentErrorModal: (props: any) => (
		<div data-testid="agent-error-modal" data-agent-name={props.agentName} />
	),
}));
vi.mock('../../../renderer/components/ReauthModal', () => ({
	ReauthModal: (props: any) => (
		<div
			data-testid="reauth-modal"
			data-session-name={props.session?.name}
			data-blocked={String(props.outage?.blocked?.length ?? 0)}
		/>
	),
}));
const mockClearAgentError = vi.fn();
vi.mock('../../../renderer/stores/agentStore', () => ({
	useAgentStore: {
		getState: () => ({
			clearAgentError: mockClearAgentError,
		}),
	},
}));

const mockReplayAfterAuth = vi.fn();
vi.mock('../../../renderer/stores/retryStore', () => ({
	replayAfterAuth: (...args: unknown[]) => mockReplayAfterAuth(...args),
}));

const mockNotifyToast = vi.fn();
vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => mockNotifyToast(...args),
}));

vi.mock('../../../renderer/components/ProviderInstallModal', () => ({
	ProviderInstallModal: (props: any) => (
		<div data-testid="provider-install-modal">
			<button data-testid="provider-install-retry-trigger" onClick={props.onRetry}>
				Retry
			</button>
		</div>
	),
}));

vi.mock('../../../renderer/components/MergeSessionModal', () => ({
	MergeSessionModal: (props: any) => <div data-testid="merge-session-modal" />,
}));
vi.mock('../../../renderer/components/SendToAgentModal', () => ({
	SendToAgentModal: (props: any) => <div data-testid="send-to-agent-modal" />,
}));
vi.mock('../../../renderer/components/TransferProgressModal', () => ({
	TransferProgressModal: (props: any) => <div data-testid="transfer-progress-modal" />,
}));
vi.mock('../../../renderer/components/LeaderboardRegistrationModal', () => ({
	LeaderboardRegistrationModal: (props: any) => (
		<div data-testid="leaderboard-registration-modal" />
	),
}));

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
	},
};

function createMockSession(overrides: Partial<Session>): Session {
	return baseCreateMockSession({ name: 'Agent 1', cwd: '/tmp', ...overrides });
}

const defaultProps: AppAgentModalsProps = {
	theme: testTheme,
	sessions: [],
	activeSession: null,
	groupChats: [],

	// LeaderboardRegistrationModal
	leaderboardRegistrationOpen: false,
	onCloseLeaderboardRegistration: vi.fn(),
	autoRunStats: {
		cumulativeTimeMs: 0,
		totalRuns: 0,
		currentBadgeLevel: 0,
		longestRunMs: 0,
		longestRunTimestamp: 0,
	},
	keyboardMasteryStats: {
		totalShortcutsUsed: 0,
		uniqueShortcutsUsed: 0,
		shortcutUsageCounts: {},
		level: 0,
		levelName: 'Novice',
		progress: 0,
	},
	leaderboardRegistration: null,
	onSaveLeaderboardRegistration: vi.fn(),
	onLeaderboardOptOut: vi.fn(),

	// AgentErrorModal (individual)
	errorSession: null,
	effectiveAgentError: null,
	recoveryActions: [],
	onDismissAgentError: vi.fn(),

	// AgentErrorModal (group chats)
	groupChatError: null,
	groupChatRecoveryActions: [],
	onClearGroupChatError: vi.fn(),

	// MergeSessionModal
	mergeSessionModalOpen: false,
	onCloseMergeSession: vi.fn(),
	onMerge: vi.fn(),

	// TransferProgressModal
	transferState: 'idle',
	transferProgress: null,
	transferSourceAgent: null,
	transferTargetAgent: null,
	onCancelTransfer: vi.fn(),
	onCompleteTransfer: vi.fn(),

	// SendToAgentModal
	sendToAgentModalOpen: false,
	onCloseSendToAgent: vi.fn(),
	onSendToAgent: vi.fn(),
};

describe('AppAgentModals', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useModalStore.getState().closeModal('reauth');
		useAuthOutageStore.setState({ outages: {} });
	});

	it('does not render any modals when all booleans/values are default', () => {
		const { container } = render(<AppAgentModals {...defaultProps} />);
		expect(screen.queryByTestId('leaderboard-registration-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('agent-error-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('merge-session-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('transfer-progress-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('send-to-agent-modal')).not.toBeInTheDocument();
	});

	it('renders LeaderboardRegistrationModal when leaderboardRegistrationOpen is true', () => {
		render(<AppAgentModals {...defaultProps} leaderboardRegistrationOpen={true} />);
		expect(screen.getByTestId('leaderboard-registration-modal')).toBeInTheDocument();
	});

	it('renders AgentErrorModal when effectiveAgentError is set', () => {
		const error: AgentError = {
			type: 'crash',
			message: 'Test error',
			recoverable: true,
		};
		const errorSession = createMockSession({ id: 'err-session', toolType: 'claude-code' });
		render(
			<AppAgentModals
				{...defaultProps}
				effectiveAgentError={error}
				errorSession={errorSession}
				recoveryActions={[]}
			/>
		);
		expect(screen.getByTestId('agent-error-modal')).toBeInTheDocument();
	});

	it('renders AgentErrorModal for group chat errors when groupChatError is set', () => {
		const groupChatError: GroupChatErrorInfo = {
			groupChatId: 'gc-1',
			participantId: 'p-1',
			participantName: 'Test Agent',
			error: {
				type: 'crash',
				message: 'Group chat error',
				recoverable: true,
			},
		};
		render(
			<AppAgentModals
				{...defaultProps}
				groupChatError={groupChatError}
				groupChatRecoveryActions={[]}
			/>
		);
		const modals = screen.getAllByTestId('agent-error-modal');
		expect(modals.length).toBeGreaterThanOrEqual(1);
		const groupChatModal = modals.find((m) => m.getAttribute('data-agent-name') === 'Test Agent');
		expect(groupChatModal).toBeTruthy();
	});

	// The re-authentication modal is self-sourced from the modal store: it is
	// opened by the agent-error listener and by Cue pipeline auth failures, which
	// never pass through App.tsx's modal props.
	it('renders ReauthModal for the provider outage, hosted by a blocked agent', () => {
		const session = createMockSession({ id: 'auth-session', name: 'Pipeline Agent' });
		useAuthOutageStore.setState({
			outages: {
				'claude-code': {
					providerKey: 'claude-code',
					toolType: 'claude-code',
					message: 'OAuth token has expired.',
					startedAt: 1,
					blocked: [{ sessionId: 'auth-session', tabIds: ['tab-1'] }],
					fromPipeline: true,
					initiatedBy: 'failure',
				},
			},
		});
		useModalStore.getState().openModal('reauth', { providerKey: 'claude-code' });

		render(<AppAgentModals {...defaultProps} sessions={[session]} />);

		const modal = screen.getByTestId('reauth-modal');
		expect(modal.getAttribute('data-blocked')).toBe('1');
		expect(modal.getAttribute('data-session-name')).toBe('Pipeline Agent');
	});

	it('does not render ReauthModal when the outage is gone', () => {
		useModalStore.getState().openModal('reauth', { providerKey: 'claude-code' });

		render(<AppAgentModals {...defaultProps} sessions={[]} />);

		expect(screen.queryByTestId('reauth-modal')).not.toBeInTheDocument();
	});

	it('renders MergeSessionModal when mergeSessionModalOpen and activeSession has activeTabId', () => {
		const activeSession = createMockSession({ id: 'merge-session', activeTabId: 'tab-1' });
		render(
			<AppAgentModals
				{...defaultProps}
				mergeSessionModalOpen={true}
				activeSession={activeSession}
			/>
		);
		expect(screen.getByTestId('merge-session-modal')).toBeInTheDocument();
	});

	it('does not render MergeSessionModal when activeSession has no activeTabId', () => {
		const activeSession = createMockSession({ id: 'merge-session' });
		render(
			<AppAgentModals
				{...defaultProps}
				mergeSessionModalOpen={true}
				activeSession={activeSession}
			/>
		);
		expect(screen.queryByTestId('merge-session-modal')).not.toBeInTheDocument();
	});

	it('renders TransferProgressModal when transferState is grooming with required fields', () => {
		render(
			<AppAgentModals
				{...defaultProps}
				transferState="grooming"
				transferProgress={{ stage: 'grooming', progress: 50, message: 'Grooming context...' }}
				transferSourceAgent="claude-code"
				transferTargetAgent="codex"
			/>
		);
		expect(screen.getByTestId('transfer-progress-modal')).toBeInTheDocument();
	});

	it('renders SendToAgentModal when sendToAgentModalOpen and activeSession has activeTabId', () => {
		const activeSession = createMockSession({ id: 'send-session', activeTabId: 'tab-1' });
		render(
			<AppAgentModals {...defaultProps} sendToAgentModalOpen={true} activeSession={activeSession} />
		);
		expect(screen.getByTestId('send-to-agent-modal')).toBeInTheDocument();
	});

	describe('ProviderInstallModal retry handling', () => {
		beforeEach(() => {
			mockClearAgentError.mockClear();
			mockReplayAfterAuth.mockClear();
			mockNotifyToast.mockClear();
		});

		it('reprobes and replays the original tab with reason install when still open', async () => {
			const reprobe = vi.fn().mockResolvedValue({ status: 'ok' });
			(window as any).maestro.agents = { ...(window as any).maestro.agents, reprobe };
			const session = createMockSession({
				id: 'install-sess',
				toolType: 'codex',
				activeTabId: 'tab-1',
				aiTabs: [{ id: 'tab-1', logs: [] } as any],
			});
			useSessionStore.setState({ sessions: [session] });
			useModalStore.getState().openModal('providerInstall', {
				sessionId: 'install-sess',
				tabId: 'tab-1',
			});

			render(<AppAgentModals {...defaultProps} sessions={[session]} />);
			fireEvent.click(screen.getByTestId('provider-install-retry-trigger'));

			await waitFor(() => expect(reprobe).toHaveBeenCalledWith('codex'));
			await waitFor(() =>
				expect(mockReplayAfterAuth).toHaveBeenCalledWith('install-sess', ['tab-1'], 'install')
			);
			expect(mockClearAgentError).toHaveBeenCalledWith('install-sess', 'tab-1');
			expect(mockNotifyToast).not.toHaveBeenCalled();
		});

		it('never sends into another tab and notifies when the original tab was closed', async () => {
			const reprobe = vi.fn().mockResolvedValue({ status: 'ok' });
			(window as any).maestro.agents = { ...(window as any).maestro.agents, reprobe };
			const session = createMockSession({
				id: 'install-sess',
				toolType: 'codex',
				activeTabId: 'tab-other',
				aiTabs: [{ id: 'tab-other', logs: [] } as any],
			});
			useSessionStore.setState({ sessions: [session] });
			useModalStore.getState().openModal('providerInstall', {
				sessionId: 'install-sess',
				tabId: 'tab-closed',
			});

			render(<AppAgentModals {...defaultProps} sessions={[session]} />);
			fireEvent.click(screen.getByTestId('provider-install-retry-trigger'));

			await waitFor(() =>
				expect(mockNotifyToast).toHaveBeenCalledWith(
					expect.objectContaining({
						color: 'yellow',
						title: 'Nothing to resend',
					})
				)
			);
			expect(mockReplayAfterAuth).not.toHaveBeenCalled();
			expect(mockClearAgentError).not.toHaveBeenCalled();
		});

		it('catches a tab closed during reprobe and notifies instead of replaying', async () => {
			let resolveReprobe!: () => void;
			const reprobe = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						resolveReprobe = resolve;
					})
			);
			(window as any).maestro.agents = { ...(window as any).maestro.agents, reprobe };
			const session = createMockSession({
				id: 'install-sess',
				toolType: 'codex',
				activeTabId: 'tab-1',
				aiTabs: [{ id: 'tab-1', logs: [] } as any, { id: 'tab-other', logs: [] } as any],
			});
			useSessionStore.setState({ sessions: [session] });
			useModalStore.getState().openModal('providerInstall', {
				sessionId: 'install-sess',
				tabId: 'tab-1',
			});

			render(<AppAgentModals {...defaultProps} sessions={[session]} />);
			fireEvent.click(screen.getByTestId('provider-install-retry-trigger'));

			await waitFor(() => expect(reprobe).toHaveBeenCalledWith('codex'));
			// Close tab-1 while reprobe is in flight.
			useSessionStore.setState({
				sessions: [
					{
						...session,
						activeTabId: 'tab-other',
						aiTabs: [{ id: 'tab-other', logs: [] } as any],
					},
				],
			});
			resolveReprobe();

			await waitFor(() =>
				expect(mockNotifyToast).toHaveBeenCalledWith(
					expect.objectContaining({
						color: 'yellow',
						title: 'Nothing to resend',
					})
				)
			);
			expect(mockReplayAfterAuth).not.toHaveBeenCalled();
			expect(mockClearAgentError).not.toHaveBeenCalled();
		});
	});
});
