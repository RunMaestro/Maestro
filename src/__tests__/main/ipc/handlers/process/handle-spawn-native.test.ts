import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	cancelPendingDesktopSpawns,
	handleProcessSpawn,
	type SpawnHandlerDependencies,
} from '../../../../../main/ipc/handlers/process/handle-spawn';
import {
	beginGlobalWorktreeActivity,
	reserveWorktreeCleanup,
} from '../../../../../main/git/worktreeActivity';
import { acquireProviderSessionWriter } from '../../../../../main/utils/provider-session-writer';
import type { SpawnProcessConfig } from '../../../../../main/ipc/handlers/process/spawn-types';
import type { ProcessConfig } from '../../../../../main/process-manager/types';
import { getAgentCapabilities } from '../../../../../shared/maestro-lib/providers/capabilities';
import { getAgentDefinition } from '../../../../../shared/maestro-lib/providers/definitions';
import type { ToolType } from '../../../../../shared/types';
import type * as ProviderSessionWriter from '../../../../../main/utils/provider-session-writer';
import { resolveConfigDirKey } from '../../../../../main/stores/claudeUsageStore';

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }));
vi.mock('../../../../../main/utils/provider-session-writer', async (importOriginal) => {
	const actual = await importOriginal<typeof ProviderSessionWriter>();
	return {
		...actual,
		acquireProviderSessionWriter: vi.fn(async () => () => {}),
	};
});
async function spawnNativeWithResult(
	toolType: ToolType,
	overrides: Partial<SpawnProcessConfig> = {},
	agentConfigValues: Record<string, unknown> = {},
	options: {
		nativeCapabilities?: Record<string, unknown> | null;
		opencodeServer?: boolean;
		shellEnvVars?: Record<string, string>;
		prepare?: (deps: SpawnHandlerDependencies) => void;
	} = {}
) {
	const definition = getAgentDefinition(toolType)!;
	const detected = {
		...definition,
		available: true,
		path: `/usr/local/bin/${definition.binaryName}`,
		capabilities: getAgentCapabilities(toolType),
	};
	const processManager = {
		spawn: vi.fn((_config: ProcessConfig) => ({ success: true, pid: 4242 })),
		get: vi.fn(),
		getAll: vi.fn(() => []),
		on: vi.fn(),
		off: vi.fn(),
		getHarnessControlCapabilities: vi.fn(() =>
			options.nativeCapabilities === undefined ? { protocol: 'test' } : options.nativeCapabilities
		),
	};
	const safeSend = vi.fn();
	const webContentsSend = vi.fn();
	let sessions: Array<Record<string, unknown>> = [];
	const sessionsStore = {
		get: (key: string, fallback: unknown) => (key === 'sessions' ? sessions : fallback),
		set: (key: string, value: unknown) => {
			if (key === 'sessions') sessions = value as Array<Record<string, unknown>>;
		},
	};
	const config = {
		sessionId: 'agent-1-ai-tab-1',
		toolType,
		cwd: '/tmp/project',
		command: definition.command,
		args: [],
		prompt: 'Review this change',
		tabId: 'tab-1',
		harnessControlMode: 'native',
		permissionMode: 'standard',
		...overrides,
	} as SpawnProcessConfig;
	const deps: SpawnHandlerDependencies = {
		getProcessManager: () => processManager as never,
		getAgentDetector: () => ({ getAgent: async () => detected }) as never,
		agentConfigsStore: {
			get: (key: string, fallback: unknown) =>
				key === 'configs' ? { [toolType]: agentConfigValues } : fallback,
		} as never,
		settingsStore: {
			get: (key: string, fallback: unknown) => {
				if (key === 'encoreFeatures') return { opencodeServer: options.opencodeServer === true };
				if (key === 'shellEnvVars') return options.shellEnvVars ?? fallback;
				return fallback;
			},
		} as never,
		getMainWindow: () =>
			({
				isDestroyed: () => false,
				webContents: { isDestroyed: () => false, send: webContentsSend },
			}) as never,
		safeSend,
		sessionsStore: sessionsStore as never,
	};
	options.prepare?.(deps);
	const result = await handleProcessSpawn(config, deps);
	return {
		config: processManager.spawn.mock.calls[0]?.[0] as ProcessConfig | undefined,
		result,
		processManager,
		safeSend,
		webContentsSend,
	};
}

async function spawnNative(
	toolType: ToolType,
	overrides: Partial<SpawnProcessConfig> = {},
	agentConfigValues: Record<string, unknown> = {}
): Promise<ProcessConfig> {
	const attempt = await spawnNativeWithResult(toolType, overrides, agentConfigValues);
	expect(attempt.result.success).toBe(true);
	expect(attempt.processManager.spawn).toHaveBeenCalledOnce();
	return attempt.config!;
}

describe('native spawn configuration', () => {
	it('passes effective model and effort with session-over-agent precedence', async () => {
		const session = await spawnNative(
			'copilot-cli',
			{ sessionCustomModel: 'session-model', sessionCustomEffort: 'max' },
			{ model: 'agent-model', effort: 'high' }
		);
		expect(session).toMatchObject({ modelId: 'session-model', effort: 'max' });

		const agent = await spawnNative(
			'copilot-cli',
			{},
			{ model: 'agent-model', reasoningEffort: 'high' }
		);
		expect(agent).toMatchObject({ modelId: 'agent-model', effort: 'high' });
	});

	it('maps the legacy read-only flag onto native ACP permission and arguments', async () => {
		const spawned = await spawnNative('qwen3-coder', {
			permissionMode: undefined,
			readOnlyMode: true,
		});
		expect(spawned.permissionMode).toBe('readonly');
		expect(spawned.nativeAcpArgs).toEqual(
			expect.arrayContaining(['--acp', '--approval-mode', 'plan'])
		);
		expect(spawned.nativeAcpArgs).not.toContain('-y');
	});

	it('maps the legacy read-only flag onto native RPC permission configuration', async () => {
		const spawned = await spawnNative('omp', {
			permissionMode: undefined,
			readOnlyMode: true,
		});
		expect(spawned.permissionMode).toBe('readonly');
		expect(spawned.nativeRpcArgs).toEqual(expect.arrayContaining(['--mode', 'rpc-ui']));
	});

	it('refuses Standard mode on current transports without an approval channel', async () => {
		const attempt = await spawnNativeWithResult('qwen3-coder', {
			harnessControlMode: 'current',
			permissionMode: 'standard',
		});
		expect(attempt.result.success).toBe(false);
		expect(attempt.processManager.spawn).not.toHaveBeenCalled();
	});

	it('allows Standard mode when Codex app-server provides approvals', async () => {
		const spawned = await spawnNative('codex', {
			harnessControlMode: 'current',
			permissionMode: 'standard',
			codexTransport: 'app-server',
		});
		expect(spawned.harnessControlMode).toBe('current');

		const imageTurn = await spawnNativeWithResult('codex', {
			harnessControlMode: 'current',
			permissionMode: 'standard',
			codexTransport: 'app-server',
			images: ['image.png'],
		});
		expect(imageTurn.result.success).toBe(false);
		expect(imageTurn.processManager.spawn).not.toHaveBeenCalled();
	});

	it('allows OpenCode Standard only when the server route carries the turn', async () => {
		const server = await spawnNativeWithResult(
			'opencode',
			{ harnessControlMode: 'current', permissionMode: 'standard' },
			{},
			{ opencodeServer: true }
		);
		expect(server.webContentsSend.mock.calls).toEqual([]);
		expect(server.result.success).toBe(true);
		expect(server.config?.harnessControlMode).toBe('current');

		const imageTurn = await spawnNativeWithResult(
			'opencode',
			{ harnessControlMode: 'current', permissionMode: 'standard', images: ['image.png'] },
			{},
			{ opencodeServer: true }
		);
		expect(imageTurn.result.success).toBe(false);
		expect(imageTurn.processManager.spawn).not.toHaveBeenCalled();
	});

	it('publishes API mode only after native Claude control is registered', async () => {
		const native = await spawnNativeWithResult(
			'claude-code',
			{},
			{},
			{
				shellEnvVars: { CLAUDE_CONFIG_DIR: '/accounts/work' },
			}
		);
		expect(native.result.success).toBe(true);
		expect(native.safeSend).toHaveBeenCalledWith(
			'process:claude-mode-resolved',
			'agent-1-ai-tab-1',
			{
				mode: 'api',
				reason: 'auto',
				configDirKey: resolveConfigDirKey({ CLAUDE_CONFIG_DIR: '/accounts/work' }),
			}
		);

		const fallback = await spawnNativeWithResult(
			'claude-code',
			{},
			{},
			{ nativeCapabilities: null }
		);
		expect(fallback.result.success).toBe(true);
		expect(fallback.safeSend).not.toHaveBeenCalledWith(
			'process:claude-mode-resolved',
			'agent-1-ai-tab-1',
			expect.objectContaining({ mode: 'api' })
		);
	});
});

describe('outer spawn orchestration activity', () => {
	const target = process.cwd();
	const releases: Array<() => void> = [];

	beforeEach(() => {
		vi.mocked(acquireProviderSessionWriter).mockClear();
	});
	afterEach(() => {
		for (const release of releases.splice(0)) release();
		vi.restoreAllMocks();
	});

	async function reserve(root = target) {
		const hold = await reserveWorktreeCleanup(root);
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Reservation failed');
		releases.push(hold.release);
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		return hold;
	}

	async function blocked() {
		const hold = await reserveWorktreeCleanup(target);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		expect(hold).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
	}

	it.each([target, path.join(target, 'src'), path.dirname(target)])(
		'refuses before manager/session/writer setup for reservation %s',
		async (root) => {
			const hold = await reserve(root);
			const manager = vi.fn();
			const records = vi.fn();
			const detector = vi.fn();
			const realpath = vi.spyOn(fs, 'realpath');
			await expect(
				spawnNativeWithResult(
					'codex',
					{
						cwd: '~/remote-only',
						sessionSshRemoteConfig: { enabled: true, remoteId: 'remote' },
					},
					{},
					{
						prepare(deps) {
							deps.getProcessManager = manager;
							deps.getAgentDetector = detector;
							deps.sessionsStore.get = records;
						},
					}
				)
			).rejects.toThrow('reserved');
			expect(manager).not.toHaveBeenCalled();
			expect(records).not.toHaveBeenCalled();
			expect(detector).not.toHaveBeenCalled();
			expect(acquireProviderSessionWriter).not.toHaveBeenCalled();
			expect(realpath).not.toHaveBeenCalled();
			expect(cancelPendingDesktopSpawns('agent-1-ai-tab-1')).toBe(false);
			hold.release();
			await reserve();
		}
	);

	it.each(['manager', 'sessions'] as const)(
		'releases a synchronous %s setup failure',
		async (site) => {
			const failure = Error(`${site} failed`);
			await expect(
				spawnNativeWithResult(
					'codex',
					{},
					{},
					{
						prepare(deps) {
							const fail = () => {
								throw failure;
							};
							if (site === 'manager') deps.getProcessManager = fail;
							else deps.sessionsStore.get = fail;
						},
					}
				)
			).rejects.toBe(failure);
			expect(acquireProviderSessionWriter).not.toHaveBeenCalled();
			expect(cancelPendingDesktopSpawns('agent-1-ai-tab-1')).toBe(false);
			await reserve();
		}
	);

	it('holds pending writer setup after cancellation until acquisition settles', async () => {
		let finish!: (release: () => void) => void;
		vi.mocked(acquireProviderSessionWriter).mockImplementationOnce(
			() =>
				new Promise((r) => {
					finish = r;
				})
		);
		const pending = spawnNativeWithResult('codex');
		await blocked();
		expect(cancelPendingDesktopSpawns('agent-1-ai-tab-1')).toBe(true);
		expect(vi.mocked(acquireProviderSessionWriter).mock.calls[0][3]?.aborted).toBe(true);
		await blocked();
		const releaseWriter = vi.fn();
		finish(releaseWriter);
		await expect(pending).rejects.toThrow('cancelled');
		expect(releaseWriter).toHaveBeenCalledOnce();
		expect(cancelPendingDesktopSpawns('agent-1-ai-tab-1')).toBe(false);
		await reserve();
	});

	it('retains each concurrent writer wait until that operation settles', async () => {
		let failFirst!: (error: Error) => void;
		let failSecond!: (error: Error) => void;
		vi.mocked(acquireProviderSessionWriter)
			.mockImplementationOnce(
				() =>
					new Promise((_r, reject) => {
						failFirst = reject;
					})
			)
			.mockImplementationOnce(
				() =>
					new Promise((_r, reject) => {
						failSecond = reject;
					})
			);
		const first = spawnNativeWithResult('codex', { sessionId: 'first-ai-tab' });
		const second = spawnNativeWithResult('codex', { sessionId: 'second-ai-tab' });
		await blocked();
		failFirst(Error('first writer failed'));
		await expect(first).rejects.toThrow('first writer failed');
		await blocked();
		failSecond(Error('second writer failed'));
		await expect(second).rejects.toThrow('second writer failed');
		await reserve();
	});

	it('holds cancelled detection through its unresolved setup, then releases before dispatch', async () => {
		let finish!: (agent: null) => void;
		const detection = new Promise<null>((r) => {
			finish = r;
		});
		const getAgent = vi.fn(() => detection);
		const pending = spawnNativeWithResult(
			'codex',
			{},
			{},
			{
				prepare(deps) {
					deps.getAgentDetector = () => ({ getAgent }) as never;
				},
			}
		);
		await vi.waitFor(() => expect(getAgent).toHaveBeenCalledOnce());
		expect(cancelPendingDesktopSpawns('agent-1-ai-tab-1')).toBe(true);
		await blocked();
		finish(null);
		await expect(pending).rejects.toThrow();
		expect(cancelPendingDesktopSpawns('agent-1-ai-tab-1')).toBe(false);
		await reserve();
	});

	it.each([false, true])(
		'composes native activity through reporting failure=%s',
		async (failReporting) => {
			let releaseNative!: () => void;
			const checks: Array<Promise<void>> = [];
			const pending = spawnNativeWithResult(
				'copilot-cli',
				{},
				{},
				{
					prepare(deps) {
						const manager = deps.getProcessManager()!;
						vi.mocked(manager.spawn).mockImplementationOnce(() => {
							releaseNative = beginGlobalWorktreeActivity();
							releases.push(releaseNative);
							checks.push(blocked());
							return { success: true, pid: 4242 };
						});
						const send = deps.safeSend!;
						deps.safeSend = (channel, ...args) => {
							if (channel === 'process:ssh-remote') {
								checks.push(blocked());
								if (failReporting) throw Error('reporting failed');
							}
							send(channel, ...args);
						};
					},
				}
			);
			if (failReporting) await expect(pending).rejects.toThrow('reporting failed');
			else expect((await pending).result.success).toBe(true);
			expect(checks).toHaveLength(2);
			await Promise.all(checks);
			await blocked();
			releaseNative();
			await reserve();
		}
	);

	it('releases after reentrant native completion and final reporting settle', async () => {
		const reporting = vi.fn();
		const result = await spawnNativeWithResult(
			'copilot-cli',
			{},
			{},
			{
				prepare(deps) {
					vi.mocked(deps.getProcessManager()!.spawn).mockImplementationOnce(() => {
						beginGlobalWorktreeActivity()();
						return { success: true, pid: 4242 };
					});
					const send = deps.safeSend!;
					deps.safeSend = (channel, ...args) => {
						if (channel === 'process:ssh-remote') reporting();
						send(channel, ...args);
					};
				},
			}
		);
		expect(result.result.success).toBe(true);
		expect(reporting).toHaveBeenCalledOnce();
		await reserve();
	});

	it('releases an early permission refusal without dispatch', async () => {
		const result = await spawnNativeWithResult('codex', { images: ['image.png'] });
		expect(result.result.success).toBe(false);
		expect(result.processManager.spawn).not.toHaveBeenCalled();
		await reserve();
	});

	it('wins admission against an earlier reservation still resolving its target', async () => {
		let finish!: (root: string) => void;
		vi.spyOn(fs, 'realpath').mockImplementationOnce(
			() =>
				new Promise((r) => {
					finish = r;
				})
		);
		const reserving = reserveWorktreeCleanup(target);
		let fail!: (error: Error) => void;
		vi.mocked(acquireProviderSessionWriter).mockImplementationOnce(
			() =>
				new Promise((_r, reject) => {
					fail = reject;
				})
		);
		const pending = spawnNativeWithResult('codex');
		finish(target);
		expect(await reserving).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
		fail(Error('writer failed'));
		await expect(pending).rejects.toThrow('writer failed');
		await reserve();
	});
});
