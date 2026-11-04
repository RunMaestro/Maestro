import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import fixture from '../../fixtures/harness-control/interactions.json';
import type { HarnessInteractionOpenRequest } from '../../../shared/harness-control/types';
import type { InteractionBrokerHandlers } from '../../../main/harness-control/InteractionBroker';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));

const permission = fixture.permission as HarnessInteractionOpenRequest;

describe('standalone native interaction broker activity', () => {
	const target = path.resolve('broker-target');
	let gate: typeof import('../../../main/git/worktreeActivity');
	let broker: InstanceType<
		typeof import('../../../main/harness-control/InteractionBroker').InteractionBroker
	>;
	let onRequest: ReturnType<typeof vi.fn<InteractionBrokerHandlers['onRequest']>>;
	let onSettled: ReturnType<typeof vi.fn<InteractionBrokerHandlers['onSettled']>>;
	let releases: Array<() => void>;
	let active: number;
	let retained: number;
	async function reserve(root = target) {
		const hold = await gate.reserveWorktreeCleanup(root);
		if (hold.status === 'reserved-partially') releases.push(hold.release);
		return hold;
	}
	async function idle(root = target) {
		const hold = await reserve(root);
		expect(hold.status).toBe('reserved-partially');
		if (hold.status !== 'reserved-partially') throw new Error('Expected partial reservation');
		expect(hold.blockers.map((b) => b.message).join(' ')).toMatch(/native.*registration.*OS/);
		return hold;
	}
	async function busy() {
		expect(await reserve()).toMatchObject({
			status: 'blocked',
			blockers: [{ code: 'mutation-busy' }],
		});
	}
	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		releases = [];
		active = 0;
		retained = 0;
		vi.mocked(fs.realpath)
			.mockReset()
			.mockImplementation(async (p) => String(p));
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
		onRequest = vi.fn<InteractionBrokerHandlers['onRequest']>(() => true);
		onSettled = vi.fn<InteractionBrokerHandlers['onSettled']>();
		const { InteractionBroker } = await import('../../../main/harness-control/InteractionBroker');
		broker = new InteractionBroker({ onRequest, onSettled });
	});
	afterEach(() => {
		for (const release of releases) release();
		vi.restoreAllMocks();
		broker.closeAll();
		expect(active).toBe(retained);
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it.each([target, path.join(target, 'child'), path.resolve('other-repository')])(
		'refuses open before input inspection, timers or delivery under %s',
		async (root) => {
			const hold = await idle(root);
			const inspect = vi.fn(() => {
				throw new Error('input read');
			});
			const input = Object.defineProperty({}, 'kind', { enumerable: true, get: inspect });
			const timer = vi.spyOn(globalThis, 'setTimeout');
			expect(() => broker.open(input as HarnessInteractionOpenRequest)).toThrow(/reserved/);
			expect(inspect).not.toHaveBeenCalled();
			expect(timer).not.toHaveBeenCalled();
			expect(onRequest).not.toHaveBeenCalled();
			expect(broker.pendingRequests()).toEqual([]);
			hold.release();
			broker.open(permission);
			await busy();
		}
	);

	it.each(['resolve', 'withdraw', 'session', 'all'])(
		'refuses %s before validation or cancellation even for no-op requests, then permits retry',
		async (operation) => {
			const hold = await idle();
			const inspect = vi.fn(() => {
				throw new Error('response read');
			});
			const response = Object.defineProperty({}, 'requestId', { enumerable: true, get: inspect });
			const cancel = vi.spyOn(globalThis, 'clearTimeout');
			const invoke = () =>
				operation === 'resolve'
					? broker.resolve(response)
					: operation === 'withdraw'
						? broker.withdraw('missing')
						: operation === 'session'
							? broker.closeSession(permission.sessionId)
							: broker.closeAll();
			expect(invoke).toThrow(/reserved/);
			expect(inspect).not.toHaveBeenCalled();
			expect(cancel).not.toHaveBeenCalled();
			expect(onSettled).not.toHaveBeenCalled();
			hold.release();
			const opened = broker.open(permission);
			if (operation === 'resolve')
				broker.resolve({
					requestId: opened.request.requestId,
					outcome: 'selected',
					optionId: 'allow',
				});
			else if (operation === 'withdraw') broker.withdraw(opened.request.requestId);
			else invoke();
			await opened.completion;
			await idle();
		}
	);

	it('admits synchronously before pending reservation canonicalization and holds pending work', async () => {
		const canonical = Promise.withResolvers<string>();
		vi.mocked(fs.realpath).mockReturnValueOnce(canonical.promise);
		const reservation = reserve();
		const opened = broker.open(permission);
		canonical.resolve(target);
		expect(await reservation).toMatchObject({ status: 'blocked' });
		expect(
			broker.resolve({
				requestId: opened.request.requestId,
				outcome: 'selected',
				optionId: 'unknown',
			})
		).toBe('invalid-response');
		await busy();
		broker.withdraw(opened.request.requestId);
		await idle();
	});

	it.each(['resolve', 'withdraw', 'session', 'all', 'timeout'])(
		'holds decisions and timers through %s, then releases without claiming complete coverage',
		async (operation) => {
			const opened = broker.open(permission, 20);
			await busy();
			if (operation === 'resolve')
				broker.resolve({
					requestId: opened.request.requestId,
					outcome: 'selected',
					optionId: 'allow',
				});
			else if (operation === 'withdraw') broker.withdraw(opened.request.requestId);
			else if (operation === 'session')
				broker.closeSession(permission.sessionId, permission.spawnGeneration);
			else if (operation === 'all') broker.closeAll();
			else vi.advanceTimersByTime(20);
			await expect(opened.completion).resolves.toMatchObject({
				outcome: operation === 'resolve' ? 'selected' : 'cancelled',
			});
			expect(onSettled).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
			await idle();
		}
	);

	it('keeps independent generations busy until every request settles', async () => {
		broker.open(permission);
		const second = broker.open({ ...permission, spawnGeneration: 2 });
		expect(broker.closeSession(permission.sessionId, 1)).toBe(1);
		await busy();
		expect(broker.pendingRequests()).toEqual([second.request]);
		broker.withdraw(second.request.requestId);
		await idle();
	});

	it.each(['return', 'throw'])(
		'keeps synchronous setup busy after reentrant settlement and owner %s',
		async (behavior) => {
			let duringDelivery = 0;
			onRequest.mockImplementationOnce((request) => {
				broker.withdraw(request.requestId);
				duringDelivery = active;
				if (behavior === 'throw') throw new Error('detached owner');
				return true;
			});
			const opened = broker.open(permission);
			expect(duringDelivery).toBeGreaterThan(0);
			expect(broker.pendingRequests()).toEqual([]);
			await expect(opened.completion).resolves.toEqual({
				outcome: 'cancelled',
				reason: 'withdrawn',
			});
			expect(onSettled).toHaveBeenCalledOnce();
			await idle();
		}
	);

	it.each([false, 'throw'])(
		'retires unavailable owner work (%s) with cancellation and no retained timer',
		async (behavior) => {
			let duringDelivery = 0;
			onRequest.mockImplementationOnce(() => {
				duringDelivery = active;
				if (behavior === 'throw') throw new Error('owner unavailable');
				return false;
			});
			await expect(broker.open(permission).completion).resolves.toEqual({
				outcome: 'cancelled',
				reason: 'owner-unavailable',
			});
			expect(duringDelivery).toBeGreaterThan(0);
			expect(vi.getTimerCount()).toBe(0);
			await idle();
		}
	);

	it('keeps reentrant settlement callbacks and new requests independent of the closing snapshot', async () => {
		broker.open(permission);
		let duringSettlement = 0;
		onSettled.mockImplementationOnce(() => {
			duringSettlement = active;
			broker.open({ ...permission, spawnGeneration: 2 });
			throw new Error('detached settlement owner');
		});
		broker.closeAll();
		expect(duringSettlement).toBeGreaterThan(0);
		expect(broker.pendingRequests()).toHaveLength(1);
		await busy();
		broker.closeAll();
		await idle();
	});

	it('releases validation failure without creating timer work and preserves the original error', async () => {
		const error = new Error('request getter failed');
		const input = Object.defineProperty({}, 'kind', {
			enumerable: true,
			get: () => {
				throw error;
			},
		});
		expect(() => broker.open(input as HarnessInteractionOpenRequest)).toThrow(error);
		expect(vi.getTimerCount()).toBe(0);
		await idle();
	});

	it.each([false, true])(
		'keeps uncertain registration busy and retires only a reachable owner (inserted: %s)',
		async (inserted) => {
			const error = new Error('pending insertion failed');
			const set = Map.prototype.set;
			const insertion = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
				this: Map<unknown, unknown>,
				key,
				value
			) {
				if (value && typeof value === 'object' && 'request' in value && 'release' in value) {
					if (inserted) set.call(this, key, value);
					throw error;
				}
				return set.call(this, key, value);
			});
			expect(() => broker.open(permission, 20)).toThrow(error);
			insertion.mockRestore();
			expect(onRequest).not.toHaveBeenCalled();
			await busy();
			vi.advanceTimersByTime(20);
			if (inserted) {
				expect(onSettled).toHaveBeenCalledOnce();
				await idle();
			} else {
				retained = 1;
				expect(onSettled).not.toHaveBeenCalled();
				await busy();
			}
		}
	);

	it.each(['create', 'unref', 'cancel'])(
		'keeps uncertain timer %s failures busy after the original operation throws',
		async (step) => {
			const error = new Error(`timer ${step} failed`);
			if (step === 'create')
				vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(() => {
					throw error;
				});
			if (step === 'unref') {
				const create = globalThis.setTimeout;
				vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(((
					...args: Parameters<typeof setTimeout>
				) => {
					const timer = create(...args);
					vi.spyOn(timer, 'unref').mockImplementationOnce(() => {
						throw error;
					});
					return timer;
				}) as typeof setTimeout);
			}
			if (step === 'cancel') {
				const opened = broker.open(permission, 20);
				vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => {
					throw error;
				});
				expect(() => broker.withdraw(opened.request.requestId)).toThrow(error);
			} else expect(() => broker.open(permission, 20)).toThrow(error);
			retained = 1;
			await busy();
			vi.advanceTimersByTime(20);
			await busy();
			expect(onSettled).not.toHaveBeenCalled();
		}
	);
});
