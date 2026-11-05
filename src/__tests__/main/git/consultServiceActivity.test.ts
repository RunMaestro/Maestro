import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import type {
	ConsultObserver,
	ConsultEnd,
	ConsultRunner,
} from '../../../shared/maestro-lib/agents/consult';
import type { CrossAgentRequest } from '../../../shared/crossAgentTypes';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));
vi.mock('../../../main/cross-agent/consult-runner', () => ({
	createDesktopConsultRunner: vi.fn(),
}));
vi.mock('../../../main/utils/maestro-system-prompt', () => ({
	buildMaestroSystemPromptForSession: vi.fn(async () => 'system'),
}));
import { createDesktopConsultRunner } from '../../../main/cross-agent/consult-runner';

describe('deferred desktop consult service admission', () => {
	const root = path.resolve('consult-service-target');
	const idleMs = 10 * 60 * 1000;
	const maxMs = 30 * 60 * 1000;
	let gate: typeof import('../../../main/git/worktreeActivity');
	let router: typeof import('../../../main/cross-agent/cross-agent-router');
	let library: typeof import('../../../shared/maestro-lib/agents/consult');
	let observer: ConsultObserver;
	let runner: ConsultRunner;
	let onChunk: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
	let report: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
	let warn: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
	let timers: MockInstance<typeof setTimeout>;
	let clears: MockInstance<typeof clearTimeout>;
	let releases: Array<() => void>;
	let active: number;
	const request = (id = 'request'): CrossAgentRequest => ({
		requestId: id,
		sourceSessionId: 'source',
		sourceTabId: 'tab',
		targetSessionId: 'target',
		userPrompt: 'question',
		transcript: [],
		strategy: { kind: 'full' },
		createdAt: 0,
	});
	const target = { id: 'target', name: 'Target', cwd: root, toolType: 'claude-code' as const };
	function options() {
		return {
			processManager: {} as never,
			sshStore: null,
			agentDetector: {
				getAgent: async () => ({
					id: 'claude-code',
					command: 'claude',
					args: [],
					available: true,
				}),
			} as never,
			getTargetSession: () => target,
			onChunk,
		};
	}
	function timer(ms: number) {
		const call = timers.mock.calls.find((args) => args[1] === ms);
		if (!call || typeof call[0] !== 'function') throw new Error('Missing watchdog callback');
		return call[0] as () => void;
	}
	async function reserve() {
		const hold = await gate.reserveWorktreeCleanup(root);
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		releases.push(hold.release);
		return hold;
	}
	async function start(id = 'request') {
		await router.startCrossAgentRequest(request(id), options());
		return observer;
	}
	const end = (): ConsultEnd => ({ exitCode: 0, readText: () => ' answer ' });
	beforeEach(async () => {
		vi.resetModules();
		vi.resetAllMocks();
		vi.useFakeTimers();
		releases = [];
		active = 0;
		vi.mocked(fs.realpath).mockImplementation(async (p) => String(p));
		gate = await import('../../../main/git/worktreeActivity');
		const begin = gate.beginGlobalWorktreeActivity;
		vi.spyOn(gate, 'beginGlobalWorktreeActivity').mockImplementation(() => {
			const release = begin();
			active++;
			let released = false;
			return () => {
				if (!released) active--;
				released = true;
				release();
			};
		});
		runner = {
			start: vi.fn(async (_spawn, next) => {
				observer = next;
				return { success: true };
			}),
			stop: vi.fn(() => ' partial '),
		};
		vi.mocked(createDesktopConsultRunner).mockReturnValue(runner);
		onChunk = vi.fn();
		report = vi.fn();
		warn = vi.fn();
		const host = await import('../../../shared/maestro-lib/host');
		host.setMaestroLibLogger({ info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() });
		host.setMaestroLibErrorReporter({ captureException: report, captureMessage: vi.fn() });
		library = await import('../../../shared/maestro-lib/agents/consult');
		router = await import('../../../main/cross-agent/cross-agent-router');
		timers = vi.spyOn(globalThis, 'setTimeout');
		clears = vi.spyOn(globalThis, 'clearTimeout');
	});
	afterEach(() => {
		for (const release of releases) release();
		warn.mockReset();
		onChunk.mockReset();
		vi.mocked(runner.stop).mockReturnValue('');
		router.cancelCrossAgentRequestsForSource('source');
		expect(active).toBe(0);
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it.each(['activity', 'session', 'end'] as const)(
		'refuses a late %s callback before service effects',
		async (kind) => {
			await start();
			const hold = await reserve();
			const read = vi.fn(() => {
				throw new Error('Unexpected result inspection');
			});
			const result = new Proxy(end(), { get: read });
			const before = timers.mock.calls.length;
			clears.mockClear();
			const invoke = () =>
				kind === 'activity'
					? observer.onActivity()
					: kind === 'session'
						? observer.onSessionId('forbidden')
						: observer.onEnd(result);
			expect(invoke).toThrow(/reserved/);
			expect(read).not.toHaveBeenCalled();
			expect(clears).not.toHaveBeenCalled();
			expect(timers.mock.calls).toHaveLength(before);
			for (const effect of [onChunk, runner.stop, report, warn])
				expect(effect).not.toHaveBeenCalled();
			expect(router.getCrossAgentConsultParties('request')).not.toBeNull();
			hold.release();
			observer.onEnd(end());
			expect(onChunk).toHaveBeenCalledWith(
				expect.objectContaining({ chunk: 'answer', done: true })
			);
			expect(onChunk.mock.calls[0][0]).not.toHaveProperty('targetAgentSessionId');
			await reserve();
		}
	);

	it.each([idleMs, maxMs])(
		'refuses the %i timer before settlement, cancellation or target lookup',
		async (ms) => {
			await start();
			const fire = timer(ms);
			const hold = await reserve();
			const name = vi.spyOn(target, 'name', 'get');
			clears.mockClear();
			expect(fire).toThrow(/reserved/);
			expect(name).not.toHaveBeenCalled();
			expect(clears).not.toHaveBeenCalled();
			expect(runner.stop).not.toHaveBeenCalled();
			expect(onChunk).not.toHaveBeenCalled();
			expect(router.getCrossAgentConsultParties('request')).not.toBeNull();
			hold.release();
			fire();
			expect(runner.stop).toHaveBeenCalledOnce();
			expect(onChunk).toHaveBeenCalledWith(
				expect.objectContaining({ done: true, chunk: 'partial', error: expect.any(String) })
			);
			expect(router.getCrossAgentConsultParties('request')).toBeNull();
			fire();
			expect(onChunk).toHaveBeenCalledOnce();
			await reserve();
		}
	);

	it('holds activity across watchdog touch, session continuity, parsing and terminal delivery', async () => {
		await start();
		timers.mockImplementationOnce(() => {
			expect(active).toBe(1);
			return vi.fn() as never;
		});
		observer.onActivity();
		observer.onSessionId('provider-id');
		onChunk.mockImplementation(() => expect(active).toBe(1));
		observer.onEnd({
			exitCode: 0,
			readText: () => {
				expect(active).toBe(1);
				return ' answer ';
			},
		});
		expect(onChunk).toHaveBeenCalledWith(
			expect.objectContaining({ targetAgentSessionId: 'provider-id' })
		);
		await reserve();
	});

	it.each([idleMs, maxMs])('holds the %i timer through stop, logging and delivery', async (ms) => {
		await start();
		vi.mocked(runner.stop).mockImplementation(() => {
			expect(active).toBe(1);
			return ' partial ';
		});
		warn.mockImplementation(() => expect(active).toBe(1));
		onChunk.mockImplementation(() => expect(active).toBe(1));
		timer(ms)();
		expect(onChunk).toHaveBeenCalledOnce();
		await reserve();
	});

	it.each(['parse', 'delivery'] as const)(
		'releases callback activity after %s failure and preserves reporting',
		async (kind) => {
			await start();
			const failure = new Error(kind);
			report.mockImplementation(() => expect(active).toBe(1));
			if (kind === 'delivery')
				onChunk.mockImplementation(() => {
					expect(active).toBe(1);
					throw failure;
				});
			const result = {
				exitCode: 0,
				readText: () => {
					expect(active).toBe(1);
					if (kind === 'parse') throw failure;
					return 'answer';
				},
			};
			if (kind === 'delivery') expect(() => observer.onEnd(result)).toThrow(failure);
			else observer.onEnd(result);
			expect(report).toHaveBeenCalledWith(
				failure,
				expect.objectContaining({ operation: 'crossAgent:parseResponse' })
			);
			await reserve();
		}
	);

	it.each(['stop', 'logging', 'delivery'] as const)(
		'preserves timer %s failures without leaking dispatch activity',
		async (kind) => {
			await start();
			const failure = new Error(kind);
			const fail = () => {
				expect(active).toBe(1);
				throw failure;
			};
			if (kind === 'stop') vi.mocked(runner.stop).mockImplementation(fail);
			if (kind === 'logging') warn.mockImplementation(fail);
			if (kind === 'delivery') onChunk.mockImplementation(fail);
			if (kind === 'stop') {
				timer(idleMs)();
				expect(onChunk).toHaveBeenCalledOnce();
			} else expect(timer(idleMs)).toThrow(failure);
			expect(router.getCrossAgentConsultParties('request')).toBeNull();
			await reserve();
		}
	);

	it('keeps an independent native hold after terminal reporting and reentrant cancellation', async () => {
		await start();
		const releaseNative = gate.beginGlobalWorktreeActivity();
		releases.push(releaseNative);
		onChunk.mockImplementation(() => {
			expect(active).toBe(2);
			expect(router.cancelCrossAgentRequestsForSource('source')).toBe(0);
			expect(active).toBe(2);
		});
		observer.onEnd(end());
		expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
		releaseNative();
		await reserve();
	});

	it('keeps pending start independent when an early end callback settles the service', async () => {
		let finish!: () => void;
		vi.mocked(runner.start).mockImplementation(async (_spawn, next) => {
			observer = next;
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return { success: true };
		});
		const pending = router.startCrossAgentRequest(request(), options());
		await Promise.resolve();
		await Promise.resolve();
		observer.onEnd(end());
		expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
		finish();
		await pending;
		expect(runner.stop).toHaveBeenCalledOnce();
		await reserve();
	});

	it('keeps default portable service behavior independent of desktop reservations', async () => {
		const portable = library.createConsultService();
		await portable.start(request('portable'), {
			...options(),
			runner,
			resolveAgent: async () =>
				({ id: 'claude-code', command: 'claude', args: [], available: true }) as never,
		});
		const hold = await reserve();
		observer.onEnd(end());
		expect(onChunk).toHaveBeenCalledOnce();
		expect(portable.activeCount()).toBe(0);
		hold.release();
		await reserve();
	});
});
