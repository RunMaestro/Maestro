import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopConsultRunner } from '../../../main/cross-agent/consult-runner';
import { spawnGroupChatAgent } from '../../../main/group-chat/spawnGroupChatAgent';
import type { ProcessManager } from '../../../main/process-manager';
import {
	createConsultService,
	type ConsultObserver,
} from '../../../shared/maestro-lib/agents/consult';
import type { AgentConfig } from '../../../shared/maestro-lib/providers/definitions';
import type { GroupChatSpawn } from '../../../shared/maestro-lib/groupchat/types';

vi.mock('../../../main/group-chat/spawnGroupChatAgent', () => ({ spawnGroupChatAgent: vi.fn() }));
vi.mock('../../../main/group-chat/spawn-config', () => ({
	toSpawnGroupChatAgentConfig: () => ({}),
}));

const spawn = { processId: 'cross-agent-auth', providerId: 'codex' } as GroupChatSpawn;

describe('desktop consult listener lifecycle', () => {
	beforeEach(() =>
		vi.mocked(spawnGroupChatAgent).mockReset().mockResolvedValue({ success: true, pid: 123 })
	);

	it('forwards only the first matching error and detaches on exit', async () => {
		const emitter = new EventEmitter();
		const runner = createDesktopConsultRunner(emitter as ProcessManager, null);
		const observer = {
			onActivity: vi.fn(),
			onSessionId: vi.fn(),
			onEnd: vi.fn(),
		} satisfies ConsultObserver;
		await runner.start(spawn, observer);
		emitter.emit('agent-error', 'other', { message: 'unrelated', source: 'host-supervision' });
		emitter.emit('agent-error', spawn.processId, { message: 'recoverable', recoverable: true });
		emitter.emit('agent-error', spawn.processId, {
			message: 'Authentication blocked',
			source: 'host-supervision',
		});
		emitter.emit('agent-error', spawn.processId, {
			message: 'secondary error',
			source: 'host-supervision',
		});
		emitter.emit('exit', 'other', 0);
		expect(observer.onEnd).not.toHaveBeenCalled();
		emitter.emit('exit', spawn.processId, 0);
		expect(observer.onEnd).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ exitCode: 0, error: 'Authentication blocked' })
		);
		expect(emitter.eventNames()).toEqual([]);
	});

	it('detaches on stop', async () => {
		const emitter = Object.assign(new EventEmitter(), { kill: vi.fn() });
		const runner = createDesktopConsultRunner(emitter as unknown as ProcessManager, null);
		const observer = {
			onActivity: vi.fn(),
			onSessionId: vi.fn(),
			onEnd: vi.fn(),
		} satisfies ConsultObserver;
		await runner.start(spawn, observer);
		runner.stop(spawn.processId);
		expect(emitter.kill).toHaveBeenCalledWith(spawn.processId);
		expect(emitter.eventNames()).toEqual([]);
		emitter.emit('exit', spawn.processId, 0);
		expect(observer.onEnd).not.toHaveBeenCalled();
	});

	it.each(['refused', 'thrown'])('detaches when spawn is %s', async (failure) => {
		const emitter = new EventEmitter();
		const runner = createDesktopConsultRunner(emitter as ProcessManager, null);
		const observer = {
			onActivity: vi.fn(),
			onSessionId: vi.fn(),
			onEnd: vi.fn(),
		} satisfies ConsultObserver;
		if (failure === 'refused')
			vi.mocked(spawnGroupChatAgent).mockResolvedValueOnce({ success: false, pid: -1 });
		else vi.mocked(spawnGroupChatAgent).mockRejectedValueOnce(new Error('spawn failed'));
		if (failure === 'refused')
			expect(await runner.start(spawn, observer)).toMatchObject({ success: false });
		else await expect(runner.start(spawn, observer)).rejects.toThrow('spawn failed');
		expect(emitter.eventNames()).toEqual([]);
	});
});

describe('desktop consult completion with process errors', () => {
	beforeEach(() =>
		vi.mocked(spawnGroupChatAgent).mockReset().mockResolvedValue({ success: true, pid: 123 })
	);

	it.each([
		{ kind: 'recoverable provider error', exitCode: 0, hostError: false, expectedError: undefined },
		{ kind: 'host supervision error', exitCode: 0, hostError: true, expectedError: 'Host stalled' },
		{
			kind: 'ordinary nonzero exit',
			exitCode: 1,
			hostError: false,
			expectedError: 'Claude exited with code 1.',
		},
	])('handles $kind', async ({ exitCode, hostError, expectedError }) => {
		const emitter = new EventEmitter();
		const runner = createDesktopConsultRunner(emitter as ProcessManager, null);
		const service = createConsultService();
		const chunks: import('../../../shared/crossAgentTypes').CrossAgentResponseChunk[] = [];
		const agent = {
			id: 'claude-code',
			name: 'Claude',
			command: 'claude',
			path: 'claude',
			args: [],
			available: true,
			readOnlyArgs: [],
		} as unknown as AgentConfig;
		await service.start(
			{
				requestId: 'r1',
				sourceSessionId: 'src',
				sourceTabId: 'tab',
				targetSessionId: 'tgt',
				userPrompt: 'Question?',
				transcript: [],
				strategy: { kind: 'full' },
				createdAt: 0,
			},
			{
				runner,
				resolveAgent: async () => agent,
				sshStore: null,
				getTargetSession: () => ({
					id: 'tgt',
					name: 'Claude',
					toolType: 'claude-code',
					cwd: '/proj',
				}),
				onChunk: (chunk) => chunks.push(chunk),
			}
		);
		const id = 'cross-agent-r1';
		emitter.emit('session-id', id, 'claude-session');
		emitter.emit('agent-error', id, { message: 'Provider recovered', recoverable: true });
		emitter.emit('data', id, 'A useful answer');
		if (hostError)
			emitter.emit('agent-error', id, { message: 'Host stalled', source: 'host-supervision' });
		emitter.emit('exit', id, exitCode);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ done: true, chunk: 'A useful answer' });
		expect(chunks[0].error).toBe(expectedError);
		expect(chunks[0].targetAgentSessionId).toBe(expectedError ? undefined : 'claude-session');
	});
});
