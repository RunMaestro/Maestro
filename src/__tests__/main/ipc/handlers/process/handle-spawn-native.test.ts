import { describe, expect, it, vi } from 'vitest';
import { handleProcessSpawn } from '../../../../../main/ipc/handlers/process/handle-spawn';
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
		spawn: vi.fn(() => ({ success: true, pid: 4242 })),
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
	const result = await handleProcessSpawn(config, {
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
		sessionsStore,
	});
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
