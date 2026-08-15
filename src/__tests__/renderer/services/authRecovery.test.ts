/**
 * authRecovery - the payoff of the identity model.
 *
 * One login is repaired and EVERY agent presenting that credential stops
 * showing an error, while an agent on a sibling account (and an agent whose
 * error was never about auth) is left exactly as it was. Failure is the other
 * half of the contract: nothing is claimed, nothing is cleared, and the caller
 * keeps its evidence on screen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	clearAuthErrorsForIdentity,
	verifyAuthRecovery,
} from '../../../renderer/services/authRecovery';
import { useCenterFlashStore } from '../../../renderer/stores/centerFlashStore';
import { getModalActions, useModalStore } from '../../../renderer/stores/modalStore';
import { useProviderAuthStore } from '../../../renderer/stores/providerAuthStore';
import {
	noteAuthBlockedPrompt,
	noteDispatch,
	useRetryStore,
} from '../../../renderer/stores/retryStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { ProcessQueuedItemDeps } from '../../../renderer/stores/agentStore';
import type { CredentialIdentity, ProviderAuthSnapshot } from '../../../shared/providerAuth';
import type { AgentError, Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

const HOME = '/Users/x';
const GMAIL_DIR = `${HOME}/.claude-gmail`;
const GMAIL_KEY = `claude-code::oauth::${GMAIL_DIR}::local`;
const SMASH_DIR = `${HOME}/.claude-smash`;

const identity = (key: string, label: string): CredentialIdentity => ({
	key,
	provider: 'claude-code',
	kind: 'oauth',
	scope: key.split('::')[2],
	host: 'local',
	label,
});

const snapshotFor = (
	key: string,
	label: string,
	status: ProviderAuthSnapshot['status']
): ProviderAuthSnapshot => ({
	identity: identity(key, label),
	status,
	checkedAt: 1,
	source: 'probe',
});

const authError = (): AgentError => ({
	type: 'auth_expired',
	message: 'Invalid API key. Please run /login',
	recoverable: true,
	agentId: 'claude-code',
	timestamp: 1,
});

const rateLimitError = (): AgentError => ({
	type: 'rate_limited',
	message: 'Slow down',
	recoverable: true,
	agentId: 'claude-code',
	timestamp: 1,
});

/** An agent on `configDir`, optionally already wearing an error. */
function makeSession(id: string, configDir: string, error?: AgentError): Session {
	return createMockSession({
		id,
		name: id,
		customEnvVars: { CLAUDE_CONFIG_DIR: configDir },
		aiTabs: [createMockAITab({ id: `${id}-tab`, ...(error ? { agentError: error } : {}) })],
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

/**
 * Stub the bridge with a re-probe that writes `status` for the requested key,
 * exactly as the real one does through the change channel.
 */
function installBridge(status: ProviderAuthSnapshot['status'] | null): {
	reprobe: ReturnType<typeof vi.fn>;
	clearError: ReturnType<typeof vi.fn>;
} {
	const reprobe = vi.fn(async (key: string) => {
		const snapshot = status ? snapshotFor(key, '.claude-gmail', status) : null;
		if (snapshot) useProviderAuthStore.getState().applyChange(key, snapshot);
		return {
			identities: 1,
			probed: 1,
			skippedFresh: 0,
			skippedNotInstalled: 0,
			byStatus: {},
			snapshot,
		};
	});
	const clearError = vi.fn().mockResolvedValue(undefined);
	(window as unknown as { maestro: unknown }).maestro = {
		providerAuth: { getAll: vi.fn().mockResolvedValue({}), onChange: () => () => {}, reprobe },
		agents: { getCustomEnvVars: vi.fn().mockResolvedValue({}) },
		fs: { homeDir: vi.fn().mockResolvedValue(HOME) },
		agentError: { clearError },
	};
	return { reprobe, clearError };
}

const sessionById = (id: string): Session | undefined =>
	useSessionStore.getState().sessions.find((s) => s.id === id);

const dispatchDeps = {
	conductorProfile: '',
	customAICommands: [],
	speckitCommands: [],
	openspecCommands: [],
} as unknown as ProcessQueuedItemDeps;

/** Park the prompt an agent's auth failure killed, the way the error listener does. */
function parkPrompt(id: string): void {
	const tabId = `${id}-tab`;
	noteDispatch(
		id,
		{ id: `${id}-item`, timestamp: 1, tabId, type: 'message', text: 'ship it' },
		dispatchDeps
	);
	noteAuthBlockedPrompt(id, tabId);
}

describe('authRecovery', () => {
	beforeEach(() => {
		useProviderAuthStore.getState().__resetForTests();
		useProviderAuthStore.setState({ homeDir: HOME, loaded: true });
		useSessionStore.setState({ sessions: [] });
		useCenterFlashStore.getState().setActive(null);
		useModalStore.setState({ modals: new Map() });
		useRetryStore.setState({ retries: {}, outages: {}, blocked: {} });
	});

	it('offers back the prompts the dead login blocked', async () => {
		installBridge('authenticated');
		useSessionStore.setState({
			sessions: [
				makeSession('a', GMAIL_DIR, authError()),
				makeSession('b', GMAIL_DIR, authError()),
			],
		});
		parkPrompt('a');
		parkPrompt('b');

		await verifyAuthRecovery(GMAIL_KEY);

		// Offered, not sent: the modal asks before anything goes back out.
		expect(useModalStore.getState().isOpen('authResend')).toBe(true);
		expect(useModalStore.getState().getData('authResend')).toEqual({ identityKey: GMAIL_KEY });
	});

	it('asks nothing when the login blocked no prompt', async () => {
		installBridge('authenticated');
		useSessionStore.setState({ sessions: [makeSession('a', GMAIL_DIR, authError())] });

		await verifyAuthRecovery(GMAIL_KEY);

		expect(useModalStore.getState().isOpen('authResend')).toBe(false);
	});

	it('asks nothing when the login did not actually work', async () => {
		installBridge('logged-out');
		useSessionStore.setState({ sessions: [makeSession('a', GMAIL_DIR, authError())] });
		parkPrompt('a');

		await verifyAuthRecovery(GMAIL_KEY);

		expect(useModalStore.getState().isOpen('authResend')).toBe(false);
	});

	it('clears the auth error on EVERY agent on the identity and nobody else', async () => {
		installBridge('authenticated');
		useSessionStore.setState({
			sessions: [
				makeSession('a', GMAIL_DIR, authError()),
				makeSession('b', GMAIL_DIR, authError()),
				makeSession('c', SMASH_DIR, authError()),
				makeSession('d', GMAIL_DIR, rateLimitError()),
			],
		});

		const outcome = await verifyAuthRecovery(GMAIL_KEY);

		expect(outcome.status).toBe('authenticated');
		expect(outcome.clearedSessionIds).toEqual(['a', 'b']);
		for (const id of ['a', 'b']) {
			expect(sessionById(id)?.agentError).toBeUndefined();
			expect(sessionById(id)?.agentErrorPaused).toBe(false);
			expect(sessionById(id)?.state).toBe('idle');
			expect(sessionById(id)?.aiTabs[0].agentError).toBeUndefined();
		}
		// The sibling account was never signed in, and a rate limit is still true.
		expect(sessionById('c')?.agentError?.type).toBe('auth_expired');
		expect(sessionById('d')?.agentError?.type).toBe('rate_limited');
		expect(sessionById('d')?.state).toBe('error');
	});

	it('attributes the post-login probe to the login flow', async () => {
		const { reprobe } = installBridge('authenticated');
		useSessionStore.setState({ sessions: [makeSession('a', GMAIL_DIR, authError())] });

		await verifyAuthRecovery(GMAIL_KEY);

		expect(reprobe).toHaveBeenCalledWith(GMAIL_KEY, { source: 'login-flow' });
	});

	it('confirms with one green flash naming how many agents it unblocked', async () => {
		installBridge('authenticated');
		useSessionStore.setState({
			sessions: [
				makeSession('a', GMAIL_DIR, authError()),
				makeSession('b', GMAIL_DIR, authError()),
			],
		});

		await verifyAuthRecovery(GMAIL_KEY);

		const flash = useCenterFlashStore.getState().active;
		expect(flash?.color).toBe('green');
		expect(flash?.message).toContain('.claude-gmail');
		expect(flash?.detail).toBe('2 agents unblocked');
	});

	it('closes an agent error modal sitting on a repaired agent', async () => {
		installBridge('authenticated');
		useSessionStore.setState({ sessions: [makeSession('a', GMAIL_DIR, authError())] });
		getModalActions().setAgentErrorModalSessionId('a');

		await verifyAuthRecovery(GMAIL_KEY);

		expect(useModalStore.getState().isOpen('agentError')).toBe(false);
	});

	it('leaves the error modal alone when it belongs to another account', async () => {
		installBridge('authenticated');
		useSessionStore.setState({
			sessions: [
				makeSession('a', GMAIL_DIR, authError()),
				makeSession('c', SMASH_DIR, authError()),
			],
		});
		getModalActions().setAgentErrorModalSessionId('c');

		await verifyAuthRecovery(GMAIL_KEY);

		expect(useModalStore.getState().isOpen('agentError')).toBe(true);
	});

	it('changes nothing when the credential is still logged out', async () => {
		const { clearError } = installBridge('logged-out');
		useSessionStore.setState({ sessions: [makeSession('a', GMAIL_DIR, authError())] });

		const outcome = await verifyAuthRecovery(GMAIL_KEY);

		expect(outcome).toEqual({ status: 'logged-out', clearedSessionIds: [] });
		expect(sessionById('a')?.agentError?.type).toBe('auth_expired');
		expect(sessionById('a')?.state).toBe('error');
		expect(clearError).not.toHaveBeenCalled();
		expect(useCenterFlashStore.getState().active).toBeNull();
	});

	it('reports `unknown` rather than success when the probe cannot answer', async () => {
		installBridge(null);
		useSessionStore.setState({ sessions: [makeSession('a', GMAIL_DIR, authError())] });

		const outcome = await verifyAuthRecovery(GMAIL_KEY);

		expect(outcome.status).toBe('unknown');
		expect(sessionById('a')?.agentError?.type).toBe('auth_expired');
		expect(useCenterFlashStore.getState().active).toBeNull();
	});

	// The regression this guards: main's pass RESOLVES when it declines to probe
	// (the detector was not up, the CLI is not installed here, no session uses the
	// credential any more) and hands back whatever was already on record. That
	// record is normally the error-pattern mark that opened the modal, so reading
	// it as a verdict tells a user who just signed in that they are still signed
	// out - on the strength of a probe that never ran.
	it('reports `unknown` when the pass probed nothing, whatever is on record', async () => {
		installBridge('logged-out');
		const reprobe = vi.fn(async () => ({
			identities: 1,
			probed: 0,
			skippedFresh: 0,
			skippedNotInstalled: 1,
			byStatus: {},
			snapshot: snapshotFor(GMAIL_KEY, '.claude-gmail', 'logged-out'),
		}));
		(
			window as unknown as { maestro: { providerAuth: Record<string, unknown> } }
		).maestro.providerAuth.reprobe = reprobe;
		useSessionStore.setState({ sessions: [makeSession('a', GMAIL_DIR, authError())] });

		const outcome = await verifyAuthRecovery(GMAIL_KEY);

		expect(reprobe).toHaveBeenCalled();
		expect(outcome.status).toBe('unknown');
		// And it stays a non-event: nothing cleared, nothing flashed.
		expect(outcome.clearedSessionIds).toEqual([]);
		expect(useCenterFlashStore.getState().active).toBeNull();
	});

	it('reports `unknown` when there is no bridge at all', async () => {
		(window as unknown as { maestro: unknown }).maestro = undefined;
		useSessionStore.setState({ sessions: [makeSession('a', GMAIL_DIR, authError())] });

		expect(await verifyAuthRecovery(GMAIL_KEY)).toEqual({
			status: 'unknown',
			clearedSessionIds: [],
		});
	});

	it('clears an auth error on a tab the session-level frame does not point at', () => {
		installBridge('authenticated');
		const session = makeSession('a', GMAIL_DIR, authError());
		useSessionStore.setState({
			sessions: [
				{
					...session,
					aiTabs: [
						...session.aiTabs,
						createMockAITab({ id: 'a-tab-2', agentError: authError() }),
						createMockAITab({ id: 'a-tab-3', agentError: rateLimitError() }),
					],
				},
			],
		});

		expect(clearAuthErrorsForIdentity(GMAIL_KEY)).toEqual(['a']);

		const tabs = sessionById('a')!.aiTabs;
		expect(tabs.find((t) => t.id === 'a-tab')?.agentError).toBeUndefined();
		expect(tabs.find((t) => t.id === 'a-tab-2')?.agentError).toBeUndefined();
		expect(tabs.find((t) => t.id === 'a-tab-3')?.agentError?.type).toBe('rate_limited');
	});

	it('reports nothing cleared when no agent on the identity had an auth error', () => {
		installBridge('authenticated');
		useSessionStore.setState({ sessions: [makeSession('a', GMAIL_DIR)] });

		expect(clearAuthErrorsForIdentity(GMAIL_KEY)).toEqual([]);
	});
});
