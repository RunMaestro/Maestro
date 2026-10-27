/**
 * Covers `maestro:remoteCreateSession` in useAppRemoteEventListeners - the
 * renderer side of `maestro-cli create-agent` and `duplicate-agent`.
 *
 * `duplicate-agent` sends the New Agent modal's remaining fields through this
 * one create path; they must land on the agent the way createNewSession()
 * stores them, or a scripted copy differs from a Duplicate... copy.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import type { Session } from '../../../../renderer/types';

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
	selectSessionById: vi.fn(),
}));
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
}));
vi.mock('../../../../renderer/hooks/batch/batchUtils', () => ({ DEFAULT_BATCH_PROMPT: '' }));
vi.mock('../../../../renderer/services/git', () => ({
	gitService: { isRepo: vi.fn(async () => false) },
}));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/browserTabPersistence', () => ({
	getBrowserTabPartition: () => 'persist:test',
}));
vi.mock('../../../../renderer/utils/ids', () => ({ generateId: () => 'new-id' }));

const ack = vi.fn();

function setup() {
	const setSessions = vi.fn();
	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef: { current: [] },
			setActiveSessionId: vi.fn(),
			setSessions,
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);
	return { setSessions };
}

async function create(toolType: string, config: Record<string, unknown>): Promise<Session> {
	const { setSessions } = setup();
	window.dispatchEvent(
		new CustomEvent('maestro:remoteCreateSession', {
			detail: {
				name: 'Copy',
				toolType,
				cwd: '/p',
				config,
				responseChannel: 'ch',
				background: true,
			},
		})
	);
	await waitFor(() => expect(ack).toHaveBeenCalledWith('ch', { sessionId: 'new-id' }));
	const updater = (setSessions as Mock).mock.calls[0][0] as (prev: Session[]) => Session[];
	return updater([])[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		agents: { get: vi.fn(async (id: string) => ({ id })) },
		stats: { recordSessionCreated: vi.fn() },
		sessions: { setMany: vi.fn(async () => undefined) },
		process: { sendRemoteCreateSessionResponse: ack },
	};
});

describe('maestro:remoteCreateSession', () => {
	it('stores the duplicate fields and stamps the fresh Claude mode', async () => {
		const agent = await create('claude-code', {
			additionalDirectories: [{ path: '/shared', read: true, write: false }],
			enableMaestroP: true,
			maestroPMode: 'interactive',
			maestroPPath: '/opt/maestro-p',
			retryOnAvailabilityErrors: false,
			retryOnTokenExhaustion: true,
		});

		expect(agent).toMatchObject({
			additionalDirectories: [{ path: '/shared', read: true, write: false }],
			enableMaestroP: true,
			maestroPMode: 'interactive',
			maestroPPath: '/opt/maestro-p',
			retryOnAvailabilityErrors: false,
			retryOnTokenExhaustion: true,
			claudeInteractive: { mode: 'api', modeReason: 'auto' },
		});
	});

	it('keeps an explicit Adaptive Mode off and drops its refinements', async () => {
		const agent = await create('claude-code', {
			enableMaestroP: false,
			maestroPMode: 'interactive',
			maestroPPath: '/opt/maestro-p',
		});

		expect(agent.enableMaestroP).toBe(false);
		expect(agent.maestroPMode).toBeUndefined();
		expect(agent.maestroPPath).toBeUndefined();
	});

	it('stores only the Codex opt-ins, like createNewSession()', async () => {
		const optedIn = await create('codex', {
			codexAutoResetOnExhaustion: true,
			codexTransport: 'app-server',
		});
		expect(optedIn).toMatchObject({
			codexAutoResetOnExhaustion: true,
			codexTransport: 'app-server',
		});
		expect(optedIn.claudeInteractive).toBeUndefined();

		ack.mockClear();
		const defaults = await create('codex', {
			codexAutoResetOnExhaustion: false,
			codexTransport: 'exec',
		});
		expect('codexAutoResetOnExhaustion' in defaults).toBe(false);
		expect('codexTransport' in defaults).toBe(false);
	});
});
