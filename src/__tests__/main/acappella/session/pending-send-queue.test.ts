import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	PendingSendQueue,
	type PendingSendItem,
	type PendingSendQueueDeps,
} from '../../../../main/acappella/session/pending-send-queue';
import {
	VoiceDispatchBusyError,
	VoiceDispatchError,
} from '../../../../main/acappella/voice-session-service';

function makeItem(overrides: Partial<PendingSendItem> = {}): PendingSendItem {
	return {
		decision: {
			target: { sessionId: 'agent-1' },
			tabAction: 'recall',
			tabId: 'tab-1',
			prompt: 'initial prompt',
			confidence: 1,
		},
		scope: { kind: 'agent', sessionId: 'agent-1' },
		agentSessionId: 'agent-1',
		tabId: 'tab-1',
		...overrides,
	};
}

describe('PendingSendQueue', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createHarness(overrides: Partial<PendingSendQueueDeps> = {}) {
		const emittedStates: ReturnType<PendingSendQueue['getSendState']>[] = [];
		const executeRoute = vi.fn().mockResolvedValue({
			agentSessionId: 'agent-1',
			agentName: 'Agent 1',
			tabId: 'tab-1',
			action: 'recall',
			promptSent: true,
		});
		const finishDispatch = vi.fn();
		const onRetryBusy = vi.fn();
		const onRetryError = vi.fn();
		let turn = 0;

		const deps: PendingSendQueueDeps = {
			getForceSendAllowed: () => true,
			getSessionId: () => 'session-1',
			canSchedule: () => true,
			canSetForceSend: () => true,
			isSessionOpen: () => true,
			isReadyToRetry: () => true,
			hasExecutor: () => true,
			getRoster: () => [],
			executeRoute,
			beginRetryTurn: () => ++turn,
			isCurrentTurn: (t) => t === turn,
			finishDispatch,
			isBusyError: (err) => err instanceof VoiceDispatchBusyError,
			onRetryBusy,
			onRetryError,
			onSendStateChange: (state) => emittedStates.push(state),
			...overrides,
		};

		const queue = new PendingSendQueue(deps);
		return { queue, emittedStates, executeRoute, finishDispatch, onRetryBusy, onRetryError };
	}

	it('enqueues pending items, appends matching scope utterances, and publishes state', () => {
		const { queue, emittedStates } = createHarness();
		queue.enqueue(makeItem());

		expect(queue.getSendState()).toEqual({
			forceSend: false,
			pending: [{ agentSessionId: 'agent-1', tabId: 'tab-1', text: 'initial prompt' }],
		});

		expect(queue.appendIfPending({ kind: 'conductor' }, 'ignored')).toBe(false);
		expect(queue.appendIfPending({ kind: 'agent', sessionId: 'agent-1' }, 'more detail')).toBe(
			true
		);

		expect(queue.getSendState().pending[0]?.text).toBe('initial prompt\n\nmore detail');
		expect(emittedStates).toHaveLength(2);
	});

	it('toggles forceSend, respects getForceSendAllowed, and schedules an immediate retry', async () => {
		let allowed = false;
		const { queue, executeRoute, finishDispatch } = createHarness({
			getForceSendAllowed: () => allowed,
			canSetForceSend: (enabled) => !enabled || allowed,
		});

		expect(queue.setForceSend(true)).toBe(false);

		allowed = true;
		queue.enqueue(makeItem());
		expect(queue.setForceSend(true)).toBe(true);
		expect(queue.getSendState().forceSend).toBe(true);

		await vi.advanceTimersByTimeAsync(0);
		expect(executeRoute).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: 'initial prompt' }),
			expect.objectContaining({ force: true })
		);
		expect(finishDispatch).toHaveBeenCalledTimes(1);
		expect(queue.getSendState().pending).toHaveLength(0);
	});

	it('reschedules when not ready or when retry hits VoiceDispatchBusyError', async () => {
		let ready = false;
		const { queue, executeRoute, onRetryBusy } = createHarness({
			isReadyToRetry: () => ready,
		});

		queue.enqueue(makeItem());
		queue.schedule(100);
		await vi.advanceTimersByTimeAsync(100);
		expect(executeRoute).not.toHaveBeenCalled();

		ready = true;
		executeRoute.mockRejectedValueOnce(new VoiceDispatchBusyError('agent-1', 'tab-1'));
		await vi.advanceTimersByTimeAsync(750);
		expect(onRetryBusy).toHaveBeenCalledTimes(1);
		expect(queue.getSendState().pending).toHaveLength(1);
	});

	it('forwards non-busy errors to onRetryError and cancels pending timer on clear', async () => {
		const { queue, executeRoute, onRetryError } = createHarness();
		queue.enqueue(makeItem());
		queue.schedule(100);
		queue.clear({ resetForceSend: true });

		await vi.advanceTimersByTimeAsync(200);
		expect(executeRoute).not.toHaveBeenCalled();

		queue.enqueue(makeItem());
		executeRoute.mockRejectedValueOnce(new VoiceDispatchError('gone'));
		queue.schedule(100);
		await vi.advanceTimersByTimeAsync(100);
		expect(onRetryError).toHaveBeenCalledWith(expect.any(VoiceDispatchError));
	});
});
