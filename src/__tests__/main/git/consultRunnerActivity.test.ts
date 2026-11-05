import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import { spawn as spawnChild } from 'child_process';
import type { ProcessManager } from '../../../main/process-manager';
import type { ConsultObserver, ConsultRunner } from '../../../shared/maestro-lib/agents/consult';
import type { GroupChatSpawn } from '../../../shared/maestro-lib/groupchat/types';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
	spawn: vi.fn(),
}));
vi.mock('../../../main/group-chat/spawnGroupChatAgent', () => ({ spawnGroupChatAgent: vi.fn() }));
vi.mock('../../../main/group-chat/spawn-config', () => ({ toSpawnGroupChatAgentConfig: vi.fn() }));
vi.mock('../../../main/group-chat/output-parser', () => ({ extractTextFromStreamJson: vi.fn() }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { spawnGroupChatAgent } from '../../../main/group-chat/spawnGroupChatAgent';
import { toSpawnGroupChatAgentConfig } from '../../../main/group-chat/spawn-config';
import { extractTextFromStreamJson } from '../../../main/group-chat/output-parser';
import { captureException } from '../../../main/utils/sentry';
import { AGENT_LIVENESS_EVENTS } from '../../../main/utils/agent-liveness';

describe('desktop consult start and stop activity', () => {
	const target = path.resolve('consult-target');
	const drain = () => new Promise(setImmediate);
	const spawn = { processId: 'cross-agent-request', providerId: 'codex' } as GroupChatSpawn;
	let gate: typeof import('../../../main/git/worktreeActivity');
	let turns: typeof import('../../../main/git/worktreeTurnActivity');
	let runner: ConsultRunner;
	let manager: EventEmitter & { kill: ReturnType<typeof vi.fn> };
	let observer: ConsultObserver;
	let releases: Array<() => void>;
	let children: EventEmitter[];
	let active: number;
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
		const hold = await reserve();
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		hold.release();
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
		turns = await import('../../../main/git/worktreeTurnActivity');
		const { createDesktopConsultRunner } = await import('../../../main/cross-agent/consult-runner');
		manager = Object.assign(new EventEmitter(), { kill: vi.fn() });
		observer = { onActivity: vi.fn(), onSessionId: vi.fn(), onEnd: vi.fn() };
		runner = createDesktopConsultRunner(manager as unknown as ProcessManager, null);
		vi.mocked(spawnGroupChatAgent).mockResolvedValue({ success: true, pid: 123 });
		vi.mocked(extractTextFromStreamJson).mockImplementation((text) => text);
		vi.mocked(spawnChild).mockImplementation(() => {
			const child = new EventEmitter();
			child.on('error', () => {});
			children.push(child);
			return child as ReturnType<typeof spawnChild>;
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
		'refuses start under %s before input, listeners, mapping, spawn or recovery',
		async (root) => {
			await reserve(root);
			const read = vi.fn(() => {
				throw new Error('Unexpected input inspection');
			});
			const on = vi.spyOn(manager, 'on');
			const off = vi.spyOn(manager, 'off');
			await expect(runner.start(new Proxy(spawn, { get: read }), observer)).rejects.toThrow(
				/reserved/
			);
			for (const effect of [
				read,
				on,
				off,
				toSpawnGroupChatAgentConfig,
				spawnGroupChatAgent,
				manager.kill,
			])
				expect(effect).not.toHaveBeenCalled();
		}
	);

	it('releases a start whose input getter throws', async () => {
		const observations: number[] = [];
		const input = new Proxy(spawn, {
			get() {
				observations.push(active);
				throw new Error('input failed');
			},
		});
		await expect(runner.start(input, observer)).rejects.toThrow('input failed');
		expect(observations).toEqual([1]);
		expect(manager.eventNames()).toEqual([]);
		await idle();
	});

	it('releases when listener setup throws before spawn', async () => {
		const observations: number[] = [];
		vi.spyOn(manager, 'on').mockImplementationOnce(() => {
			observations.push(active);
			throw new Error('listener setup failed');
		});
		await expect(runner.start(spawn, observer)).rejects.toThrow('listener setup failed');
		expect(observations).toEqual([1]);
		expect(spawnGroupChatAgent).not.toHaveBeenCalled();
		await idle();
	});

	it('holds asynchronous rejection cleanup and releases if detach also throws', async () => {
		let reject!: (error: Error) => void;
		vi.mocked(spawnGroupChatAgent).mockImplementationOnce(
			() => new Promise((_, fail) => (reject = fail))
		);
		const observations: number[] = [];
		vi.spyOn(manager, 'off').mockImplementationOnce(() => {
			observations.push(active);
			throw new Error('detach failed');
		});
		const request = runner.start(spawn, observer);
		await blocked();
		reject(new Error('pending preparation failed'));
		await expect(request).rejects.toThrow('detach failed');
		expect(observations).toEqual([1]);
		await idle();
	});

	it.each(['mapping', 'refusal', 'rejection'])(
		'holds through %s failure and detach',
		async (failure) => {
			const observations: number[] = [];
			const originalOff = manager.off.bind(manager);
			vi.spyOn(manager, 'off').mockImplementation((event, listener) => {
				observations.push(active);
				return originalOff(event, listener);
			});
			vi.mocked(toSpawnGroupChatAgentConfig).mockImplementation(() => {
				observations.push(active);
				if (failure === 'mapping') throw new Error('mapping failed');
				return {} as ReturnType<typeof toSpawnGroupChatAgentConfig>;
			});
			if (failure === 'refusal')
				vi.mocked(spawnGroupChatAgent).mockResolvedValueOnce({ success: false, pid: -1 });
			else vi.mocked(spawnGroupChatAgent).mockRejectedValueOnce(new Error('spawn failed'));
			const request = runner.start(spawn, observer);
			if (failure === 'refusal') await expect(request).resolves.toMatchObject({ success: false });
			else await expect(request).rejects.toThrow(/failed/);
			expect(observations.length).toBeGreaterThan(1);
			expect(observations.every((n) => n > 0)).toBe(true);
			expect(manager.eventNames()).toEqual([]);
			await idle();
		}
	);

	it.each(['success', 'failure'])(
		'keeps pending setup admitted after stop until %s',
		async (outcome) => {
			let finish!: (value: { success: boolean; pid: number }) => void;
			vi.mocked(spawnGroupChatAgent).mockImplementationOnce(
				() => new Promise((resolve) => (finish = resolve))
			);
			const request = runner.start(spawn, observer);
			await blocked();
			expect(runner.stop(spawn.processId)).toBe('');
			expect(manager.eventNames()).toEqual([]);
			await blocked();
			finish({ success: outcome === 'success', pid: 123 });
			await request;
			await idle();
			expect(manager.kill).toHaveBeenCalledExactlyOnceWith(spawn.processId);
		}
	);

	it('does not release a second pending consult when the first finishes', async () => {
		const finishes: Array<(value: { success: boolean; pid: number }) => void> = [];
		vi.mocked(spawnGroupChatAgent).mockImplementation(
			() => new Promise((resolve) => finishes.push(resolve))
		);
		const first = runner.start(spawn, observer);
		const second = runner.start({ ...spawn, processId: 'second' }, observer);
		finishes[0]({ success: false, pid: -1 });
		await first;
		await blocked();
		finishes[1]({ success: false, pid: -1 });
		await second;
		await idle();
	});

	it('wins admission while reservation canonicalization is pending', async () => {
		let canonicalize!: (value: string) => void;
		vi.mocked(fs.realpath).mockImplementationOnce(
			() => new Promise((resolve) => (canonicalize = resolve))
		);
		const reservation = reserve();
		let finish!: (value: { success: boolean; pid: number }) => void;
		vi.mocked(spawnGroupChatAgent).mockImplementationOnce(
			() => new Promise((resolve) => (finish = resolve))
		);
		const request = runner.start(spawn, observer);
		canonicalize(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		finish({ success: false, pid: -1 });
		await request;
		await idle();
	});

	it('refuses stop before detach, kill and parsing recovery and preserves the run', async () => {
		await runner.start(spawn, observer);
		manager.emit('data', spawn.processId, 'partial answer');
		const off = vi.spyOn(manager, 'off');
		const hold = await reserve();
		expect(() => runner.stop(spawn.processId)).toThrow(/reserved/);
		for (const effect of [off, manager.kill, extractTextFromStreamJson])
			expect(effect).not.toHaveBeenCalled();
		expect(manager.listenerCount('exit')).toBe(1);
		if (hold.status === 'reserved-partially') hold.release();
		expect(runner.stop(spawn.processId)).toBe('partial answer');
		expect(manager.eventNames()).toEqual([]);
		await idle();
	});

	it.each(['success', 'kill error', 'parse error', 'detach error', 'missing run'])(
		'holds stop through synchronous %s and releases on every outcome',
		async (outcome) => {
			if (outcome !== 'missing run') await runner.start(spawn, observer);
			const observations: number[] = [];
			const off = manager.off.bind(manager);
			vi.spyOn(manager, 'off').mockImplementation((event, listener) => {
				observations.push(active);
				if (outcome === 'detach error') throw new Error('detach failed');
				return off(event, listener);
			});
			manager.kill.mockImplementation(() => {
				observations.push(active);
				if (outcome === 'kill error') throw new Error('kill failed');
			});
			vi.mocked(extractTextFromStreamJson).mockImplementation(() => {
				observations.push(active);
				if (outcome === 'parse error') throw new Error('parse failed');
				return 'answer';
			});
			if (outcome === 'detach error')
				expect(() => runner.stop(spawn.processId)).toThrow('detach failed');
			else
				expect(runner.stop(spawn.processId)).toBe(
					['missing run', 'parse error'].includes(outcome) ? '' : 'answer'
				);
			expect(observations.length).toBeGreaterThan(0);
			expect(observations.every((n) => n > 0)).toBe(true);
			await idle();
		}
	);

	it.each(['success', 'failure', 'throw'])(
		'preserves native ownership after %s handoff and stop',
		async (outcome) => {
			vi.mocked(spawnGroupChatAgent).mockImplementationOnce(async () => {
				turns.withWorktreeTurnActivity(
					(_, __, launch) => launch('agent', [], {}),
					() => {}
				);
				children[0].emit('error', new Error('early error'));
				children[0].emit('exit', 0);
				if (outcome === 'throw') throw new Error('handoff failed');
				return { success: outcome === 'success', pid: 123 };
			});
			const request = runner.start(spawn, observer);
			if (outcome === 'throw') await expect(request).rejects.toThrow('handoff failed');
			else await request;
			runner.stop(spawn.processId);
			await blocked();
			children[0].emit('close');
			await idle();
		}
	);

	describe('callbacks after start settles', () => {
		const events = ['data', 'thinking-chunk', 'session-id', 'agent-error', 'exit'] as const;
		const payloads = {
			data: 'answer',
			'thinking-chunk': undefined,
			'session-id': 'provider-session',
			'agent-error': { source: 'host-supervision', message: 'host failure' },
			exit: 1,
		};

		it.each(events)('refuses matching %s before mutation, observers or detach', async (event) => {
			await runner.start(spawn, observer);
			const off = vi.spyOn(manager, 'off');
			const hold = await reserve();
			expect(() => manager.emit(event, spawn.processId, payloads[event])).toThrow(/reserved/);
			for (const effect of [off, ...Object.values(observer), extractTextFromStreamJson])
				expect(effect).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
			expect(manager.listenerCount('exit')).toBe(1);
			if (hold.status === 'reserved-partially') hold.release();
			manager.emit('exit', spawn.processId, 0);
			const end = vi.mocked(observer.onEnd).mock.calls[0][0];
			expect(end.error).toBeUndefined();
			expect(end.readText()).toBe('');
			await idle();
		});

		it('ignores unrelated events under reservation without inspecting their payloads', async () => {
			await runner.start(spawn, observer);
			await reserve();
			const inspect = vi.fn(() => {
				throw new Error('unrelated payload inspected');
			});
			for (const event of events)
				expect(() =>
					manager.emit(event, 'unrelated', new Proxy({}, { get: inspect }))
				).not.toThrow();
			expect(inspect).not.toHaveBeenCalled();
			for (const effect of [...Object.values(observer), captureException])
				expect(effect).not.toHaveBeenCalled();
			expect(active).toBe(0);
		});

		it.each(AGENT_LIVENESS_EVENTS)('admits the %s observer after start', async (event) => {
			const observations: number[] = [];
			vi.mocked(observer.onActivity).mockImplementation(() => observations.push(active));
			await runner.start(spawn, observer);
			manager.emit(event, spawn.processId, 'delta');
			expect(observations).toEqual([1]);
			await idle();
		});

		it('admits buffer coercion, error inspection, session dispatch and exit cleanup', async () => {
			await runner.start(spawn, observer);
			const observations: number[] = [];
			manager.emit('data', spawn.processId, {
				toString: () => {
					observations.push(active);
					return 'answer';
				},
			});
			manager.emit('agent-error', spawn.processId, {
				get source() {
					observations.push(active);
					return 'host-supervision';
				},
				get message() {
					observations.push(active);
					return 'first failure';
				},
			});
			vi.mocked(observer.onSessionId).mockImplementation(() => observations.push(active));
			manager.emit('session-id', spawn.processId, 'provider-session');
			const off = manager.off.bind(manager);
			vi.spyOn(manager, 'off').mockImplementation((event, listener) => {
				observations.push(active);
				return off(event, listener);
			});
			vi.mocked(observer.onEnd).mockImplementation((end) => {
				observations.push(active);
				expect(end).toMatchObject({ exitCode: 2, error: 'first failure' });
				expect(end.readText()).toBe('answer');
			});
			manager.emit('exit', spawn.processId, 2);
			expect(observations.length).toBeGreaterThan(5);
			expect(observations.every((n) => n === 1)).toBe(true);
			expect(manager.eventNames()).toEqual([]);
			await idle();
		});

		it.each(['activity', 'session', 'error payload', 'detach', 'end', 'parser'])(
			'preserves the original %s exception and releases callback activity',
			async (failure) => {
				await runner.start(spawn, observer);
				const error = new Error(`${failure} failed`);
				const fail = () => {
					expect(active).toBeGreaterThan(0);
					throw error;
				};
				vi.mocked(captureException).mockImplementation(() => {
					throw new Error('diagnostic failed');
				});
				let invoke: () => unknown;
				if (failure === 'activity') {
					vi.mocked(observer.onActivity).mockImplementation(fail);
					invoke = () => manager.emit('thinking-chunk', spawn.processId);
				} else if (failure === 'session') {
					vi.mocked(observer.onSessionId).mockImplementation(fail);
					invoke = () => manager.emit('session-id', spawn.processId, 'id');
				} else if (failure === 'error payload') {
					invoke = () =>
						manager.emit('agent-error', spawn.processId, {
							get source() {
								return fail();
							},
						});
				} else if (failure === 'parser') {
					manager.emit('exit', spawn.processId, 0);
					vi.mocked(extractTextFromStreamJson).mockImplementation(fail);
					invoke = vi.mocked(observer.onEnd).mock.calls[0][0].readText;
				} else {
					if (failure === 'detach') vi.spyOn(manager, 'off').mockImplementationOnce(fail);
					else vi.mocked(observer.onEnd).mockImplementation(fail);
					invoke = () => manager.emit('exit', spawn.processId, 0);
				}
				expect(invoke).toThrow(error);
				expect(captureException).toHaveBeenCalledWith(error);
				await idle();
			}
		);

		it.each([target, path.join(target, 'child'), path.resolve('unrelated')])(
			'refuses delayed parsing under %s before provider lookup or parser effects',
			async (root) => {
				const provider = vi.fn(() => 'codex');
				await runner.start(
					{
						...spawn,
						get providerId() {
							return provider();
						},
					},
					observer
				);
				manager.emit('data', spawn.processId, 'answer');
				manager.emit('exit', spawn.processId, 0);
				const end = vi.mocked(observer.onEnd).mock.calls[0][0];
				provider.mockClear();
				const hold = await reserve(root);
				expect(end.readText).toThrow(/reserved/);
				expect(provider).not.toHaveBeenCalled();
				expect(extractTextFromStreamJson).not.toHaveBeenCalled();
				if (hold.status === 'reserved-partially') hold.release();
				const observations: number[] = [];
				provider.mockImplementation(() => {
					observations.push(active);
					return 'codex';
				});
				vi.mocked(extractTextFromStreamJson).mockImplementation((text) => {
					observations.push(active);
					return text;
				});
				expect(end.readText()).toBe('answer');
				expect(observations).toEqual([1, 1]);
				await idle();
			}
		);

		it('guards callbacks already captured by an emitter after stop detaches them', async () => {
			await runner.start(spawn, observer);
			const callbacks = events.map((event) => manager.listeners(event));
			runner.stop(spawn.processId);
			await reserve();
			for (let i = 0; i < events.length; i++)
				for (const callback of callbacks[i])
					expect(() => callback(spawn.processId, payloads[events[i]])).toThrow(/reserved/);
			for (const effect of [...Object.values(observer), captureException])
				expect(effect).not.toHaveBeenCalled();
		});

		it('keeps nested callbacks independent when native close occurs during exit parsing', async () => {
			await runner.start(spawn, observer);
			turns.withWorktreeTurnActivity(
				(_, __, launch) => launch('agent', [], {}),
				() => {}
			);
			await blocked();
			const observations: number[] = [];
			vi.mocked(observer.onEnd).mockImplementation((end) => {
				observations.push(active);
				expect(end.readText()).toBe('answer');
				observations.push(active);
			});
			vi.mocked(extractTextFromStreamJson).mockImplementation(() => {
				observations.push(active);
				children[0].emit('close');
				observations.push(active);
				return 'answer';
			});
			manager.emit('exit', spawn.processId, 0);
			expect(observations).toEqual([2, 3, 2, 1]);
			await idle();
		});

		it('keeps a callback admitted through reentrant stop and an observer exception', async () => {
			await runner.start(spawn, observer);
			const error = new Error('observer failed after stop');
			const observations: number[] = [];
			manager.kill.mockImplementation(() => observations.push(active));
			vi.mocked(observer.onActivity).mockImplementation(() => {
				observations.push(active);
				runner.stop(spawn.processId);
				observations.push(active);
				throw error;
			});
			expect(() => manager.emit('thinking-chunk', spawn.processId)).toThrow(error);
			expect(observations).toEqual([1, 2, 1]);
			expect(manager.eventNames()).toEqual([]);
			await idle();
		});

		it('does not retire another consult or native lifetime when one exit callback finishes', async () => {
			const other = { ...spawn, processId: 'second' };
			const second: ConsultObserver = { onActivity: vi.fn(), onSessionId: vi.fn(), onEnd: vi.fn() };
			for (const [input, listener] of [
				[spawn, observer],
				[other, second],
			] as const) {
				await runner.start(input, listener);
				turns.withWorktreeTurnActivity(
					(_, __, launch) => launch('agent', [], {}),
					() => {}
				);
			}
			const observations: number[] = [];
			vi.mocked(observer.onEnd).mockImplementation(() => {
				observations.push(active);
				children[0].emit('close');
				observations.push(active);
			});
			manager.emit('exit', spawn.processId, 0);
			expect(observations).toEqual([3, 2]);
			await blocked();
			manager.emit('session-id', other.processId, 'second-provider');
			expect(second.onSessionId).toHaveBeenCalledExactlyOnceWith('second-provider');
			manager.emit('exit', other.processId, 0);
			expect(second.onEnd).toHaveBeenCalledOnce();
			expect(manager.eventNames()).toEqual([]);
			await blocked();
			children[1].emit('error', new Error('not close'));
			children[1].emit('exit', 0);
			await blocked();
			children[1].emit('close');
			await idle();
		});
	});
});
