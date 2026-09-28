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

	// Task 7b / Decision 4: `--callback-tab` names a specific caller tab, and the
	// caller is free to close it while the dispatch runs. Before this, the fired
	// wake was dropped with only a warn line - see V1-caller-tab.md.
	describe('caller tab closed before the callback fires', () => {
		function armWithCallerTab() {
			return getDispatchCallbackRegistry()!.register({
				targetAgentId: 'target',
				targetTabId: 'tab-1',
				callerAgentId: 'caller',
				callerTabId: 'closed-caller-tab',
				timeoutMs: 60_000,
				prompt: 'go',
			});
		}

		async function fireOnce() {
			getDispatchCallbackRegistry()!.noteSpawn(KEY);
			getDispatchCallbackRegistry()!.noteExit(KEY, 0);
			await vi.advanceTimersByTimeAsync(5000);
		}

		/** Settle the delivery chain, then assert the final call count. Guards the
		 *  negative cases, where `waitFor` alone would pass on the first call and
		 *  never see a stray retry land afterwards. */
		async function expectSettledCallCount(count: number) {
			await vi.waitFor(() => expect(enqueue).toHaveBeenCalled());
			await vi.advanceTimersByTimeAsync(1000);
			expect(enqueue).toHaveBeenCalledTimes(count);
		}

		it('falls back to agent-level delivery when the caller tab is gone', async () => {
			enqueue
				.mockResolvedValueOnce({
					success: false,
					error: 'Tab not found: closed-caller-tab',
					reason: 'tab-not-found',
				})
				.mockResolvedValueOnce({ success: true });

			armWithCallerTab();
			await fireOnce();
			await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));

			// First attempt targets the requested tab, the retry drops the tab id so
			// the renderer resolves the caller's active tab - identical to how a
			// --notify-on-complete without --callback-tab is delivered.
			expect(enqueue.mock.calls[0][2]).toBe('closed-caller-tab');
			expect(enqueue.mock.calls[1][0]).toBe('caller');
			expect(enqueue.mock.calls[1][2]).toBeUndefined();
			// Same rendered wake, not a degraded one.
			expect(enqueue.mock.calls[1][1]).toBe(enqueue.mock.calls[0][1]);
			expect(enqueue.mock.calls[1][1]).toContain('[Maestro dispatch callback]');
		});

		it('does not throw when the agent-level fallback also fails', async () => {
			enqueue.mockResolvedValue({
				success: false,
				error: 'Tab not found: closed-caller-tab',
				reason: 'tab-not-found',
			});

			armWithCallerTab();
			await fireOnce();
			// Retries exactly once; never loops.
			await expectSettledCallCount(2);
		});

		it('does not retry for failures dropping the tab id cannot fix', async () => {
			enqueue.mockResolvedValue({
				success: false,
				error: 'Session not found',
				reason: 'session-not-found',
			});

			armWithCallerTab();
			await fireOnce();
			await expectSettledCallCount(1);
		});

		it('does not retry when an older renderer sends no reason', async () => {
			enqueue.mockResolvedValue({ success: false, error: 'Tab not found: closed-caller-tab' });

			armWithCallerTab();
			await fireOnce();
			await expectSettledCallCount(1);
		});

		it('never retries a delivery that had no caller tab to begin with', async () => {
			enqueue.mockResolvedValue({ success: false, error: 'boom', reason: 'tab-not-found' });

			armOne();
			await fireOnce();
			await expectSettledCallCount(1);
		});
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
