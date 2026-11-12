/**
 * Covers `maestro:remoteCreateSession` in useAppRemoteEventListeners - the
 * renderer side of `maestro-cli create-agent` and `duplicate-agent`.
 *
 * `duplicate-agent` sends the New Agent modal's remaining fields through this
 * one create path; they must land on the agent the way createNewSession()
 * stores them, or a scripted copy differs from a Duplicate... copy. Both paths
 * build through `buildNewAgentSession()`.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { buildNewAgentSession } from '../../../../renderer/utils/newAgentSession';
import { gitService } from '../../../../renderer/services/git';
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

	it('builds the agent the shared builder builds from the same draft', async () => {
		const ssh = { enabled: true, remoteId: 'remote-1', workingDirOverride: '/srv/p' };
		const agent = await create('codex', {
			nudgeMessage: 'Be terse',
			customEnvVars: { DEBUG: '1' },
			customEffort: 'high',
			sessionSshRemoteConfig: ssh,
			enableMaestroP: false,
			retryOnTokenExhaustion: false,
			codexTransport: 'app-server',
		});

		const expected = buildNewAgentSession(
			{
				agentId: 'codex',
				workingDir: '/p',
				name: 'Copy',
				nudgeMessage: 'Be terse',
				customEnvVars: { DEBUG: '1' },
				customEffort: 'high',
				sessionSshRemoteConfig: ssh,
				enableMaestroP: false,
				retryOnTokenExhaustion: false,
				codexTransport: 'app-server',
			},
			{ id: 'new-id', git: { isGitRepo: false } }
		);
		// The creation time and the port are fresh on each build.
		const timeless = (session: Session) => ({
			...session,
			createdAt: 0,
			port: 0,
			shellLogs: session.shellLogs.map((log) => ({ ...log, timestamp: 0 })),
			aiTabs: session.aiTabs.map((tab) => ({ ...tab, createdAt: 0 })),
		});
		expect(timeless(agent)).toStrictEqual(timeless(expected));
	});

	it('treats a blank string and a zero context window as unset', async () => {
		const agent = await create('claude-code', {
			nudgeMessage: '',
			newSessionMessage: '',
			customModel: '',
			customEffort: '',
			customContextWindow: 0,
			maestroPPath: '',
		});

		for (const field of [
			'nudgeMessage',
			'newSessionMessage',
			'customModel',
			'customEffort',
			'customContextWindow',
			'maestroPPath',
		]) {
			expect(field in agent, field).toBe(false);
		}
	});

	it('keeps the fields only a script sets on top of the shared build', async () => {
		const scripted = await create('claude-code', {
			customContextWindow: 64000,
			contextWindowSource: 'user-edited',
			autoRunFolderPath: '/runs/docs',
		});
		expect(scripted).toMatchObject({
			customContextWindow: 64000,
			contextWindowSource: 'user-edited',
			autoRunFolderPath: '/runs/docs',
		});

		ack.mockClear();
		const plain = await create('claude-code', {});
		expect('contextWindowSource' in plain).toBe(false);
		expect(plain.autoRunFolderPath).toBe('/p/.maestro/playbooks');
	});

	it('probes git only for a local agent', async () => {
		await create('claude-code', {
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		expect(gitService.isRepo).not.toHaveBeenCalled();

		ack.mockClear();
		await create('claude-code', {});
		expect(gitService.isRepo).toHaveBeenCalledWith('/p');
	});
});
