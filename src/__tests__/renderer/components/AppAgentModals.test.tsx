import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppAgentModals } from '../../../renderer/components/AppModals';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useProviderAuthStore } from '../../../renderer/stores/providerAuthStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useAgentStore, type ProcessQueuedItemDeps } from '../../../renderer/stores/agentStore';
import {
	noteAuthBlockedPrompt,
	noteDispatch,
	useRetryStore,
} from '../../../renderer/stores/retryStore';
import type { CredentialIdentity, ProviderAuthSnapshot } from '../../../shared/providerAuth';
import type { Theme, Session, AgentError } from '../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type {
	AppAgentModalsProps,
	GroupChatErrorInfo,
} from '../../../renderer/components/AppModals/AppAgentModals';

vi.mock('../../../renderer/components/AgentErrorModal', () => ({
	AgentErrorModal: (props: any) => (
		<div data-testid="agent-error-modal" data-agent-name={props.agentName} />
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
// Stubbed so these tests are about the WIRING (which identity, which agents,
// who closes it). The modal's own behavior is covered by its own test file.
vi.mock('../../../renderer/components/AuthRecoveryModal', () => ({
	AuthRecoveryModal: (props: any) => (
		<div
			data-testid="auth-recovery-modal"
			data-identity-key={props.identity.key}
			data-blocked={props.blockedSessions.map((s: Session) => s.id).join(',')}
			onClick={props.onClose}
		/>
	),
}));
vi.mock('../../../renderer/components/AuthResendModal', () => ({
	AuthResendModal: (props: any) => (
		<div data-testid="auth-resend-modal" data-identity-key={props.identity.key}>
			<span data-testid="auth-resend-rows">
				{props.rows.map((r: any) => `${r.agentName}/${r.tabName}/${r.preview}`).join('|')}
			</span>
			<button data-testid="auth-resend-stub-confirm" onClick={props.onResend} />
			<button data-testid="auth-resend-stub-decline" onClick={props.onDecline} />
		</div>
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
});

/**
 * The recovery modal's slot. Every entry point (Left Bar indicator, logged-out
 * toast, command palette) hands over an IDENTITY key, so the wiring's job is to
 * put the right account and the right agent list on screen - a modal opened for
 * `.claude-gmail` that signs into `.claude-smash` is the exact failure the phase
 * exists to prevent.
 */
describe('AppAgentModals - auth recovery slot', () => {
	const HOME = '/Users/x';
	const DEFAULT_KEY = `claude-code::oauth::${HOME}/.claude::local`;
	const SIBLING_DIR = `${HOME}/.claude-smash`;
	const SIBLING_KEY = `claude-code::oauth::${SIBLING_DIR}::local`;

	const identityFor = (key: string, label: string): CredentialIdentity => ({
		key,
		provider: 'claude-code',
		kind: 'oauth',
		scope: key.split('::')[2],
		host: 'local',
		label,
	});

	const snapshotFor = (key: string, label: string): ProviderAuthSnapshot => ({
		identity: identityFor(key, label),
		status: 'logged-out',
		checkedAt: 1,
		source: 'probe',
	});

	beforeEach(() => {
		useProviderAuthStore.getState().__resetForTests();
		useModalStore.getState().closeModal('authRecovery');
		useProviderAuthStore.setState({
			homeDir: HOME,
			agentEnvVars: { 'claude-code': {} },
			snapshots: {
				[DEFAULT_KEY]: snapshotFor(DEFAULT_KEY, '.claude'),
				[SIBLING_KEY]: snapshotFor(SIBLING_KEY, '.claude-smash'),
			},
			loaded: true,
		});
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'a', toolType: 'claude-code' }),
				createMockSession({ id: 'b', toolType: 'claude-code' }),
				createMockSession({
					id: 'sibling',
					toolType: 'claude-code',
					customEnvVars: { CLAUDE_CONFIG_DIR: SIBLING_DIR },
				}),
			],
		});
	});

	it('renders nothing until an identity is opened', () => {
		render(<AppAgentModals {...defaultProps} />);
		expect(screen.queryByTestId('auth-recovery-modal')).not.toBeInTheDocument();
	});

	it("opens for the identity in the store and lists only that account's agents", () => {
		useModalStore.getState().openModal('authRecovery', { identityKey: DEFAULT_KEY });
		render(<AppAgentModals {...defaultProps} sessions={useSessionStore.getState().sessions} />);

		const modal = screen.getByTestId('auth-recovery-modal');
		expect(modal.getAttribute('data-identity-key')).toBe(DEFAULT_KEY);
		// 'sibling' is on a different config dir, so this login does not unblock it.
		expect(modal.getAttribute('data-blocked')).toBe('a,b');
	});

	it('opens the account the toast names, not the one already on screen', () => {
		useModalStore.getState().openModal('authRecovery', { identityKey: DEFAULT_KEY });
		render(<AppAgentModals {...defaultProps} sessions={useSessionStore.getState().sessions} />);

		act(() => {
			window.dispatchEvent(
				new CustomEvent('maestro:openProviderAuthRecovery', {
					detail: { identityKey: SIBLING_KEY },
				})
			);
		});

		const modal = screen.getByTestId('auth-recovery-modal');
		expect(modal.getAttribute('data-identity-key')).toBe(SIBLING_KEY);
		expect(modal.getAttribute('data-blocked')).toBe('sibling');
	});

	it('closes through the modal store, so a reopen is not blocked by stale state', () => {
		useModalStore.getState().openModal('authRecovery', { identityKey: DEFAULT_KEY });
		render(<AppAgentModals {...defaultProps} sessions={useSessionStore.getState().sessions} />);

		fireEvent.click(screen.getByTestId('auth-recovery-modal'));

		expect(useModalStore.getState().isOpen('authRecovery')).toBe(false);
		expect(screen.queryByTestId('auth-recovery-modal')).not.toBeInTheDocument();
	});

	it('renders nothing when the credential has no stored snapshot', () => {
		// The record was cleared between the click and this render. A modal that
		// cannot name the account it repairs must not be shown.
		useModalStore.getState().openModal('authRecovery', { identityKey: 'gone::oauth::x::local' });
		render(<AppAgentModals {...defaultProps} sessions={useSessionStore.getState().sessions} />);
		expect(screen.queryByTestId('auth-recovery-modal')).not.toBeInTheDocument();
	});
});

/**
 * The post-login resume slot. Its job is to be honest about what a click will
 * do: list every prompt that will actually be sent, drop the ones that stopped
 * being sendable while the user was signing in, and send nothing at all until
 * the user says so.
 */
describe('AppAgentModals - auth resend slot', () => {
	const HOME = '/Users/x';
	const DEFAULT_KEY = `claude-code::oauth::${HOME}/.claude::local`;
	const SIBLING_DIR = `${HOME}/.claude-smash`;

	const dispatchDeps = {
		conductorProfile: '',
		customAICommands: [],
		speckitCommands: [],
		openspecCommands: [],
	} as unknown as ProcessQueuedItemDeps;

	let processQueuedItem: ReturnType<typeof vi.fn>;

	/** Dispatch a prompt on an agent's tab, then park it as an auth casualty. */
	function park(sessionId: string, text: string) {
		const tabId = `${sessionId}-tab`;
		noteDispatch(
			sessionId,
			{ id: `${sessionId}-item`, timestamp: 1, tabId, type: 'message', text },
			dispatchDeps
		);
		noteAuthBlockedPrompt(sessionId, tabId);
	}

	function agent(id: string, extra: Partial<Session> = {}): Session {
		return createMockSession({
			id,
			name: id,
			toolType: 'claude-code',
			aiTabs: [createMockAITab({ id: `${id}-tab`, name: `${id} tab` })],
			activeTabId: `${id}-tab`,
			...extra,
		});
	}

	beforeEach(() => {
		useProviderAuthStore.getState().__resetForTests();
		useModalStore.setState({ modals: new Map() });
		useRetryStore.setState({ retries: {}, outages: {}, blocked: {} });
		processQueuedItem = vi.fn().mockResolvedValue(undefined);
		useAgentStore.setState({ processQueuedItem } as any);
		useProviderAuthStore.setState({
			homeDir: HOME,
			agentEnvVars: { 'claude-code': {} },
			snapshots: {
				[DEFAULT_KEY]: {
					identity: {
						key: DEFAULT_KEY,
						provider: 'claude-code',
						kind: 'oauth',
						scope: `${HOME}/.claude`,
						host: 'local',
						label: '.claude',
					},
					status: 'authenticated',
					checkedAt: 1,
					source: 'login-flow',
				},
			},
			loaded: true,
		});
		useSessionStore.setState({
			sessions: [
				agent('a'),
				agent('b'),
				agent('sibling', { customEnvVars: { CLAUDE_CONFIG_DIR: SIBLING_DIR } }),
			],
		});
	});

	it('renders nothing when nothing is parked for the credential', () => {
		useModalStore.getState().openModal('authResend', { identityKey: DEFAULT_KEY });
		render(<AppAgentModals {...defaultProps} sessions={useSessionStore.getState().sessions} />);
		expect(screen.queryByTestId('auth-resend-modal')).not.toBeInTheDocument();
	});

	it("lists only this credential's prompts, oldest failure first", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(2_000);
			park('b', 'second prompt');
			vi.setSystemTime(1_000);
			park('a', 'first prompt');
			park('sibling', 'not this account');
		} finally {
			vi.useRealTimers();
		}

		useModalStore.getState().openModal('authResend', { identityKey: DEFAULT_KEY });
		render(<AppAgentModals {...defaultProps} sessions={useSessionStore.getState().sessions} />);

		expect(screen.getByTestId('auth-resend-modal').getAttribute('data-identity-key')).toBe(
			DEFAULT_KEY
		);
		expect(screen.getByTestId('auth-resend-rows').textContent).toBe(
			'a/a tab/first prompt|b/b tab/second prompt'
		);
	});

	it('sends every listed prompt when the user confirms, then closes', async () => {
		park('a', 'first prompt');
		park('b', 'second prompt');
		useModalStore.getState().openModal('authResend', { identityKey: DEFAULT_KEY });
		render(<AppAgentModals {...defaultProps} sessions={useSessionStore.getState().sessions} />);

		await act(async () => {
			fireEvent.click(screen.getByTestId('auth-resend-stub-confirm'));
		});

		expect(processQueuedItem.mock.calls.map((call) => call[0])).toEqual(['a', 'b']);
		expect(useModalStore.getState().isOpen('authResend')).toBe(false);
	});

	it('sends nothing when the user declines, and does not ask again', async () => {
		park('a', 'first prompt');
		useModalStore.getState().openModal('authResend', { identityKey: DEFAULT_KEY });
		render(<AppAgentModals {...defaultProps} sessions={useSessionStore.getState().sessions} />);

		await act(async () => {
			fireEvent.click(screen.getByTestId('auth-resend-stub-decline'));
		});

		expect(processQueuedItem).not.toHaveBeenCalled();
		expect(useModalStore.getState().isOpen('authResend')).toBe(false);
		expect(useRetryStore.getState().blocked).toEqual({});
	});

	it('drops an agent deleted while the user was logging in', () => {
		park('a', 'first prompt');
		park('b', 'second prompt');
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.filter((s) => s.id !== 'a'),
		});

		useModalStore.getState().openModal('authResend', { identityKey: DEFAULT_KEY });
		render(<AppAgentModals {...defaultProps} sessions={useSessionStore.getState().sessions} />);

		expect(screen.getByTestId('auth-resend-rows').textContent).toBe('b/b tab/second prompt');
	});
});
