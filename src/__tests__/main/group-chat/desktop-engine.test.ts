/**
 * @file desktop-engine.test.ts
 * @description The desktop's binding of the group chat engine: the launcher it hands
 * the engine, and the agent directory its setters fill.
 *
 * What the engine does with them is covered in
 * `src/shared/maestro-lib/groupchat/__tests__/router.test.ts` and, end to end through
 * the shims, `group-chat-router.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/maestro-test') } }));
vi.mock('electron-store', () => ({
	default: class MockStore {
		get() {
			return undefined;
		}
		set() {}
	},
}));
vi.mock('../../../main/prompt-manager', () => ({ getPrompt: vi.fn(() => '') }));

const mockSpawnGroupChatAgent = vi.fn();
vi.mock('../../../main/group-chat/spawnGroupChatAgent', () => ({
	spawnGroupChatAgent: (...args: unknown[]) => mockSpawnGroupChatAgent(...args),
}));

import {
	createDesktopGroupChatLauncher,
	desktopLauncherFor,
	setSshStore,
} from '../../../main/group-chat/desktop-engine';
import type { IProcessManager } from '../../../main/group-chat/group-chat-moderator';
import type { GroupChatSpawn } from '../../../shared/maestro-lib/groupchat/types';

describe('desktop group chat launcher', () => {
	let processManager: IProcessManager;
	const detector = { getAgent: vi.fn() };

	beforeEach(() => {
		vi.clearAllMocks();
		processManager = {
			spawn: vi.fn().mockReturnValue({ pid: 1, success: true }),
			write: vi.fn().mockReturnValue(true),
			kill: vi.fn().mockReturnValue(true),
		};
	});

	const spawn: GroupChatSpawn = {
		processId: 'group-chat-abc-moderator-1',
		providerId: 'claude-code',
		agent: { id: 'claude-code', command: 'claude', args: [] } as never,
		command: '/usr/local/bin/claude',
		args: ['--print'],
		cwd: '/home/me',
		prompt: 'hello',
		customEnvVars: { A: '1' },
		agentConfigValues: { model: 'x' },
		sshRemoteConfig: { enabled: true, remoteId: 'r1' },
		tokenMode: 'interactive',
		maestroPPath: '/opt/maestro-p',
		readOnlyMode: true,
		debugLabel: 'moderator',
		maxWaitSeconds: 600,
	};

	it('starts a turn through spawnGroupChatAgent with the process manager and registered SSH store', async () => {
		const sshStore = { getSshRemotes: vi.fn(() => []) };
		setSshStore(sshStore as never);
		mockSpawnGroupChatAgent.mockResolvedValue({ pid: 77, success: true });

		const launcher = createDesktopGroupChatLauncher(processManager, detector);
		const result = await launcher.runner.start(spawn);

		expect(result).toEqual({ pid: 77, success: true });
		expect(mockSpawnGroupChatAgent).toHaveBeenCalledWith({
			sessionId: 'group-chat-abc-moderator-1',
			agentId: 'claude-code',
			agent: spawn.agent,
			command: '/usr/local/bin/claude',
			args: ['--print'],
			cwd: '/home/me',
			prompt: 'hello',
			customEnvVars: { A: '1' },
			agentConfigValues: { model: 'x' },
			sshRemoteConfig: { enabled: true, remoteId: 'r1' },
			sshStore,
			tokenMode: 'interactive',
			maestroPPath: '/opt/maestro-p',
			processManager,
			readOnlyMode: true,
			debugLabel: 'moderator',
			maxWaitSeconds: 600,
		});
	});

	it('stops a turn by killing its full process id', () => {
		const launcher = createDesktopGroupChatLauncher(processManager, detector);

		launcher.runner.stop('group-chat-abc-moderator-1');

		expect(processManager.kill).toHaveBeenCalledWith('group-chat-abc-moderator-1');
	});

	it('resolves an agent through the detector', async () => {
		detector.getAgent.mockResolvedValue({ id: 'codex' });
		const launcher = createDesktopGroupChatLauncher(processManager, detector);

		await expect(launcher.resolveAgent('codex')).resolves.toEqual({ id: 'codex' });
		expect(detector.getAgent).toHaveBeenCalledWith('codex');
	});

	it('builds a launcher only when both the process manager and the detector exist', () => {
		expect(desktopLauncherFor(processManager, detector)).toBeDefined();
		expect(desktopLauncherFor(processManager, undefined)).toBeUndefined();
		expect(desktopLauncherFor(null, detector)).toBeUndefined();
		expect(desktopLauncherFor(undefined, null)).toBeUndefined();
	});
});
