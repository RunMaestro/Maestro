import { describe, expect, it, vi } from 'vitest';
import { handleProcessSpawn } from '../../../../../main/ipc/handlers/process/handle-spawn';
import type { SpawnProcessConfig } from '../../../../../main/ipc/handlers/process/spawn-types';
import type { ProcessConfig } from '../../../../../main/process-manager/types';
import { getAgentCapabilities } from '../../../../../shared/maestro-lib/providers/capabilities';
import { getAgentDefinition } from '../../../../../shared/maestro-lib/providers/definitions';
import type { ToolType } from '../../../../../shared/types';
import type * as ProviderSessionWriter from '../../../../../main/utils/provider-session-writer';

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }));
vi.mock('../../../../../main/utils/provider-session-writer', async (importOriginal) => {
	const actual = await importOriginal<typeof ProviderSessionWriter>();
	return {
		...actual,
		acquireProviderSessionWriter: vi.fn(async () => () => {}),
	};
});
async function spawnNative(
	toolType: ToolType,
	overrides: Partial<SpawnProcessConfig> = {},
	agentConfigValues: Record<string, unknown> = {}
): Promise<ProcessConfig> {
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
	await handleProcessSpawn(config, {
		getProcessManager: () => processManager as never,
		getAgentDetector: () => ({ getAgent: async () => detected }) as never,
		agentConfigsStore: {
			get: (key: string, fallback: unknown) =>
				key === 'configs' ? { [toolType]: agentConfigValues } : fallback,
		} as never,
		settingsStore: { get: (_key: string, fallback: unknown) => fallback } as never,
		getMainWindow: () => null,
		sessionsStore: { get: (_key: string, fallback: unknown) => fallback } as never,
	});
	expect(processManager.spawn).toHaveBeenCalledOnce();
	return processManager.spawn.mock.calls[0][0] as ProcessConfig;
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
});
