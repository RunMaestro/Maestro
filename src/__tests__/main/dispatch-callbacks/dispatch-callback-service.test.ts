/**
 * @file dispatch-callback-service.test.ts
 * @description End-to-end wiring: Auto Run finality in, wake-up turn out (caller tab queue, or a new tab).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AutoRunDelegationEvent } from '../../../shared/autoRunDelegation';

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
	let openTab: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		resetAutoRunStateTracker();
		enqueue = vi.fn().mockResolvedValue({ success: true });
		openTab = vi.fn().mockResolvedValue({ success: true });
		initDispatchCallbacks({ enqueue, openTab });
	});

	afterEach(() => {
		disposeDispatchCallbacks();
		resetAutoRunStateTracker();
		vi.useRealTimers();
	});

	it.each([true, false])(
		'records parent delivery only after queue acceptance (%s)',
		async (success) => {
			const onDelivered = vi.fn();
			enqueue.mockResolvedValue({ success });
			initDispatchCallbacks({ enqueue, openTab, onDelivered });
			const registry = getDispatchCallbackRegistry()!;
			const entry = registry.register({
				targetAgentId: 'target',
				targetTabId: 'tab-1',
				callerAgentId: 'caller',
				callerTabId: 'parent',
				timeoutMs: 60000,
				prompt: 'go',
				pendingAdmissionId: 'dispatch',
			});
			registry.releaseQueueAdmission(entry.callbackId, 'dispatch');
			expect(entry.pendingAdmissionId).toBeUndefined();
			registry.noteSpawn(KEY);
			registry.noteExit(KEY, 0);
			await vi.advanceTimersByTimeAsync(5000);
			expect(onDelivered).toHaveBeenCalledTimes(success ? 1 : 0);
			if (success) expect(onDelivered.mock.calls[0][0].entry.admissionId).toBe('dispatch');
		}
	);

	// A dispatch from a run with no tab (a Cue or bot run) used to land in the
	// caller's ACTIVE tab: an unrelated conversation the user happened to be in.
	it('opens a new tab when the callback has no caller tab, never the active one', async () => {
		armOne();
		getDispatchCallbackRegistry()!.noteSpawn(KEY);
		getDispatchCallbackRegistry()!.noteExit(KEY, 0);

		await vi.advanceTimersByTimeAsync(5000);
		await vi.waitFor(() => expect(openTab).toHaveBeenCalledTimes(1));

		expect(enqueue).not.toHaveBeenCalled();
		const [agentId, prompt] = openTab.mock.calls[0];
		expect(agentId).toBe('caller');
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

		expect(openTab).not.toHaveBeenCalled();

		tracker.update('target', null);
		await vi.waitFor(() => expect(openTab).toHaveBeenCalledTimes(1));
		expect(openTab.mock.calls[0][1]).toContain('Tasks: 3/3');
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
			openTab,
			getTargetOutput: async () => 'the review verdict',
		});
		armOne();
		getDispatchCallbackRegistry()!.noteSpawn(KEY);
		getDispatchCallbackRegistry()!.noteExit(KEY, 0);
		await vi.advanceTimersByTimeAsync(5000);
		await vi.waitFor(() => expect(openTab).toHaveBeenCalledTimes(1));
		expect(openTab.mock.calls[0][1]).toContain('the review verdict');
	});

	it('still delivers when reading the target output throws', async () => {
		disposeDispatchCallbacks();
		initDispatchCallbacks({
			enqueue,
			openTab,
			getTargetOutput: async () => {
				throw new Error('history unavailable');
			},
		});
		armOne();
		getDispatchCallbackRegistry()!.noteSpawn(KEY);
		getDispatchCallbackRegistry()!.noteExit(KEY, 0);
		await vi.advanceTimersByTimeAsync(5000);
		await vi.waitFor(() => expect(openTab).toHaveBeenCalledTimes(1));
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

		/** Settle the delivery chain, then assert the final call counts. Guards the
		 *  negative cases, where `waitFor` alone would pass on the first call and
		 *  never see a stray retry land afterwards. */
		async function expectSettledCalls(enqueues: number, opens: number) {
			await vi.waitFor(() => expect(enqueue).toHaveBeenCalled());
			await vi.advanceTimersByTimeAsync(1000);
			expect(enqueue).toHaveBeenCalledTimes(enqueues);
			expect(openTab).toHaveBeenCalledTimes(opens);
		}

		it('opens a new tab when the caller tab is gone', async () => {
			enqueue.mockResolvedValueOnce({
				success: false,
				error: 'Tab not found: closed-caller-tab',
				reason: 'tab-not-found',
			});

			armWithCallerTab();
			await fireOnce();
			await vi.waitFor(() => expect(openTab).toHaveBeenCalledTimes(1));

			// First attempt targets the requested tab; the retry opens a new tab in the
			// caller rather than dropping into whatever tab is active.
			expect(enqueue.mock.calls[0][2]).toBe('closed-caller-tab');
			expect(openTab.mock.calls[0][0]).toBe('caller');
			// Same rendered wake, not a degraded one.
			expect(openTab.mock.calls[0][1]).toBe(enqueue.mock.calls[0][1]);
			expect(openTab.mock.calls[0][1]).toContain('[Maestro dispatch callback]');
		});

		it('does not throw when the new-tab fallback also fails', async () => {
			enqueue.mockResolvedValue({
				success: false,
				error: 'Tab not found: closed-caller-tab',
				reason: 'tab-not-found',
			});
			openTab.mockResolvedValue({ success: false, error: 'no window' });

			armWithCallerTab();
			await fireOnce();
			// Retries exactly once; never loops.
			await expectSettledCalls(1, 1);
		});

		it('does not retry for failures a new tab cannot fix', async () => {
			enqueue.mockResolvedValue({
				success: false,
				error: 'Session not found',
				reason: 'session-not-found',
			});

			armWithCallerTab();
			await fireOnce();
			await expectSettledCalls(1, 0);
		});

		it('does not retry when an older renderer sends no reason', async () => {
			enqueue.mockResolvedValue({ success: false, error: 'Tab not found: closed-caller-tab' });

			armWithCallerTab();
			await fireOnce();
			await expectSettledCalls(1, 0);
		});
	});

	it('does not throw when delivery fails', async () => {
		openTab.mockResolvedValue({ success: false, error: 'session not found' });
		armOne();
		getDispatchCallbackRegistry()!.noteSpawn(KEY);
		getDispatchCallbackRegistry()!.noteExit(KEY, 0);
		await vi.advanceTimersByTimeAsync(5000);
		await vi.waitFor(() => expect(openTab).toHaveBeenCalledTimes(1));
	});

	it('disposes the registry', () => {
		expect(getDispatchCallbackRegistry()).not.toBeNull();
		disposeDispatchCallbacks();
		expect(getDispatchCallbackRegistry()).toBeNull();
	});
});

describe('Auto Run delegation delivery', () => {
	let enqueue: ReturnType<typeof vi.fn>;
	let openTab: ReturnType<typeof vi.fn>;
	let notifyAutoRun: ReturnType<typeof vi.fn<(event: AutoRunDelegationEvent) => void>>;

	const armForRun = () =>
		getDispatchCallbackRegistry()!.register({
			targetAgentId: 'target',
			targetTabId: 'tab-1',
			targetName: 'Worker',
			callerAgentId: 'manager',
			autoRunId: 'autorun-7',
			timeoutMs: 60_000,
			prompt: 'build the parser',
		});

	beforeEach(() => {
		vi.useFakeTimers();
		resetAutoRunStateTracker();
		enqueue = vi.fn().mockResolvedValue({ success: true });
		openTab = vi.fn().mockResolvedValue({ success: true });
		notifyAutoRun = vi.fn<(event: AutoRunDelegationEvent) => void>();
		initDispatchCallbacks({
			enqueue,
			openTab,
			notifyAutoRun,
			getTargetOutput: async () => 'parser built, 12 tests pass',
		});
	});

	afterEach(() => {
		disposeDispatchCallbacks();
		resetAutoRunStateTracker();
		vi.useRealTimers();
	});

	it('reports started, then settled with the output, and never wakes a tab', async () => {
		const entry = armForRun();
		expect(notifyAutoRun).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'started',
				autoRunId: 'autorun-7',
				callbackId: entry.callbackId,
				callerAgentId: 'manager',
				targetAgentId: 'target',
				targetTabId: 'tab-1',
				targetName: 'Worker',
				prompt: 'build the parser',
			})
		);

		getDispatchCallbackRegistry()!.noteSpawn(KEY);
		getDispatchCallbackRegistry()!.noteExit(KEY, 0);
		await vi.advanceTimersByTimeAsync(5000);
		await vi.waitFor(() => expect(notifyAutoRun).toHaveBeenCalledTimes(2));

		expect(notifyAutoRun.mock.calls[1][0]).toMatchObject({
			kind: 'settled',
			callbackId: entry.callbackId,
			status: 'completed',
			output: 'parser built, 12 tests pass',
		});
		expect(enqueue).not.toHaveBeenCalled();
		expect(openTab).not.toHaveBeenCalled();
	});

	it('reports withdrawn when a refused dispatch cancels its entry', () => {
		const entry = armForRun();
		getDispatchCallbackRegistry()!.cancel(entry.callbackId);
		expect(notifyAutoRun).toHaveBeenLastCalledWith(
			expect.objectContaining({ kind: 'withdrawn', callbackId: entry.callbackId })
		);
	});

	it('says nothing to the Auto Run about an ordinary --notify-on-complete callback', () => {
		armOne();
		expect(notifyAutoRun).not.toHaveBeenCalled();
	});
});

describe('buildAutoRunDelegationEvent', () => {
	it('caps the output, keeping its tail', async () => {
		const { buildAutoRunDelegationEvent } =
			await import('../../../main/dispatch-callbacks/dispatch-callback-service');
		const { DISPATCH_OUTPUT_MAX_CHARS } =
			await import('../../../main/dispatch-callbacks/dispatch-callback-prompt');
		const entry = {
			callbackId: 'cb_1',
			autoRunId: 'autorun-1',
			targetAgentId: 'target',
			targetTabId: 'tab-1',
			callerAgentId: 'caller',
			timeoutMs: 1000,
			prompt: 'go',
			processSessionId: KEY,
			createdAt: 5,
			expiresAt: 10,
			state: 'fired' as const,
		};
		const output = 'x'.repeat(DISPATCH_OUTPUT_MAX_CHARS) + 'THE END';
		const event = buildAutoRunDelegationEvent(entry, 'settled', {
			fire: { entry, status: 'failed', exitCode: 1, durationMs: 42 },
			output,
		});
		expect(event.output).toHaveLength(DISPATCH_OUTPUT_MAX_CHARS);
		expect(event.output!.endsWith('THE END')).toBe(true);
		expect(event).toMatchObject({ status: 'failed', durationMs: 42, startedAt: 5 });
	});
});
