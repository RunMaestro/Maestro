/**
 * @file wrap-spawn-for-ssh.steering.test.ts
 * @description Parity F1: a Claude TUI turn on an SSH remote names its steering
 * socket on the REMOTE (in the env the remote script exports) and records how to
 * reach it, the way the local interactive spawn names a local one. Only when the
 * remote's maestro-p serves the steering relay; an older one gets no channel.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SshRemoteConfig } from '../../../../../shared/types';
import { STEERING_SOCKET_ENV_VAR } from '../../../../../shared/chatSteering';
import { remoteSteeringSocketFor } from '../../../../../main/process-manager/steering-client';
import type { ClaudeSpawnContext } from '../../../../../main/ipc/handlers/process/resolve-claude-spawn-context';
import type { SpawnProcessConfig } from '../../../../../main/ipc/handlers/process/spawn-types';

vi.mock('../../../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const built = vi.hoisted(() => ({ env: [] as Array<Record<string, string> | undefined> }));
vi.mock('../../../../../main/utils/ssh-command-builder', () => ({
	buildSshCommandWithStdin: vi.fn(
		async (_remote: unknown, options: { env?: Record<string, string> }) => {
			built.env.push(options.env);
			return { command: 'ssh', args: ['box', '/bin/bash', '-s'], stdinScript: 'exec maestro-p\n' };
		}
	),
}));

import { wrapSpawnForSsh } from '../../../../../main/ipc/handlers/process/wrap-spawn-for-ssh';

const remote: SshRemoteConfig = {
	id: 'r1',
	name: 'box',
	host: 'box.example',
	port: 22,
	username: 'me',
	privateKeyPath: '',
	enabled: true,
} as SshRemoteConfig;

function claudeContext(overrides: Partial<ClaudeSpawnContext> = {}): ClaudeSpawnContext {
	return {
		isClaudeCode: true,
		isSshEnabled: true,
		baseSessionId: 's1',
		tokenSourceSessionId: 's1',
		claudeResolvedMode: 'interactive',
		claudeResolvedReason: 'auto',
		resolvedMaestroPBinPath: null,
		resolvedConfigDirKey: 'default',
		claudeDecisionRealBinPath: undefined,
		claudeResolvedRemote: true,
		acceptWorkspaceTrust: false,
		...overrides,
	};
}

async function wrap(context: ClaudeSpawnContext) {
	const config = {
		sessionId: 's1-ai-tab-1',
		toolType: 'claude-code',
		cwd: '/home/me/project',
		command: 'claude',
		args: [],
		prompt: 'hello',
		sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
	} as unknown as SpawnProcessConfig;
	return wrapSpawnForSsh({
		config,
		agent: null,
		claudeContext: context,
		commandToSpawn: 'claude',
		argsToSpawn: ['--print'],
		headlessArgs: ['--print'],
		customEnvVarsToPass: undefined,
		effectiveCustomEnvVars: undefined,
		effectivePrompt: 'hello',
		resolvedRemote: remote,
		globalShellEnvVars: {},
		useShell: false,
		shellToUse: undefined,
		settingsStore: {} as never,
	});
}

beforeEach(() => {
	built.env = [];
});

describe('wrapSpawnForSsh steering channel', () => {
	it('names the socket on the remote and records how to reach it when maestro-p can relay', async () => {
		const result = await wrap(claudeContext({ remoteMaestroPCanSteer: true }));
		const socket = remoteSteeringSocketFor('s1-ai-tab-1');
		expect(built.env[0]?.[STEERING_SOCKET_ENV_VAR]).toBe(socket);
		expect(result.remoteSteering).toEqual({ remote, command: 'maestro-p', socket });
		// The remote env is exported by the remote script; nothing goes to the local ssh.
		expect(result.customEnvVarsToPass).toBeUndefined();
	});

	it('opens no channel on a remote whose maestro-p predates the relay', async () => {
		const result = await wrap(claudeContext({ remoteMaestroPCanSteer: false }));
		expect(built.env[0]?.[STEERING_SOCKET_ENV_VAR]).toBeUndefined();
		expect(result.remoteSteering).toBeUndefined();
	});

	it('opens no channel when no probe has said what the remote maestro-p can do', async () => {
		const result = await wrap(claudeContext());
		expect(built.env[0]?.[STEERING_SOCKET_ENV_VAR]).toBeUndefined();
		expect(result.remoteSteering).toBeUndefined();
	});

	it('opens no channel for an API (`claude --print`) turn on the remote', async () => {
		const result = await wrap(
			claudeContext({
				claudeResolvedMode: 'api',
				claudeResolvedRemote: false,
				remoteMaestroPCanSteer: true,
			})
		);
		expect(built.env[0]?.[STEERING_SOCKET_ENV_VAR]).toBeUndefined();
		expect(result.remoteSteering).toBeUndefined();
	});
});
