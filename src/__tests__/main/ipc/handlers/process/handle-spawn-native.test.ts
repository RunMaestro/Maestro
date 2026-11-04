import { pianolaNewTabSpawns } from '../../../../../main/pianola/pianola-new-tab-dispatch';
import { generateUUID } from '../../../../../shared/uuid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { hostCallerRuns } from '../../../../../main/agent-run/caller-identity';
import { CALLER_RUN_PROOF_FILE_ENV_VAR } from '../../../../../shared/agentDelegation';
import {
	handleProcessSpawn,
	cancelPendingDesktopSpawns,
} from '../../../../../main/ipc/handlers/process/handle-spawn';
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
		storedAgent?: boolean;
		spawnError?: boolean;
		spawnRefused?: boolean;
		cancelPreflight?: boolean;
	} = {}
) {
	const definition = getAgentDefinition(toolType)!;
	const detected = {
		...definition,
		available: true,
		path: `/usr/local/bin/${definition.binaryName}`,
		capabilities: getAgentCapabilities(toolType),
	};
	const events = new EventEmitter();
	const processRecord = { pid: 4242 };
	const processManager = {
		spawn: vi.fn(() => {
			if (options.spawnError) throw new Error('Fixture spawn failed');
			if (options.spawnRefused) return { success: false, pid: -1 };
			return { success: true, pid: 4242 };
		}),
		get: vi.fn(() => (options.storedAgent ? processRecord : undefined)),
		getAll: vi.fn(() => []),
		on: vi.fn(events.on.bind(events)),
		off: vi.fn(events.off.bind(events)),
		getHarnessControlCapabilities: vi.fn(() =>
			options.nativeCapabilities === undefined ? { protocol: 'test' } : options.nativeCapabilities
		),
	};
	const safeSend = vi.fn();
	const webContentsSend = vi.fn();
	let sessions: Array<Record<string, unknown>> = options.storedAgent
		? [
				{
					id: 'agent-1',
					toolType,
					codexTransport: 'app-server',
					harnessControlMode: 'current',
					aiTabs: [{ id: 'tab-1' }],
				},
			]
		: [];
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
	const result = await handleProcessSpawn(config, {
		getProcessManager: () => processManager as never,
		getAgentDetector: () =>
			({
				getAgent: async () => {
					if (options.cancelPreflight) cancelPendingDesktopSpawns(config.sessionId);
					return detected;
				},
			}) as never,
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
		sessionsStore,
	});
	return {
		config: processManager.spawn.mock.calls[0]?.[0] as ProcessConfig | undefined,
		result,
		processManager,
		safeSend,
		webContentsSend,
		events,
	};
}

afterEach(() => vi.restoreAllMocks());

describe('host caller identity spawn wiring with plugins off', () => {
	it('issues before spawn, pins the actual process and disposes only at its own exit', async () => {
		const dispose = vi.fn();
		const issue = vi.spyOn(hostCallerRuns, 'issue').mockImplementation((_binding, authority) => ({
			runTokenFile: '/private/fixture-proof',
			signal: authority.signal,
			assertActive: authority.assertActive,
			dispose,
		}));
		const attempt = await spawnNativeWithResult('codex', {}, {}, { storedAgent: true });
		expect(issue).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: 'agent-1',
				tabId: 'tab-1',
				spawnGeneration: expect.any(String),
			}),
			expect.objectContaining({ signal: expect.any(AbortSignal), unattended: true }),
			process.cwd()
		);
		expect(attempt.config?.customEnvVars?.[CALLER_RUN_PROOF_FILE_ENV_VAR]).toBe(
			'/private/fixture-proof'
		);
		expect(issue.mock.invocationCallOrder[0]).toBeLessThan(
			attempt.processManager.spawn.mock.invocationCallOrder[0]
		);
		const authority = issue.mock.calls[0][1];
		expect(() => authority.assertActive()).not.toThrow();
		attempt.events.emit('exit', 'another-agent-ai-tab');
		expect(dispose).not.toHaveBeenCalled();
		attempt.processManager.get.mockReturnValue({ pid: 9000 });
		expect(() => authority.assertActive()).toThrow('CallerRunUnavailable');
		attempt.events.emit('exit', 'agent-1-ai-tab-1');
		expect(dispose).toHaveBeenCalledOnce();
	});

	it('disposes the issued proof when spawning fails', async () => {
		const dispose = vi.fn();
		vi.spyOn(hostCallerRuns, 'issue').mockImplementation((_binding, authority) => ({
			runTokenFile: '/private/fixture-proof',
			signal: authority.signal,
			assertActive: authority.assertActive,
			dispose,
		}));
		await expect(
			spawnNativeWithResult('codex', {}, {}, { storedAgent: true, spawnError: true })
		).rejects.toThrow('Fixture spawn failed');
		expect(dispose).toHaveBeenCalledOnce();
	});

	it('does not issue for a claimed tab that differs from the actual spawn key', async () => {
		const issue = vi.spyOn(hostCallerRuns, 'issue');
		const attempt = await spawnNativeWithResult(
			'codex',
			{ tabId: 'forged-tab' },
			{},
			{ storedAgent: true }
		);
		expect(issue).not.toHaveBeenCalled();
		expect(attempt.config?.customEnvVars?.[CALLER_RUN_PROOF_FILE_ENV_VAR]).toBe('');
	});
});

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
	it('requires the exact existing-tab dispatch marker at native spawn', async () => {
		const tabId = generateUUID();
		const dispatchId = generateUUID();
		pianolaNewTabSpawns.hold('worker', tabId);
		const started = vi.fn();
		pianolaNewTabSpawns.arm('worker', tabId, () => {}, started, dispatchId);
		await expect(
			spawnNativeWithResult('copilot-cli', { sessionId: `worker-ai-${tabId}` })
		).rejects.toThrow('DispatchIdentityMismatch');
		await spawnNativeWithResult('copilot-cli', {
			sessionId: `worker-ai-${tabId}`,
			pianolaDispatchId: dispatchId,
		});
		expect(started).toHaveBeenCalledOnce();
	});

	it('blocks an unadmitted new tab before any spawn preflight', async () => {
		const tabId = generateUUID();
		pianolaNewTabSpawns.hold('worker', tabId);
		await expect(
			spawnNativeWithResult('copilot-cli', { sessionId: `worker-ai-${tabId}` })
		).rejects.toThrow('DispatchAdmissionPending');
	});
	it('rechecks the admission after asynchronous spawn preflight', async () => {
		const tabId = generateUUID();
		pianolaNewTabSpawns.hold('worker', tabId);
		const guard = vi
			.fn()
			.mockImplementationOnce(() => {})
			.mockImplementation(() => {
				throw new Error('PausedDuringSpawn');
			});
		const started = vi.fn();
		pianolaNewTabSpawns.arm('worker', tabId, guard, started);
		await expect(
			spawnNativeWithResult('copilot-cli', { sessionId: `worker-ai-${tabId}` })
		).rejects.toThrow('PausedDuringSpawn');
		expect(guard).toHaveBeenCalledTimes(2);
		expect(started).not.toHaveBeenCalled();
	});

	it('releases a conclusively refused preflight so a later normal send can use the tab', async () => {
		const tabId = generateUUID();
		const sessionId = `worker-ai-${tabId}`;
		pianolaNewTabSpawns.hold('worker', tabId);
		pianolaNewTabSpawns.arm('worker', tabId, () => {}, vi.fn());
		const refused = await spawnNativeWithResult('qwen3-coder', {
			sessionId,
			harnessControlMode: 'current',
			permissionMode: 'standard',
		});
		expect(refused.result.success).toBe(false);
		expect(refused.processManager.spawn).not.toHaveBeenCalled();
		expect(pianolaNewTabSpawns.isHeld('worker', tabId)).toBe(false);
		const later = await spawnNativeWithResult('copilot-cli', { sessionId });
		expect(later.result.success).toBe(true);
		expect(later.processManager.spawn).toHaveBeenCalledOnce();
	});

	it('releases after a failed final preflight but preserves uncertainty once native spawn is entered', async () => {
		const tabId = generateUUID();
		const sessionId = `worker-ai-${tabId}`;
		pianolaNewTabSpawns.hold('worker', tabId);
		pianolaNewTabSpawns.arm(
			'worker',
			tabId,
			vi
				.fn()
				.mockImplementationOnce(() => {})
				.mockImplementation(() => {
					throw new Error('Paused');
				}),
			vi.fn()
		);
		await expect(spawnNativeWithResult('copilot-cli', { sessionId })).rejects.toThrow('Paused');
		expect(pianolaNewTabSpawns.isHeld('worker', tabId)).toBe(false);
		pianolaNewTabSpawns.hold('worker', tabId);
		const started = vi.fn();
		pianolaNewTabSpawns.arm('worker', tabId, () => {}, started);
		await expect(
			spawnNativeWithResult('copilot-cli', { sessionId }, {}, { spawnError: true })
		).rejects.toThrow('Fixture spawn failed');
		expect(pianolaNewTabSpawns.isHeld('worker', tabId)).toBe(true);
		await expect(spawnNativeWithResult('copilot-cli', { sessionId })).rejects.toThrow(
			'DispatchAlreadyStarting'
		);
		expect(started).not.toHaveBeenCalled();
	});

	it.each(['cancel', 'refused', 'initial-guard'] as const)(
		'clears a proven %s nonstart before the next normal send',
		async (failure) => {
			const tabId = generateUUID();
			const sessionId = `worker-ai-${tabId}`;
			pianolaNewTabSpawns.hold('worker', tabId);
			pianolaNewTabSpawns.arm(
				'worker',
				tabId,
				() => {
					if (failure === 'initial-guard') throw new Error('Already paused');
				},
				vi.fn()
			);
			const attempt = spawnNativeWithResult(
				'copilot-cli',
				{ sessionId },
				{},
				{
					cancelPreflight: failure === 'cancel',
					spawnRefused: failure === 'refused',
				}
			);
			if (failure === 'refused')
				await expect(attempt).rejects.toThrow('agent process did not start');
			else
				await expect(attempt).rejects.toThrow(
					failure === 'cancel' ? /cancel|abort/i : 'Already paused'
				);
			expect(pianolaNewTabSpawns.isHeld('worker', tabId)).toBe(false);
			expect((await spawnNativeWithResult('copilot-cli', { sessionId })).result.success).toBe(true);
		}
	);

	it('never substitutes the caller generation when capture has no run evidence', async () => {
		const tabId = generateUUID();
		const started = vi.fn();
		pianolaNewTabSpawns.hold('worker', tabId);
		pianolaNewTabSpawns.arm('worker', tabId, () => {}, started);
		await spawnNativeWithResult('copilot-cli', { sessionId: `worker-ai-${tabId}` });
		expect(started).toHaveBeenCalledWith(undefined);
	});

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
