import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import type { SpawnGroupChatAgentConfig } from '../../../main/group-chat/spawnGroupChatAgent';
import type { PreparedGroupChatSpawn } from '../../../shared/maestro-lib/groupchat/spawn';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
	spawn: vi.fn(),
}));
vi.mock('../../../main/utils/system-prompt-delivery', () => ({
	applySystemPromptDelivery: vi.fn(),
}));
vi.mock('../../../shared/maestro-lib/groupchat/spawn', () => ({ prepareGroupChatSpawn: vi.fn() }));
vi.mock('../../../main/agents/probeRemoteMaestroP', () => ({
	ensureRemoteMaestroPProbed: vi.fn(),
}));
vi.mock('../../../main/group-chat/group-chat-config', () => ({ getWindowsSpawnConfig: vi.fn() }));
vi.mock('../../../main/group-chat/group-chat-turn-metrics', () => ({
	beginGroupChatTurn: vi.fn(),
}));
vi.mock('../../../main/agents/resolveClaudeSpawnMode', () => ({ resolveClaudeSpawnMode: vi.fn() }));
vi.mock('../../../main/process-manager/steering-client', () => ({
	steeringSocketPathFor: vi.fn(),
}));

import { applySystemPromptDelivery } from '../../../main/utils/system-prompt-delivery';
import { prepareGroupChatSpawn } from '../../../shared/maestro-lib/groupchat/spawn';

describe('shared desktop Group Chat and consult spawn activity', () => {
	const target = path.resolve('group-chat-target');
	const drain = () => new Promise(setImmediate);
	let gate: typeof import('../../../main/git/worktreeActivity');
	let turns: typeof import('../../../main/git/worktreeTurnActivity');
	let helper: typeof import('../../../main/group-chat/spawnGroupChatAgent');
	let config: SpawnGroupChatAgentConfig;
	let prepared: PreparedGroupChatSpawn;
	let releases: Array<() => void>;
	let children: EventEmitter[];
	let active: number;
	const request = () => helper.spawnGroupChatAgent(config);
	async function reserve(root = target) {
		const result = await gate.reserveWorktreeCleanup(root);
		if (result.status === 'reserved-partially') releases.push(result.release);
		return result;
	}
	async function blocked() {
		expect(await reserve()).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
	}
	async function idle() {
		const result = await reserve();
		expect(result.status).toBe('reserved-partially');
		if (result.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(result.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		result.release();
	}
	beforeEach(async () => {
		vi.resetModules();
		vi.resetAllMocks();
		releases = [];
		children = [];
		active = 0;
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		gate = await import('../../../main/git/worktreeActivity');
		const admit = gate.beginGlobalWorktreeActivity;
		vi.spyOn(gate, 'beginGlobalWorktreeActivity').mockImplementation(() => {
			const release = admit();
			active++;
			let released = false;
			return () => {
				if (!released) active--;
				released = true;
				release();
			};
		});
		helper = await import('../../../main/group-chat/spawnGroupChatAgent');
		turns = await import('../../../main/git/worktreeTurnActivity');
		config = {
			sessionId: 'group-chat-turn',
			agentId: 'codex',
			agent: { id: 'codex', command: 'codex' } as SpawnGroupChatAgentConfig['agent'],
			cwd: target,
			args: ['--batch'],
			prompt: 'Repair login',
			processManager: {
				spawn: vi.fn(() => ({ pid: 123, success: true })),
				write: vi.fn(),
				kill: vi.fn(),
			},
		};
		prepared = {
			processId: config.sessionId,
			providerId: config.agentId,
			cwd: target,
			command: 'codex',
			args: ['--batch'],
			readOnlyMode: false,
			contextWindow: 1000,
		};
		vi.mocked(applySystemPromptDelivery).mockResolvedValue({
			args: config.args,
			prompt: config.prompt,
		});
		vi.mocked(prepareGroupChatSpawn).mockResolvedValue(prepared);
		vi.mocked(spawn).mockImplementation(() => {
			const child = new EventEmitter();
			child.on('error', () => {});
			children.push(child);
			return child as ReturnType<typeof spawn>;
		});
	});
	afterEach(async () => {
		for (const release of releases) release();
		for (const child of children) child.emit('close');
		await drain();
		expect(active).toBe(0);
		vi.restoreAllMocks();
	});

	it.each([target, path.join(target, 'descendant'), path.resolve('other-repository')])(
		'refuses under %s before config, prompt delivery, SSH/provider setup or recovery',
		async (root) => {
			const hold = await reserve(root);
			const read = vi.fn(() => {
				throw new Error('Unexpected config inspection');
			});
			await expect(helper.spawnGroupChatAgent(new Proxy(config, { get: read }))).rejects.toThrow(
				/reserved/
			);
			for (const effect of [
				read,
				applySystemPromptDelivery,
				prepareGroupChatSpawn,
				config.processManager.spawn,
				config.processManager.kill,
			])
				expect(effect).not.toHaveBeenCalled();
			if (hold.status === 'reserved-partially') hold.release();
			await expect(request()).resolves.toEqual({ pid: 123, success: true });
			await idle();
		}
	);
	it('admits before dependency inspection and releases on a throwing config getter', async () => {
		const levels: number[] = [];
		Object.defineProperty(config, 'processManager', {
			get: () => {
				levels.push(active);
				throw new Error('Dependency unavailable');
			},
		});
		await expect(request()).rejects.toThrow('Dependency unavailable');
		expect(levels).toEqual([1]);
		expect(applySystemPromptDelivery).not.toHaveBeenCalled();
		await idle();
	});
	it.each(['success', 'rejection'] as const)(
		'holds pending prompt delivery through %s',
		async (outcome) => {
			const pending =
				Promise.withResolvers<Awaited<ReturnType<typeof applySystemPromptDelivery>>>();
			vi.mocked(applySystemPromptDelivery).mockReturnValueOnce(pending.promise);
			const result = request();
			const assertion =
				outcome === 'success'
					? expect(result).resolves.toEqual({ pid: 123, success: true })
					: expect(result).rejects.toThrow('Prompt file failed');
			const during = await reserve();
			expect(prepareGroupChatSpawn).not.toHaveBeenCalled();
			if (outcome === 'success') pending.resolve({ args: [], prompt: 'Delivered prompt' });
			else pending.reject(new Error('Prompt file failed'));
			await assertion;
			expect(during.status).toBe('blocked');
			if (outcome === 'rejection') expect(config.processManager.spawn).not.toHaveBeenCalled();
			await idle();
		}
	);
	it.each(['success', 'rejection'] as const)(
		'holds pending provider/SSH preparation through %s',
		async (outcome) => {
			config.sshRemoteConfig = { enabled: true, remoteId: 'remote' };
			config.sshStore = {} as NonNullable<SpawnGroupChatAgentConfig['sshStore']>;
			config.cwd = '~/remote-project';
			const pending = Promise.withResolvers<PreparedGroupChatSpawn>();
			vi.mocked(prepareGroupChatSpawn).mockReturnValueOnce(pending.promise);
			const result = request();
			const assertion =
				outcome === 'success'
					? expect(result).resolves.toEqual({ pid: 123, success: true })
					: expect(result).rejects.toThrow('Remote unavailable');
			await drain();
			const during = await reserve();
			expect(config.processManager.spawn).not.toHaveBeenCalled();
			if (outcome === 'success')
				pending.resolve({ ...prepared, command: 'ssh', sshStdinScript: 'remote-script' });
			else pending.reject(new Error('Remote unavailable'));
			await assertion;
			expect(during.status).toBe('blocked');
			if (outcome === 'success')
				expect(config.processManager.spawn).toHaveBeenCalledWith(
					expect.objectContaining({ command: 'ssh', sshStdinScript: 'remote-script' })
				);
			else expect(config.processManager.spawn).not.toHaveBeenCalled();
			expect(fs.realpath).not.toHaveBeenCalledWith(config.cwd);
			await idle();
		}
	);
	it('blocks a reservation already awaiting canonicalization when a new request begins', async () => {
		const pending = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(pending.promise);
		const reservation = reserve();
		const setup = Promise.withResolvers<PreparedGroupChatSpawn>();
		vi.mocked(prepareGroupChatSpawn).mockReturnValueOnce(setup.promise);
		const result = request();
		pending.resolve(target);
		const during = await reservation;
		setup.resolve(prepared);
		await result;
		expect(during.status).toBe('blocked');
		await idle();
	});
	it('retains admission between prompt completion, provider preparation and spawn handoff', async () => {
		const levels: number[] = [];
		vi.mocked(applySystemPromptDelivery).mockImplementation(async () => {
			levels.push(active);
			return { args: [], prompt: undefined };
		});
		vi.mocked(prepareGroupChatSpawn).mockImplementation(async () => {
			levels.push(active);
			return prepared;
		});
		vi.mocked(config.processManager.spawn).mockImplementation(() => {
			levels.push(active);
			return { pid: 123, success: true };
		});
		await request();
		expect(levels).toEqual([1, 1, 1]);
		await idle();
	});
	it.each(['failed-result', 'throw'] as const)(
		'releases only outer preparation on %s handoff',
		async (outcome) => {
			vi.mocked(config.processManager.spawn).mockImplementation(() => {
				if (outcome === 'throw') throw new Error('Spawn failed');
				return { pid: 0, success: false };
			});
			if (outcome === 'throw') await expect(request()).rejects.toThrow('Spawn failed');
			else await expect(request()).resolves.toEqual({ pid: 0, success: false });
			expect(config.processManager.kill).not.toHaveBeenCalled();
			await idle();
		}
	);
	it('releases preparation on result construction failure before native handoff', async () => {
		Object.defineProperty(prepared, 'command', {
			get: () => {
				throw new Error('Invalid preparation');
			},
		});
		await expect(request()).rejects.toThrow('Invalid preparation');
		expect(config.processManager.spawn).not.toHaveBeenCalled();
		await idle();
	});
	it('keeps an overlapping preparation busy when another request fails', async () => {
		const pending = Promise.withResolvers<PreparedGroupChatSpawn>();
		vi.mocked(prepareGroupChatSpawn)
			.mockReturnValueOnce(pending.promise)
			.mockRejectedValueOnce(new Error('Second setup failed'));
		const first = request();
		await drain();
		await expect(request()).rejects.toThrow('Second setup failed');
		const during = await reserve();
		pending.resolve(prepared);
		await first;
		expect(during.status).toBe('blocked');
		await idle();
	});
	it.each(['success', 'failed-result', 'throw'] as const)(
		'native close remains independent after %s handoff',
		async (outcome) => {
			const levels: number[] = [];
			vi.mocked(config.processManager.spawn).mockImplementation(() =>
				turns.withWorktreeTurnActivity(
					(_start, _observe, nativeSpawn) => {
						levels.push(active);
						nativeSpawn('provider', [], {});
						if (outcome === 'throw') throw new Error('After native start');
						return { pid: 123, success: outcome === 'success' };
					},
					() => {}
				)
			);
			if (outcome === 'throw') await expect(request()).rejects.toThrow('After native start');
			else await request();
			await blocked();
			children[0].emit('error', new Error('Early error'));
			children[0].emit('exit', 1);
			await blocked();
			children[0].emit('close');
			expect(levels).toEqual([2]);
			await idle();
		}
	);
	it('does not release outer preparation when native close fires during handoff', async () => {
		const observations: number[] = [];
		vi.mocked(config.processManager.spawn).mockImplementation(() => {
			turns.withWorktreeTurnActivity(
				(_start, _observe, nativeSpawn) => {
					nativeSpawn('provider', [], {});
					children[0].emit('close');
				},
				() => {}
			);
			observations.push(active);
			return { pid: 123, success: true };
		});
		await request();
		expect(observations).toEqual([1]);
		await idle();
	});
});
