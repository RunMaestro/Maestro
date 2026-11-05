import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import type {
	ConsultObserver,
	ConsultEnd,
	ConsultRunner,
} from '../../../shared/maestro-lib/agents/consult';
import type { CrossAgentRequest } from '../../../shared/crossAgentTypes';
import type { StartCrossAgentRequestOptions } from '../../../main/cross-agent/cross-agent-router';

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
	let scheduleTimeout: typeof setTimeout;
	let clearScheduledTimeout: typeof clearTimeout;
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
			const trackedRelease = () => {
				if (!released) active--;
				released = true;
				release();
			};
			return trackedRelease;
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
		scheduleTimeout = globalThis.setTimeout;
		clearScheduledTimeout = globalThis.clearTimeout;
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
		'refuses a settled late %s callback before service effects',
		async (kind) => {
			await start();
			observer.onEnd(end());
			onChunk.mockClear();
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
			expect(router.getCrossAgentConsultParties('request')).toBeNull();
			hold.release();
			observer.onEnd(end());
			expect(onChunk).not.toHaveBeenCalled();
			await reserve();
		}
	);

	it.each([idleMs, maxMs])(
		'refuses a settled %i timer before cancellation or target lookup',
		async (ms) => {
			await start();
			const fire = timer(ms);
			observer.onEnd(end());
			onChunk.mockClear();
			const hold = await reserve();
			const name = vi.spyOn(target, 'name', 'get');
			clears.mockClear();
			expect(fire).toThrow(/reserved/);
			expect(name).not.toHaveBeenCalled();
			expect(clears).not.toHaveBeenCalled();
			expect(runner.stop).not.toHaveBeenCalled();
			expect(onChunk).not.toHaveBeenCalled();
			expect(router.getCrossAgentConsultParties('request')).toBeNull();
			hold.release();
			fire();
			expect(runner.stop).not.toHaveBeenCalled();
			expect(router.getCrossAgentConsultParties('request')).toBeNull();
			fire();
			expect(onChunk).not.toHaveBeenCalled();
			await reserve();
		}
	);

	it('holds activity across watchdog touch, session continuity, parsing and terminal delivery', async () => {
		await start();
		timers.mockImplementationOnce(() => {
			expect(active).toBe(2);
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

	describe('preparation recovery', () => {
		it.each(['target', 'provider', 'prompt', 'config', 'args', 'overrides'] as const)(
			'releases only its owned registration after %s preparation throws',
			async (stage) => {
				const failure = new Error(stage);
				const fail = vi.fn(() => {
					throw failure;
				});
				const opts: StartCrossAgentRequestOptions = options();
				if (stage === 'target') opts.getTargetSession = fail;
				if (stage === 'provider') opts.agentDetector = { getAgent: fail } as never;
				if (stage === 'config') opts.getAgentConfig = fail;
				if (stage === 'prompt') {
					const prompts = await import('../../../shared/maestro-lib/agents/consult-prompt');
					vi.spyOn(prompts, 'buildCrossAgentPrompt').mockImplementation(fail);
				}
				if (stage === 'args' || stage === 'overrides') {
					const args = await import('../../../shared/maestro-lib/launch/agent-args');
					vi.spyOn(
						args,
						stage === 'args' ? 'buildAgentArgs' : 'applyAgentConfigOverrides'
					).mockImplementation(fail);
				}
				await expect(router.startCrossAgentRequest(request(), opts)).rejects.toBe(failure);
				expect(fail).toHaveBeenCalledOnce();
				expect(router.getCrossAgentConsultParties('request')).toBeNull();
				expect(router.cancelCrossAgentRequestsForSource('source')).toBe(0);
				expect(runner.start).not.toHaveBeenCalled();
				expect(runner.stop).not.toHaveBeenCalled();
				expect(vi.getTimerCount()).toBe(0);
				expect(onChunk).not.toHaveBeenCalled();
				await reserve();
			}
		);

		it.each(['target', 'ssh', 'provider'] as const)(
			'cleans an early %s refusal even when logging or delivery throws',
			async (stage) => {
				for (const reporting of [warn, onChunk]) {
					const opts: StartCrossAgentRequestOptions = options();
					if (stage === 'target') opts.getTargetSession = () => null;
					if (stage === 'ssh')
						opts.getTargetSession = () => ({
							...target,
							sshRemoteConfig: { enabled: true, remoteId: 'remote' },
						});
					if (stage === 'provider') opts.agentDetector = { getAgent: async () => null } as never;
					const failure = new Error('reporting failed');
					reporting.mockImplementationOnce(() => {
						expect(active).toBe(2);
						throw failure;
					});
					await expect(router.startCrossAgentRequest(request(), opts)).rejects.toBe(failure);
					expect(router.getCrossAgentConsultParties('request')).toBeNull();
					expect(active).toBe(0);
					const hold = await reserve();
					hold.release();
				}
				expect(runner.start).not.toHaveBeenCalled();
				expect(vi.getTimerCount()).toBe(0);
			}
		);

		it.each(['success', 'failure'] as const)(
			'keeps pending cancellation recoverable when provider resolution ends in %s',
			async (outcome) => {
				const detection = Promise.withResolvers<never>();
				const opts = {
					...options(),
					agentDetector: { getAgent: () => detection.promise } as never,
				};
				const pending = router.startCrossAgentRequest(request(), opts);
				const failure = new Error('resolution failed');
				const result = outcome === 'failure' ? expect(pending).rejects.toBe(failure) : pending;
				const pendingActivity = active;
				expect(router.cancelCrossAgentRequestsForSource('source')).toBe(1);
				expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
				if (outcome === 'failure') detection.reject(failure);
				else detection.resolve({ command: 'claude', args: [], available: true } as never);
				await result;
				expect(pendingActivity).toBe(2);
				expect(router.getCrossAgentConsultParties('request')).toBeNull();
				expect(runner.start).not.toHaveBeenCalled();
				expect(runner.stop).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
				expect(onChunk).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
				if (outcome === 'success')
					expect(onChunk).toHaveBeenCalledWith(expect.objectContaining({ canceled: true }));
				expect(vi.getTimerCount()).toBe(0);
				await reserve();
			}
		);

		it('preserves a supervised successor when older preparation rejects', async () => {
			const detection = Promise.withResolvers<never>();
			const pending = router.startCrossAgentRequest(request(), {
				...options(),
				agentDetector: { getAgent: () => detection.promise } as never,
			});
			const failure = new Error('old resolution failed');
			const result = expect(pending).rejects.toBe(failure);
			await start();
			const overlappingActivity = active;
			detection.reject(failure);
			await result;
			expect(overlappingActivity).toBe(3);
			expect(active).toBe(1);
			expect(router.getCrossAgentConsultParties('request')).not.toBeNull();
			expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			observer.onEnd(end());
			await reserve();
		});

		it('preserves a replacement started reentrantly by failing early reporting', async () => {
			const failure = new Error('logger failed');
			let replacement: Promise<ConsultObserver> | undefined;
			warn.mockImplementationOnce(() => {
				expect(active).toBe(2);
				replacement = start();
				throw failure;
			});
			await expect(
				router.startCrossAgentRequest(request(), { ...options(), getTargetSession: () => null })
			).rejects.toBe(failure);
			await replacement;
			expect(active).toBe(1);
			expect(router.getCrossAgentConsultParties('request')).not.toBeNull();
			observer.onEnd(end());
			await reserve();
		});

		it('never releases an independent native hold after preparation failure', async () => {
			const releaseNative = gate.beginGlobalWorktreeActivity();
			releases.push(releaseNative);
			const failure = new Error('provider failed');
			await expect(
				router.startCrossAgentRequest(request(), {
					...options(),
					agentDetector: {
						getAgent: async () => {
							throw failure;
						},
					} as never,
				})
			).rejects.toBe(failure);
			expect(router.getCrossAgentConsultParties('request')).toBeNull();
			expect(active).toBe(1);
			expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			releaseNative();
			await reserve();
		});

		it('admits standalone host preparation before target access and retains it while resolving', async () => {
			const service = library.createConsultService(undefined, gate.beginGlobalWorktreeActivity);
			const detection = Promise.withResolvers<never>();
			let preparationActivity = 0;
			const pending = service.start(request(), {
				...options(),
				runner,
				getTargetSession: () => {
					preparationActivity = active;
					return target;
				},
				resolveAgent: () => detection.promise,
			});
			const failure = new Error('resolution failed');
			const result = expect(pending).rejects.toBe(failure);
			const reservation = await gate.reserveWorktreeCleanup(root);
			if (reservation.status === 'reserved-partially') releases.push(reservation.release);
			detection.reject(failure);
			await result;
			expect(preparationActivity).toBe(1);
			expect(reservation).toMatchObject({ status: 'blocked' });
			expect(service.activeCount()).toBe(0);
			expect(runner.start).not.toHaveBeenCalled();
			await reserve();
		});

		it('refuses standalone host admission before options, registration or recovery', async () => {
			const service = library.createConsultService(undefined, gate.beginGlobalWorktreeActivity);
			const inspect = vi.fn(() => {
				throw new Error('Unexpected option access');
			});
			const opts = new Proxy({} as never, { get: inspect });
			await reserve();
			await expect(service.start(request(), opts)).rejects.toThrow(/reserved/);
			expect(inspect).not.toHaveBeenCalled();
			expect(service.activeCount()).toBe(0);
			for (const effect of [runner.start, runner.stop, onChunk, warn, report])
				expect(effect).not.toHaveBeenCalled();
		});
	});

	describe('retained supervision', () => {
		it.each([root, path.join(root, 'child'), path.resolve('other-repository')])(
			'blocks %s between callbacks after start has settled',
			async (candidate) => {
				await start();
				expect(active).toBe(1);
				observer.onActivity();
				observer.onSessionId('continuity');
				expect(await gate.reserveWorktreeCleanup(candidate)).toMatchObject({
					status: 'blocked',
					blockers: [{ code: 'mutation-busy' }],
				});
				observer.onEnd(end());
				await reserve();
			}
		);

		it.each(['end', 'cancel', 'idle', 'max', 'refused', 'throw'] as const)(
			'releases its own supervision after %s with no residual timers',
			async (kind) => {
				if (kind === 'refused') vi.mocked(runner.start).mockResolvedValue({ success: false });
				if (kind === 'throw') vi.mocked(runner.start).mockRejectedValue(new Error('spawn failed'));
				await start();
				if (kind !== 'refused' && kind !== 'throw') expect(active).toBe(1);
				if (kind === 'end') observer.onEnd(end());
				if (kind === 'cancel') router.cancelCrossAgentRequestsForSource('source');
				if (kind === 'idle') timer(idleMs)();
				if (kind === 'max') timer(maxMs)();
				expect(active).toBe(0);
				expect(vi.getTimerCount()).toBe(0);
				expect(router.getCrossAgentConsultParties('request')).toBeNull();
				expect(onChunk).toHaveBeenCalledOnce();
				await reserve();
			}
		);

		it('keeps concurrent requests independent when cancellation selects one tab', async () => {
			const first = await start('first');
			await router.startCrossAgentRequest(
				{ ...request('second'), sourceTabId: 'other-tab' },
				options()
			);
			const second = observer;
			expect(active).toBe(2);
			expect(router.cancelCrossAgentRequestsForSource('source', 'tab')).toBe(1);
			expect(active).toBe(1);
			first.onEnd(end());
			expect(active).toBe(1);
			expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			second.onEnd(end());
			await reserve();
		});

		it('cannot delete a successor registration when an older request ends', async () => {
			const first = await start();
			await start();
			first.onEnd(end());
			expect(router.getCrossAgentConsultParties('request')).not.toBeNull();
			expect(active).toBe(1);
			expect(router.cancelCrossAgentRequestsForSource('source')).toBe(1);
			expect(active).toBe(0);
			await reserve();
		});

		it('keeps a replacement registered when an older pending spawn is refused', async () => {
			const spawn = Promise.withResolvers<{ success: boolean }>();
			vi.mocked(runner.start).mockReturnValueOnce(spawn.promise);
			const pending = router.startCrossAgentRequest(request(), options());
			await vi.waitFor(() => expect(runner.start).toHaveBeenCalledOnce());
			await start();
			spawn.resolve({ success: false });
			await pending;
			expect(router.getCrossAgentConsultParties('request')).not.toBeNull();
			expect(active).toBe(1);
			observer.onEnd(end());
			await reserve();
		});

		it('retains supervision while a terminal observer starts a replacement request', async () => {
			const first = await start();
			let pending: Promise<void> | undefined;
			onChunk.mockImplementationOnce(() => {
				expect(active).toBe(1); // independent callback scope
				pending = router.startCrossAgentRequest(request(), options());
			});
			first.onEnd(end());
			await pending;
			expect(active).toBe(1);
			expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			observer.onEnd(end());
			await reserve();
		});

		it.each([1, 2])('rolls back timer setup %i without replacing its rejection', async (nth) => {
			const schedule = scheduleTimeout;
			let count = 0;
			const failure = new Error('timer setup failed');
			timers.mockImplementation((...args) => {
				expect(active).toBe(2); // request setup and retained supervision
				if (++count === nth) throw failure;
				return schedule(...args);
			});
			await expect(start()).rejects.toBe(failure);
			expect(active).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
			expect(runner.start).not.toHaveBeenCalled();
			expect(router.getCrossAgentConsultParties('request')).toBeNull();
			for (const effect of [runner.stop, onChunk, report]) expect(effect).not.toHaveBeenCalled();
			await reserve();
		});

		it.each([1, 2])('retains the registration when timer disarm %i throws', async (nth) => {
			await start();
			const clear = clearScheduledTimeout;
			let count = 0;
			const failure = new Error('timer clear failed');
			clears.mockImplementation((handle) => {
				if (++count === nth) throw failure;
				clear(handle);
			});
			expect(() => observer.onEnd(end())).toThrow(failure);
			expect(router.getCrossAgentConsultParties('request')).not.toBeNull();
			expect(active).toBe(1);
			expect(onChunk).not.toHaveBeenCalled();
			expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			observer.onEnd(end());
			expect(vi.getTimerCount()).toBe(0);
			expect(onChunk).toHaveBeenCalledOnce();
			expect(active).toBe(0);
			await reserve();
		});

		it.each(['normal', 'throw', 'replace'] as const)(
			'keeps failed setup cleanup reachable when diagnostics %s',
			async (reporting) => {
				const setupError = new Error('idle timer setup failed');
				const cleanupError = new Error('rollback failed');
				timers.mockImplementationOnce(scheduleTimeout).mockImplementationOnce(() => {
					throw setupError;
				});
				clears.mockImplementation(() => {
					throw cleanupError;
				});
				let replacement: Promise<ConsultObserver> | undefined;
				report.mockImplementation(() => {
					expect(active).toBe(2);
					if (reporting === 'throw') throw new Error('reporting failed');
					if (reporting === 'replace') replacement = start();
				});
				await expect(start()).rejects.toBe(setupError);
				await replacement;
				expect(report).toHaveBeenCalledWith(
					cleanupError,
					expect.objectContaining({
						operation: 'crossAgent:watchdogCleanup',
					})
				);
				expect(router.getCrossAgentConsultParties('request')).not.toBeNull();
				expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
				// Re-deliver the retained timer after native clearing becomes available.
				// Its obsolete terminal action must not stop/report a successor.
				clears.mockImplementation(clearScheduledTimeout);
				timer(maxMs)();
				expect(runner.stop).not.toHaveBeenCalled();
				expect(onChunk).not.toHaveBeenCalled();
				if (reporting === 'replace') {
					observer.onEnd(end());
					expect(active).toBe(1); // old disposal remains independent
				}
				expect(router.cancelCrossAgentRequestsForSource('source')).toBe(1);
				expect(active).toBe(0);
				expect(vi.getTimerCount()).toBe(0);
				await reserve();
			}
		);

		it.each(['cancel', 'idle', 'max'] as const)(
			'retries failed %s timer disposal before stopping or reporting once',
			async (kind) => {
				await start();
				const failure = new Error('disarm failed');
				clears.mockImplementationOnce(() => {
					throw failure;
				});
				const terminate = () =>
					kind === 'cancel'
						? router.cancelCrossAgentRequestsForSource('source')
						: timer(kind === 'idle' ? idleMs : maxMs)();
				expect(terminate).toThrow(failure);
				for (const effect of [runner.stop, onChunk, report, warn])
					expect(effect).not.toHaveBeenCalled();
				expect(active).toBe(1);
				expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
				expect(router.cancelCrossAgentRequestsForSource('source')).toBe(1);
				expect(runner.stop).toHaveBeenCalledOnce();
				expect(onChunk).toHaveBeenCalledOnce();
				expect(onChunk).toHaveBeenCalledWith(expect.objectContaining({ canceled: true }));
				observer.onEnd(end());
				expect(onChunk).toHaveBeenCalledOnce();
				expect(vi.getTimerCount()).toBe(0);
				await reserve();
			}
		);

		it('retains the outer request and native hold during asynchronous cleanup diagnostics', async () => {
			const releaseNative = gate.beginGlobalWorktreeActivity();
			releases.push(releaseNative);
			const diagnostics = Promise.withResolvers<void>();
			const failure = new Error('timer setup failed');
			timers.mockImplementationOnce(scheduleTimeout).mockImplementationOnce(() => {
				throw failure;
			});
			clears.mockImplementationOnce(() => {
				throw new Error('rollback failed');
			});
			report.mockImplementationOnce(() => diagnostics.promise);
			const pending = start();
			const result = expect(pending).rejects.toBe(failure);
			await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
			expect(router.cancelCrossAgentRequestsForSource('source')).toBe(1);
			expect(active).toBe(2); // native and outer request remain independent
			expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			diagnostics.reject(new Error('asynchronous reporter failed'));
			await result;
			expect(active).toBe(1);
			releaseNative();
			await reserve();
		});

		it.each(['cancel', 'cancelAll'] as const)(
			'reaches replaced failed disposals through portable %s',
			async (method) => {
				const service = library.createConsultService(undefined, gate.beginGlobalWorktreeActivity);
				const opts = {
					...options(),
					runner,
					resolveAgent: async () =>
						({
							id: 'claude-code',
							command: 'claude',
							args: [],
							available: true,
						}) as never,
				};
				timers.mockImplementationOnce(scheduleTimeout).mockImplementationOnce(() => {
					throw new Error('setup failed');
				});
				clears.mockImplementationOnce(() => {
					throw new Error('rollback failed');
				});
				await expect(service.start(request(), opts)).rejects.toThrow('setup failed');
				await service.start({ ...request(), sourceTabId: 'successor-tab' }, opts);
				expect(service.activeCount()).toBe(2);
				expect(service[method]('request')).toBeTruthy();
				expect(service.activeCount()).toBe(0);
				expect(runner.stop).toHaveBeenCalledOnce();
				expect(onChunk).toHaveBeenCalledOnce();
				expect(vi.getTimerCount()).toBe(0);
				await reserve();
			}
		);

		it('does not reenter terminal delivery while disarming timers', async () => {
			await start();
			clears.mockImplementationOnce((handle) => {
				observer.onActivity();
				observer.onEnd(end());
				router.cancelCrossAgentRequestsForSource('source');
				clearScheduledTimeout(handle);
			});
			observer.onEnd(end());
			expect(onChunk).toHaveBeenCalledOnce();
			expect(runner.stop).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			await reserve();
		});

		it('recovers an old disarm without removing or stopping its successor', async () => {
			const first = await start();
			clears.mockImplementationOnce(() => {
				throw new Error('clear failed');
			});
			expect(() => first.onEnd(end())).toThrow('clear failed');
			await router.startCrossAgentRequest({ ...request(), sourceTabId: 'successor' }, options());
			expect(router.cancelCrossAgentRequestsForSource('source', 'tab')).toBe(1);
			expect(runner.stop).not.toHaveBeenCalled();
			expect(router.getCrossAgentConsultParties('request')).not.toBeNull();
			expect(active).toBe(1);
			expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			observer.onEnd(end());
			expect(active).toBe(0);
			await reserve();
		});

		it('refuses uncertain termination recovery after replacement until the old native end', async () => {
			const first = await start();
			clears.mockImplementationOnce(() => {
				throw new Error('disarm failed');
			});
			expect(() => router.cancelCrossAgentRequestsForSource('source')).toThrow('disarm failed');
			await router.startCrossAgentRequest({ ...request(), sourceTabId: 'successor' }, options());
			clears.mockClear();
			expect(() => router.cancelCrossAgentRequestsForSource('source', 'tab')).toThrow(/replaced/);
			expect(clears).not.toHaveBeenCalled();
			expect(runner.stop).not.toHaveBeenCalled();
			expect(onChunk).not.toHaveBeenCalled();
			expect(active).toBe(2);
			expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			first.onEnd(end());
			expect(active).toBe(1);
			expect(router.getCrossAgentConsultParties('request')).not.toBeNull();
			observer.onEnd(end());
			await reserve();
		});

		it('does not release a concurrent request after terminal reporting throws', async () => {
			const first = await start('first');
			await start('second');
			const failure = new Error('delivery failed');
			onChunk.mockImplementation(() => {
				throw failure;
			});
			expect(() => first.onEnd(end())).toThrow(failure);
			expect(active).toBe(1);
			expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
			onChunk.mockReset();
			observer.onEnd(end());
			await reserve();
		});
	});
});
