/**
 * Covers the Local Models gateway on the `create_session` path in
 * useAppRemoteEventListeners - where `maestro-cli create-agent --gateway-url`
 * lands. The CLI checks the URL first; the renderer checks it again against the
 * provider, because a direct WebSocket caller skips the CLI. A refused gateway
 * refuses the create: dropping it would make an agent the caller did not ask for.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
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
	gitService: { isRepo: vi.fn().mockResolvedValue(false) },
}));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/browserTabPersistence', () => ({
	getBrowserTabPartition: () => 'persist:test',
}));

const respond = vi.fn();
const setMany = vi.fn().mockResolvedValue(undefined);

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

/** The agent the handler added, from the updater it handed setSessions. */
function createdSession(setSessions: ReturnType<typeof vi.fn>): Session {
	const updater = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
	return updater([])[0];
}

function dispatchCreate(toolType: string, config?: Record<string, unknown>, groupId?: string) {
	window.dispatchEvent(
		new CustomEvent('maestro:remoteCreateSession', {
			detail: {
				name: 'CLI Agent',
				toolType,
				cwd: '/tmp/project',
				groupId,
				config,
				responseChannel: 'ch',
				background: true,
			},
		})
	);
}

/** Let the handler's awaited lookups, persist and response settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		agents: { get: vi.fn(async (id: string) => ({ id })) },
		process: { sendRemoteCreateSessionResponse: respond },
		sessions: { setMany },
		stats: { recordSessionCreated: vi.fn() },
	};
});

describe('maestro:remoteCreateSession gateway', () => {
	it('stores the normalized gateway on the new agent, with no proxy mode', async () => {
		const { setSessions } = setup();

		dispatchCreate('claude-code', { gatewayUrl: 'http://127.0.0.1:8787/' });
		await flush();

		const session = createdSession(setSessions);
		expect(session.gatewayUrl).toBe('http://127.0.0.1:8787');
		expect(session.tokenProxyMode).toBeUndefined();
		expect(respond).toHaveBeenCalledWith('ch', {
			sessionId: session.id,
			seededFromGroup: null,
			skipped: [],
		});
	});

	it('creates the agent with no gateway when none was sent', async () => {
		const { setSessions } = setup();

		dispatchCreate('codex');
		await flush();

		expect(createdSession(setSessions).gatewayUrl).toBeUndefined();
	});

	it('refuses the create when the provider cannot use a gateway', async () => {
		const { setSessions } = setup();

		dispatchCreate('copilot-cli', { gatewayUrl: 'http://127.0.0.1:8787' });
		await flush();

		expect(setSessions).not.toHaveBeenCalled();
		expect(setMany).not.toHaveBeenCalled();
		expect(respond).toHaveBeenCalledWith('ch', null);
	});

	it('refuses the create when the gateway is not a string', async () => {
		const { setSessions } = setup();

		dispatchCreate('claude-code', { gatewayUrl: 8787 });
		await flush();

		expect(setSessions).not.toHaveBeenCalled();
		expect(respond).toHaveBeenCalledWith('ch', null);
	});
});

describe('maestro:remoteCreateSession Run on', () => {
	const OLLAMA = {
		id: 'ep-ollama',
		name: 'Ollama',
		kind: 'ollama',
		baseUrl: 'http://127.0.0.1:11434',
		enabled: true,
	};
	const QWEN = {
		type: 'source',
		endpointId: OLLAMA.id,
		model: 'qwen3:latest',
		contextTokens: 65_536,
	};

	beforeEach(() => {
		vi.mocked(useSettingsStore.getState).mockReturnValue({
			localModelEndpoints: [OLLAMA],
		} as never);
	});
	afterEach(() => {
		vi.mocked(useSettingsStore.getState).mockReturnValue({} as never);
	});

	it('stores the target on the new agent and flushes it to main', async () => {
		const { setSessions } = setup();

		dispatchCreate('claude-code', { runOn: QWEN });
		await flush();

		const session = createdSession(setSessions);
		expect(session.runOn).toEqual(QWEN);
		// The launch reads the target from main's store.
		expect(setMany).toHaveBeenCalledWith([expect.objectContaining({ runOn: QWEN })], []);
		expect(respond).toHaveBeenCalledWith('ch', {
			sessionId: session.id,
			seededFromGroup: null,
			skipped: [],
		});
	});

	it.each([[undefined], [{ type: 'provider' }]])(
		'creates the agent on its provider for %j: no target is stored',
		async (runOn) => {
			const { setSessions } = setup();

			dispatchCreate('claude-code', runOn ? { runOn } : undefined);
			await flush();

			expect(createdSession(setSessions)).not.toHaveProperty('runOn');
		}
	);

	it.each([
		['a provider with no recipe', 'gemini-cli', { runOn: QWEN }],
		[
			'a source id that names nothing',
			'claude-code',
			{ runOn: { ...QWEN, endpointId: 'ep-typo' } },
		],
		['a target with no model', 'claude-code', { runOn: { type: 'source', endpointId: OLLAMA.id } }],
		[
			'a context under the agent minimum',
			'claude-code',
			{ runOn: { ...QWEN, contextTokens: 8192 } },
		],
		['a target that is not an object', 'claude-code', { runOn: 'ep-ollama:qwen3' }],
		[
			'a gateway beside a source target',
			'claude-code',
			{ runOn: QWEN, gatewayUrl: 'http://127.0.0.1:8787' },
		],
	])('refuses the create for %s: no agent is made', async (_name, toolType, config) => {
		const { setSessions } = setup();

		dispatchCreate(toolType, config);
		await flush();

		expect(setSessions).not.toHaveBeenCalled();
		expect(setMany).not.toHaveBeenCalled();
		expect(respond).toHaveBeenCalledWith('ch', null);
	});
});

describe('maestro:remoteCreateSession group defaults', () => {
	const GROUP = {
		id: 'group-1',
		name: 'Work',
		emoji: '💼',
		collapsed: false,
		defaults: {
			toolType: 'claude-code',
			customModel: 'opus',
			nudgeMessage: 'Be brief.',
			customEnvVars: { CLAUDE_CONFIG_DIR: '~/.work', SHARED: 'group' },
			customEnvVarsDisabled: { DEBUG: '1' },
			systemOneOptOut: true,
			peerAgents: [{ agentId: 'peer-1', canConsult: true }],
		},
	};

	beforeEach(() => {
		vi.mocked(useSessionStore.getState).mockReturnValue({ groups: [GROUP], sessions: [] } as never);
	});
	afterEach(() => {
		vi.mocked(useSessionStore.getState).mockReturnValue({} as never);
	});

	it('starts the agent from the group, and reports the group', async () => {
		const { setSessions } = setup();

		dispatchCreate('claude-code', undefined, 'group-1');
		await flush();

		const session = createdSession(setSessions);
		expect(session).toMatchObject({
			groupId: 'group-1',
			customModel: 'opus',
			nudgeMessage: 'Be brief.',
			customEnvVars: { CLAUDE_CONFIG_DIR: '~/.work', SHARED: 'group' },
			customEnvVarsDisabled: { DEBUG: '1' },
			systemOneOptOut: true,
			peerAgents: [{ agentId: 'peer-1', canConsult: true }],
		});
		expect(respond).toHaveBeenCalledWith('ch', {
			sessionId: session.id,
			seededFromGroup: 'group-1',
			skipped: [],
		});
	});

	it('lets a flag beat the group, key by key for environment variables', async () => {
		const { setSessions } = setup();

		dispatchCreate(
			'claude-code',
			{ customModel: 'sonnet', customEnvVars: { SHARED: 'flag' } },
			'group-1'
		);
		await flush();

		const session = createdSession(setSessions);
		expect(session.customModel).toBe('sonnet');
		expect(session.customEnvVars).toEqual({ CLAUDE_CONFIG_DIR: '~/.work', SHARED: 'flag' });
		expect(session.nudgeMessage).toBe('Be brief.');
	});

	it('does not hand a provider-bound default to another provider', async () => {
		const { setSessions } = setup();

		dispatchCreate('codex', undefined, 'group-1');
		await flush();

		const session = createdSession(setSessions);
		expect(session).not.toHaveProperty('customModel');
		expect(session.nudgeMessage).toBe('Be brief.');
	});

	it('creates a bare agent in the group for seedFromGroup: false', async () => {
		const { setSessions } = setup();

		dispatchCreate('claude-code', { seedFromGroup: false }, 'group-1');
		await flush();

		const session = createdSession(setSessions);
		expect(session.groupId).toBe('group-1');
		expect(session).not.toHaveProperty('customModel');
		expect(session).not.toHaveProperty('peerAgents');
		expect(respond).toHaveBeenCalledWith('ch', {
			sessionId: session.id,
			seededFromGroup: null,
			skipped: [],
		});
	});

	it('seeds nothing from a group that holds no defaults', async () => {
		vi.mocked(useSessionStore.getState).mockReturnValue({
			groups: [{ ...GROUP, defaults: undefined }],
			sessions: [],
		} as never);
		const { setSessions } = setup();

		dispatchCreate('claude-code', undefined, 'group-1');
		await flush();

		expect(createdSession(setSessions)).not.toHaveProperty('customModel');
		expect(respond).toHaveBeenCalledWith('ch', expect.objectContaining({ seededFromGroup: null }));
	});
});

async function create(toolType: string, config: Record<string, unknown>): Promise<Session> {
	const { setSessions } = setup();
	dispatchCreate(toolType, config);
	await flush();
	expect(respond).toHaveBeenCalledWith(
		'ch',
		expect.objectContaining({ sessionId: expect.any(String) })
	);
	return createdSession(setSessions);
}

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

		respond.mockClear();
		const defaults = await create('codex', {
			codexAutoResetOnExhaustion: false,
			codexTransport: 'exec',
		});
		expect('codexAutoResetOnExhaustion' in defaults).toBe(false);
		expect('codexTransport' in defaults).toBe(false);
	});
});
