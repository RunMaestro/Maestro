/**
 * The one rule both Auto Run runners follow: no turn starts while work the run
 * delegated is still running, and the next turn receives each result once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	__resetAutoRunDelegationListenerForTests,
	awaitDelegationsBeforeTurn,
	beginAutoRunDelegations,
	countPendingAutoRunDelegations,
	endAutoRunDelegations,
	pendingDelegationsUpdater,
	settleDelegationsAtRunEnd,
	waitForAutoRunDelegations,
} from '../../../renderer/services/autoRunDelegations';
import { useAutoRunDelegationStore } from '../../../renderer/stores/autoRunDelegationStore';
import type { AutoRunDelegationEvent } from '../../../shared/autoRunDelegation';
import type { BatchRunState } from '../../../renderer/types';

let push: ((event: unknown) => void) | undefined;

function event(runId: string, overrides: Partial<AutoRunDelegationEvent>): AutoRunDelegationEvent {
	return {
		kind: 'started',
		autoRunId: runId,
		callbackId: 'cb_1',
		callerAgentId: 'manager',
		targetAgentId: 'worker',
		targetTabId: 'tab-1',
		targetName: 'Worker',
		prompt: 'build it',
		startedAt: 1,
		...overrides,
	};
}

describe('autoRunDelegations', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		push = undefined;
		__resetAutoRunDelegationListenerForTests();
		useAutoRunDelegationStore.setState({ runs: {} });
		window.maestro = {
			...window.maestro,
			autorun: {
				...window.maestro?.autorun,
				onDelegation: vi.fn((handler: (event: unknown) => void) => {
					push = handler;
					return () => {
						push = undefined;
					};
				}),
			},
		} as typeof window.maestro;
	});

	afterEach(() => {
		__resetAutoRunDelegationListenerForTests();
		vi.useRealTimers();
	});

	it('subscribes once and ignores malformed pushes', () => {
		const runId = beginAutoRunDelegations();
		beginAutoRunDelegations();
		expect(window.maestro.autorun.onDelegation).toHaveBeenCalledTimes(1);
		push!({ kind: 'started' });
		push!(event(runId, {}));
		expect(countPendingAutoRunDelegations(runId)).toBe(1);
	});

	it('resolves at once when nothing is pending', async () => {
		const runId = beginAutoRunDelegations();
		await expect(
			awaitDelegationsBeforeTurn(runId, { isStopRequested: () => false })
		).resolves.toEqual({
			stopped: false,
			results: [],
		});
	});

	it('waits until every delegation settles, then hands each result over once', async () => {
		const runId = beginAutoRunDelegations();
		push!(event(runId, { callbackId: 'a' }));
		push!(event(runId, { callbackId: 'b', targetName: 'Other' }));
		const onPendingChange = vi.fn();

		let resolved = false;
		const turn = awaitDelegationsBeforeTurn(runId, {
			isStopRequested: () => false,
			onPendingChange,
		}).then((r) => {
			resolved = true;
			return r;
		});
		expect(onPendingChange).toHaveBeenLastCalledWith([
			expect.objectContaining({ callbackId: 'a' }),
			expect.objectContaining({ callbackId: 'b' }),
		]);

		push!(event(runId, { kind: 'settled', callbackId: 'a', status: 'completed', output: 'A' }));
		await vi.advanceTimersByTimeAsync(0);
		expect(resolved).toBe(false);
		expect(onPendingChange).toHaveBeenLastCalledWith([
			expect.objectContaining({ callbackId: 'b' }),
		]);

		push!(event(runId, { kind: 'settled', callbackId: 'b', status: 'failed' }));
		const { stopped, results } = await turn;
		expect(stopped).toBe(false);
		expect(results.map((r) => [r.callbackId, r.status])).toEqual([
			['a', 'completed'],
			['b', 'failed'],
		]);
		expect(onPendingChange).toHaveBeenLastCalledWith([]);

		// Reported once: the turn after that gets nothing.
		const next = await awaitDelegationsBeforeTurn(runId, { isStopRequested: () => false });
		expect(next.results).toEqual([]);
	});

	it('ends the wait on a stop request, without consuming results', async () => {
		const runId = beginAutoRunDelegations();
		push!(event(runId, {}));
		let stop = false;
		const turn = awaitDelegationsBeforeTurn(runId, { isStopRequested: () => stop });
		stop = true;
		await vi.advanceTimersByTimeAsync(1000);
		await expect(turn).resolves.toEqual({ stopped: true, results: [] });
		expect(countPendingAutoRunDelegations(runId)).toBe(1);
	});

	it('keeps runs apart', async () => {
		const mine = beginAutoRunDelegations();
		const other = beginAutoRunDelegations();
		push!(event(other, {}));
		await expect(waitForAutoRunDelegations(mine, { isStopRequested: () => false })).resolves.toBe(
			'settled'
		);
	});

	it('collects what no turn received at run end, then forgets the run', async () => {
		const runId = beginAutoRunDelegations();
		push!(event(runId, {}));
		const end = settleDelegationsAtRunEnd(runId, { isStopRequested: () => false });
		push!(event(runId, { kind: 'settled', status: 'completed' }));
		await expect(end).resolves.toHaveLength(1);
		endAutoRunDelegations(runId);
		expect(useAutoRunDelegationStore.getState().runs[runId]).toBeUndefined();
	});

	it('publishes the pending list into batch state only for a live entry', () => {
		const pending = [
			{
				callbackId: 'a',
				targetAgentId: 'w',
				targetTabId: 't',
				targetName: 'W',
				subject: 's',
				startedAt: 1,
			},
		];
		const prev = { s1: { isRunning: true } as BatchRunState };
		expect(pendingDelegationsUpdater('s1', pending)(prev).s1.pendingDelegations).toBe(pending);
		expect(pendingDelegationsUpdater('missing', pending)(prev)).toBe(prev);
	});
});
