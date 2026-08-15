/**
 * Auth recovery end to end, across the surfaces Phase 05 rewired.
 *
 * The unit tests either side of this file each hold one link of the chain: the
 * recovery hook maps a credential to an action, `verifyAuthRecovery` opens a
 * modal, the resend modal reports a click, the retry store dispatches. What
 * none of them prove is that the links are joined to each other - and every
 * bug this phase existed to fix lived exactly there. The old "Use Terminal"
 * button was a perfectly good button wired to nothing that could help.
 *
 * So this file runs the real hook against the real identity resolver, and the
 * real login flow against the real resend modal:
 *
 *   1. An expired login on ONE agent opens the recovery modal for THAT agent's
 *      account, out of several signed in at once.
 *   2. A credential no login repairs offers the env-var editor instead, and
 *      never the login.
 *   3. A successful login offers the parked prompts back, sends one per
 *      blocked agent in the order they failed when the user confirms, and
 *      sends nothing at all when the user declines.
 *   4. An agent deleted while the user was signing in drops off the list
 *      rather than being offered and then skipped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';

// useModalHandlers reaches for git on unrelated paths; neither is under test here.
vi.mock('../../renderer/services/git', () => ({
	gitService: { getDiff: vi.fn().mockResolvedValue({ diff: '' }) },
}));
vi.mock('../../renderer/contexts/GitStatusContext', () => ({
	useGitDetail: () => ({
		getFileDetails: () => undefined,
		refreshGitStatus: vi.fn().mockResolvedValue(undefined),
	}),
}));

// Stubbed because they are heavy and never rendered by these cases. The resend
// modal is deliberately NOT stubbed - its buttons are half of what is on trial.
vi.mock('../../renderer/components/AgentErrorModal', () => ({
	AgentErrorModal: () => <div data-testid="agent-error-modal" />,
}));
vi.mock('../../renderer/components/MergeSessionModal', () => ({
	MergeSessionModal: () => <div data-testid="merge-session-modal" />,
}));
vi.mock('../../renderer/components/SendToAgentModal', () => ({
	SendToAgentModal: () => <div data-testid="send-to-agent-modal" />,
}));
vi.mock('../../renderer/components/TransferProgressModal', () => ({
	TransferProgressModal: () => <div data-testid="transfer-progress-modal" />,
}));
vi.mock('../../renderer/components/LeaderboardRegistrationModal', () => ({
	LeaderboardRegistrationModal: () => <div data-testid="leaderboard-registration-modal" />,
}));
vi.mock('../../renderer/components/AuthRecoveryModal', () => ({
	AuthRecoveryModal: (props: { identity: { key: string } }) => (
		<div data-testid="auth-recovery-modal" data-identity-key={props.identity.key} />
	),
}));

import { AppAgentModals } from '../../renderer/components/AppModals';
import type { AppAgentModalsProps } from '../../renderer/components/AppModals/AppAgentModals';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { useModalHandlers } from '../../renderer/hooks/modal/useModalHandlers';
import { verifyAuthRecovery } from '../../renderer/services/authRecovery';
import { useAgentStore, type ProcessQueuedItemDeps } from '../../renderer/stores/agentStore';
import { getModalActions, useModalStore } from '../../renderer/stores/modalStore';
import { useProviderAuthStore } from '../../renderer/stores/providerAuthStore';
import {
	noteAuthBlockedPrompt,
	noteDispatch,
	useRetryStore,
} from '../../renderer/stores/retryStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';
import type { ProviderAuthSnapshot } from '../../shared/providerAuth';
import type { AgentError, Session } from '../../renderer/types';
import { createMockSession } from '../helpers/mockSession';
import { createMockAITab } from '../helpers/mockTab';
import { mockTheme } from '../helpers/mockTheme';

const HOME = '/Users/x';
const GMAIL_DIR = `${HOME}/.claude-gmail`;
const GMAIL_KEY = `claude-code::oauth::${GMAIL_DIR}::local`;
const SMASH_DIR = `${HOME}/.claude-smash`;
const SMASH_KEY = `claude-code::oauth::${SMASH_DIR}::local`;

const authError = (): AgentError => ({
	type: 'auth_expired',
	message: 'Invalid API key. Please run /login',
	recoverable: true,
	agentId: 'claude-code',
	timestamp: 1,
});

/** An agent on one config dir (or one raw key), optionally already in error. */
function makeSession(id: string, env: Record<string, string>, error?: AgentError): Session {
	return createMockSession({
		id,
		name: id,
		toolType: 'claude-code',
		customEnvVars: env,
		aiTabs: [
			createMockAITab({
				id: `${id}-tab`,
				name: `${id} tab`,
				...(error ? { agentError: error } : {}),
			}),
		],
		activeTabId: `${id}-tab`,
		...(error
			? {
					agentError: error,
					agentErrorTabId: `${id}-tab`,
					agentErrorPaused: true,
					state: 'error' as const,
				}
			: {}),
	});
}

function oauthSnapshot(key: string, label: string, accountLabel?: string): ProviderAuthSnapshot {
	return {
		identity: {
			key,
			provider: 'claude-code',
			kind: 'oauth',
			scope: key.split('::')[2],
			host: 'local',
			label,
		},
		status: 'authenticated',
		checkedAt: 1,
		source: 'probe',
		...(accountLabel ? { accountLabel } : {}),
	};
}

function seedStores(): void {
	useProviderAuthStore.getState().__resetForTests();
	useProviderAuthStore.setState({
		homeDir: HOME,
		agentEnvVars: { 'claude-code': {} },
		loaded: true,
	});
	useSessionStore.setState({ sessions: [] } as never);
	useModalStore.setState({ modals: new Map() });
	useRetryStore.setState({ retries: {}, outages: {}, blocked: {} });
}

// ============================================================================
// The error modal's auth action
// ============================================================================

describe('auth recovery flow - the error modal offers the remedy the credential actually has', () => {
	const createInputRef = () => ({
		current: { focus: vi.fn() } as unknown as HTMLTextAreaElement,
	});
	const createTerminalOutputRef = () => ({
		current: { focus: vi.fn() } as unknown as HTMLDivElement,
	});

	function renderHandlers() {
		return renderHook(() => useModalHandlers(createInputRef(), createTerminalOutputRef()));
	}

	beforeEach(() => {
		vi.clearAllMocks();
		seedStores();
	});

	afterEach(() => {
		cleanup();
	});

	it("opens the recovery modal for the failing agent's account, not for a sibling login", () => {
		useProviderAuthStore.setState({
			snapshots: {
				[GMAIL_KEY]: oauthSnapshot(GMAIL_KEY, '.claude-gmail', 'pedram@example.com'),
				[SMASH_KEY]: oauthSnapshot(SMASH_KEY, '.claude-smash', 'smash@example.com'),
			},
		});
		useSessionStore.setState({
			sessions: [
				makeSession('smash', { CLAUDE_CONFIG_DIR: SMASH_DIR }),
				makeSession('gmail', { CLAUDE_CONFIG_DIR: GMAIL_DIR }, authError()),
			],
		} as never);
		getModalActions().setAgentErrorModalSessionId('gmail');

		const { result } = renderHandlers();
		const [action] = result.current.recoveryActions;

		// Named after the account the probe found, never after the agent id.
		expect(action.id).toBe('authenticate');
		expect(action.label).toBe('Sign in to Claude Code (pedram@example.com)');

		act(() => {
			action.onClick();
		});

		expect(useModalStore.getState().isOpen('authRecovery')).toBe(true);
		expect(useModalStore.getState().getData('authRecovery')?.identityKey).toBe(GMAIL_KEY);
		// The error stays on screen behind the login: a login that fails must not
		// leave the user looking at nothing.
		expect(useModalStore.getState().isOpen('agentError')).toBe(true);
	});

	it('offers the env-var editor, and no login, for a credential signing in cannot repair', () => {
		useSessionStore.setState({
			sessions: [makeSession('keyed', { ANTHROPIC_API_KEY: 'sk-rejected' }, authError())],
		} as never);
		getModalActions().setAgentErrorModalSessionId('keyed');

		const { result } = renderHandlers();
		const [action] = result.current.recoveryActions;

		expect(action.id).toBe('configure-credentials');
		expect(action.description).toContain('ANTHROPIC_API_KEY');
		expect(result.current.recoveryActions.some((a) => a.id === 'authenticate')).toBe(false);

		act(() => {
			action.onClick();
		});

		expect(useModalStore.getState().isOpen('editAgent')).toBe(true);
		expect(useModalStore.getState().getData('editAgent')?.session.id).toBe('keyed');
		expect(useModalStore.getState().isOpen('authRecovery')).toBe(false);
		// The key is still rejected until the user changes it, so the error stands.
		expect(useModalStore.getState().isOpen('agentError')).toBe(false);
	});
});

// ============================================================================
// Login -> offer -> resend
// ============================================================================

describe('auth recovery flow - a repaired login offers the blocked prompts back', () => {
	const dispatchDeps = {
		conductorProfile: '',
		customAICommands: [],
		speckitCommands: [],
		openspecCommands: [],
	} as unknown as ProcessQueuedItemDeps;

	let processQueuedItem: ReturnType<typeof vi.fn>;
	let savedMaestro: unknown;

	/** Dispatch a prompt on an agent's tab, then park it as an auth casualty at `failedAt`. */
	function park(sessionId: string, text: string, failedAt: number): void {
		const tabId = `${sessionId}-tab`;
		noteDispatch(
			sessionId,
			{ id: `${sessionId}-item`, timestamp: 1, tabId, type: 'message', text },
			dispatchDeps
		);
		vi.useFakeTimers();
		try {
			vi.setSystemTime(failedAt);
			noteAuthBlockedPrompt(sessionId, tabId);
		} finally {
			vi.useRealTimers();
		}
	}

	/** A bridge whose re-probe reports the credential as repaired. */
	function installBridge(): void {
		(window as unknown as { maestro: unknown }).maestro = {
			providerAuth: {
				getAll: vi.fn().mockResolvedValue({}),
				onChange: () => () => {},
				reprobe: vi.fn(async (key: string) => {
					const snapshot = oauthSnapshot(key, '.claude-gmail');
					useProviderAuthStore.getState().applyChange(key, snapshot);
					return {
						identities: 1,
						probed: 1,
						skippedFresh: 0,
						skippedNotInstalled: 0,
						byStatus: {},
						snapshot,
					};
				}),
			},
			agents: { getCustomEnvVars: vi.fn().mockResolvedValue({}) },
			fs: { homeDir: vi.fn().mockResolvedValue(HOME) },
			agentError: { clearError: vi.fn().mockResolvedValue(undefined) },
		};
	}

	function renderModals(): void {
		const props = {
			theme: mockTheme,
			sessions: useSessionStore.getState().sessions,
			activeSession: null,
			groupChats: [],
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
			errorSession: null,
			effectiveAgentError: null,
			recoveryActions: [],
			onDismissAgentError: vi.fn(),
			groupChatError: null,
			groupChatRecoveryActions: [],
			onClearGroupChatError: vi.fn(),
			mergeSessionModalOpen: false,
			onCloseMergeSession: vi.fn(),
			onMerge: vi.fn(),
			transferState: 'idle',
			transferProgress: null,
			transferSourceAgent: null,
			transferTargetAgent: null,
			onCancelTransfer: vi.fn(),
			onCompleteTransfer: vi.fn(),
			sendToAgentModalOpen: false,
			onCloseSendToAgent: vi.fn(),
			onSendToAgent: vi.fn(),
		} as unknown as AppAgentModalsProps;

		render(
			<LayerStackProvider>
				<AppAgentModals {...props} />
			</LayerStackProvider>
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		seedStores();
		savedMaestro = (window as unknown as { maestro: unknown }).maestro;
		installBridge();
		processQueuedItem = vi.fn().mockResolvedValue(undefined);
		useAgentStore.setState({ processQueuedItem } as never);
		useSessionStore.setState({
			sessions: [
				makeSession('parser', { CLAUDE_CONFIG_DIR: GMAIL_DIR }, authError()),
				makeSession('docs', { CLAUDE_CONFIG_DIR: GMAIL_DIR }, authError()),
				makeSession('other', { CLAUDE_CONFIG_DIR: SMASH_DIR }, authError()),
			],
		} as never);
	});

	afterEach(() => {
		cleanup();
		(window as unknown as { maestro: unknown }).maestro = savedMaestro;
	});

	it('sends one prompt per blocked agent, in the order they failed, once the user confirms', async () => {
		// `docs` died first even though `parser` sits above it in the Left Bar.
		park('docs', 'write the release note', 2_000);
		park('parser', 'refactor the tokenizer', 5_000);
		park('other', 'not this account', 3_000);

		await act(async () => {
			await verifyAuthRecovery(GMAIL_KEY);
		});
		renderModals();

		// Everything that will be sent is named on screen before anything goes out.
		expect(screen.getByTestId('auth-resend-modal')).toBeInTheDocument();
		expect(screen.getAllByTestId('auth-resend-row')).toHaveLength(2);
		expect(screen.getByText('write the release note')).toBeInTheDocument();
		expect(screen.getByText('refactor the tokenizer')).toBeInTheDocument();
		expect(screen.queryByText('not this account')).not.toBeInTheDocument();
		expect(processQueuedItem).not.toHaveBeenCalled();

		await act(async () => {
			fireEvent.click(screen.getByTestId('auth-resend-confirm'));
		});

		expect(processQueuedItem.mock.calls.map((call) => call[0])).toEqual(['docs', 'parser']);
		expect(processQueuedItem).toHaveBeenCalledWith(
			'docs',
			expect.objectContaining({ id: 'docs-item' }),
			expect.anything()
		);
		expect(useModalStore.getState().isOpen('authResend')).toBe(false);
		// This credential's queue is answered (a second login must not replay it),
		// while the sibling account's prompt waits for ITS login.
		expect(Object.keys(useRetryStore.getState().blocked)).toEqual(['other:other-tab']);
	});

	it('sends nothing when the user declines, and forgets the queue', async () => {
		park('parser', 'refactor the tokenizer', 1_000);

		await act(async () => {
			await verifyAuthRecovery(GMAIL_KEY);
		});
		renderModals();

		await act(async () => {
			fireEvent.click(screen.getByTestId('auth-resend-decline'));
		});

		expect(processQueuedItem).not.toHaveBeenCalled();
		expect(useModalStore.getState().isOpen('authResend')).toBe(false);
		expect(useRetryStore.getState().blocked).toEqual({});
	});

	it('drops an agent deleted during the login instead of offering it, and still sends the rest', async () => {
		park('parser', 'refactor the tokenizer', 1_000);
		park('docs', 'write the release note', 2_000);

		await act(async () => {
			await verifyAuthRecovery(GMAIL_KEY);
		});

		// The user deleted `parser` while the browser had the login page open.
		useSessionStore.setState({
			sessions: useSessionStore.getState().sessions.filter((s) => s.id !== 'parser'),
		} as never);
		renderModals();

		expect(screen.getAllByTestId('auth-resend-row')).toHaveLength(1);
		expect(screen.queryByText('refactor the tokenizer')).not.toBeInTheDocument();

		await act(async () => {
			fireEvent.click(screen.getByTestId('auth-resend-confirm'));
		});

		expect(processQueuedItem.mock.calls.map((call) => call[0])).toEqual(['docs']);
	});
});
