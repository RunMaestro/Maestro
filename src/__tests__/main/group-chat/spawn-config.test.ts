import { describe, it, expect } from 'vitest';
import { toSpawnGroupChatAgentConfig } from '../../../main/group-chat/spawn-config';
import type { GroupChatSpawn } from '../../../shared/maestro-lib/groupchat/types';

describe('toSpawnGroupChatAgentConfig', () => {
	const spawn: GroupChatSpawn = {
		processId: 'cross-agent-r1',
		providerId: 'codex',
		agent: { id: 'codex' } as never,
		command: '/opt/codex',
		args: ['exec'],
		cwd: '/proj',
		prompt: 'hi',
		customEnvVars: { A: '1' },
		agentConfigValues: { contextWindow: 5 },
		sshRemoteConfig: { enabled: true, remoteId: 'r1' },
		tokenMode: 'api',
		maestroPPath: '/p/maestro-p.js',
		readOnlyMode: true,
		debugLabel: 'label',
		maxWaitSeconds: 600,
	};

	it('carries every field of the library spawn across, renaming the two ids', () => {
		const processManager = { spawn: () => ({}) } as never;
		const sshStore = { getSshRemotes: () => [] } as never;

		const config = toSpawnGroupChatAgentConfig(spawn, { processManager, sshStore });

		expect(config).toEqual({
			sessionId: 'cross-agent-r1',
			agentId: 'codex',
			agent: spawn.agent,
			command: '/opt/codex',
			args: ['exec'],
			cwd: '/proj',
			prompt: 'hi',
			customEnvVars: { A: '1' },
			agentConfigValues: { contextWindow: 5 },
			sshRemoteConfig: { enabled: true, remoteId: 'r1' },
			sshStore,
			tokenMode: 'api',
			maestroPPath: '/p/maestro-p.js',
			processManager,
			readOnlyMode: true,
			debugLabel: 'label',
			maxWaitSeconds: 600,
		});
	});

	it('passes a missing SSH store through as null, never undefined', () => {
		const config = toSpawnGroupChatAgentConfig(spawn, {
			processManager: {} as never,
			sshStore: null,
		});
		expect(config.sshStore).toBeNull();
	});
});
