/**
 * @file dispatch-callback-service.test.ts
 * @description End-to-end wiring: Auto Run finality in, queued wake-up turn out.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
	initDispatchCallbacks,
	getDispatchCallbackRegistry,
	disposeDispatchCallbacks,
} from '../../../main/dispatch-callbacks/dispatch-callback-service';
import { buildProcessSessionId } from '../../../main/dispatch-callbacks/dispatch-callback-registry';
import {
	getAutoRunStateTracker,
	resetAutoRunStateTracker,
} from '../../../main/autorun/autorun-state-tracker';

const KEY = buildProcessSessionId('target', 'tab-1');

function armOne() {
	return getDispatchCallbackRegistry()!.register({
		targetAgentId: 'target',
		targetTabId: 'tab-1',
		callerAgentId: 'caller',
		timeoutMs: 60_000,
		prompt: 'go',
	});
}

describe('dispatch callback service', () => {
	let enqueue: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		resetAutoRunStateTracker();
		enqueue = vi.fn().mockResolvedValue({ success: true });
		initDispatchCallbacks({ enqueue });
	});

	afterEach(() => {
		disposeDispatchCallbacks();
		resetAutoRunStateTracker();
		vi.useRealTimers();
	});

	it('delivers the wake-up turn through the caller execution queue', async () => {
		armOne();
		getDispatchCallbackRegistry()!.noteSpawn(KEY);
		getDispatchCallbackRegistry()!.noteExit(KEY, 0);

		await vi.advanceTimersByTimeAsync(5000);
		await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));

		const [agentId, prompt, tabId] = enqueue.mock.calls[0];
		expect(agentId).toBe('caller');
		expect(tabId).toBeUndefined();
		expect(prompt).toContain('[Maestro dispatch callback]');
		expect(prompt).toContain('Tab handle: tab-1');
	});

	it('waits for the Auto Run finality edge instead of firing per task', async () => {
		armOne();
		const tracker = getAutoRunStateTracker();
		tracker.update('target', { isRunning: true, completedTasks: 0, totalTasks: 3 });

		getDispatchCallbackRegistry()!.noteSpawn(KEY);
		for (let i = 1; i <= 3; i++) {
			getDispatchCallbackRegistry()!.noteExit(KEY, 0);
			tracker.update('target', { isRunning: true, completedTasks: i, totalTasks: 3 });
			await vi.advanceTimersByTimeAsync(5000);
		}
		expect(enqueue).not.toHaveBeenCalled();

		tracker.update('target', null);
		await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
		expect(enqueue.mock.calls[0][1]).toContain('Tasks: 3/3');
	});

	it('routes to an explicit caller tab when one was requested', async () => {
		getDispatchCallbackRegistry()!.register({
			targetAgentId: 'target',
			targetTabId: 'tab-1',
			callerAgentId: 'caller',
			callerTabId: 'caller-tab-9',
			timeoutMs: 60_000,
			prompt: 'go',
		});
		getDispatchCallbackRegistry()!.noteSpawn(KEY);
		getDispatchCallbackRegistry()!.noteExit(KEY, 0);
		await vi.advanceTimersByTimeAsync(5000);
		await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
		expect(enqueue.mock.calls[0][2]).toBe('caller-tab-9');
	});

	it('inlines the target output when a history reader is wired', async () => {
		disposeDispatchCallbacks();
		initDispatchCallbacks({
			enqueue,
			getTargetOutput: async () => 'the review verdict',
		});
		armOne();
		getDispatchCallbackRegistry()!.noteSpawn(KEY);
		getDispatchCallbackRegistry()!.noteExit(KEY, 0);
		await vi.advanceTimersByTimeAsync(5000);
		await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
		expect(enqueue.mock.calls[0][1]).toContain('the review verdict');
	});

	it('still delivers when reading the target output throws', async () => {
		disposeDispatchCallbacks();
		initDispatchCallbacks({
			enqueue,
			getTargetOutput: async () => {
				throw new Error('history unavailable');
			},
		});
		armOne();
		getDispatchCallbackRegistry()!.noteSpawn(KEY);
		getDispatchCallbackRegistry()!.noteExit(KEY, 0);
		await vi.advanceTimersByTimeAsync(5000);
		await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
	});

	it('does not throw when delivery fails', async () => {
		enqueue.mockResolvedValue({ success: false, error: 'session not found' });
		armOne();
		getDispatchCallbackRegistry()!.noteSpawn(KEY);
		getDispatchCallbackRegistry()!.noteExit(KEY, 0);
		await vi.advanceTimersByTimeAsync(5000);
		await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
	});

	it('disposes the registry', () => {
		expect(getDispatchCallbackRegistry()).not.toBeNull();
		disposeDispatchCallbacks();
		expect(getDispatchCallbackRegistry()).toBeNull();
	});
});
