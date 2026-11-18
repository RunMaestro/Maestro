// Covers the Auto Run destination of a dispatch callback: a `maestro-cli
// dispatch` run inside an Auto Run task sends `autoRunId`, and the handler arms
// tracking that reports back to the run. The contract that matters is that it
// never REFUSES the dispatch: a run that cannot track the work (it is over, or
// the tab already carries a callback) still lets the hand-off through.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AutoRunDelegationEvent } from '../../../../shared/autoRunDelegation';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	armDispatchCallback,
	readAutoRunCallbackRequest,
	wantsDispatchCallback,
} from '../../../../main/web-server/handlers/messageHandlers/dispatchCallbacks';
import {
	disposeDispatchCallbacks,
	getDispatchCallbackRegistry,
	initDispatchCallbacks,
} from '../../../../main/dispatch-callbacks';
import {
	getAutoRunStateTracker,
	resetAutoRunStateTracker,
} from '../../../../main/autorun/autorun-state-tracker';
import type {
	MessageHandlerContext,
	WebClientMessage,
} from '../../../../main/web-server/handlers/messageHandlers/types';

const ctx = {
	callbacks: {
		getSessions: () => [{ id: 'worker', name: 'Worker' }],
		getSessionDetail: () => ({}),
	},
} as unknown as MessageHandlerContext;

const target = { agentId: 'worker', tabId: 'tab-1', prompt: 'build it', isNewTab: true };

function message(extra: Record<string, unknown> = {}): WebClientMessage {
	return {
		type: 'new_ai_tab_with_prompt',
		fromSessionId: 'manager',
		autoRunId: 'autorun-1',
		...extra,
	};
}

describe('readAutoRunCallbackRequest', () => {
	it('reads the run and the caller', () => {
		expect(readAutoRunCallbackRequest(message())).toEqual({
			autoRunId: 'autorun-1',
			callerAgentId: 'manager',
		});
	});

	it('yields to an explicit --notify-on-complete', () => {
		expect(readAutoRunCallbackRequest(message({ notifyOnComplete: 'someone' }))).toBeUndefined();
	});

	it('needs a caller to report to', () => {
		expect(readAutoRunCallbackRequest(message({ fromSessionId: undefined }))).toBeUndefined();
		expect(wantsDispatchCallback({ type: 'send_command' })).toBe(false);
		expect(wantsDispatchCallback(message())).toBe(true);
	});
});

describe('armDispatchCallback for an Auto Run', () => {
	let notifyAutoRun: ReturnType<typeof vi.fn<(event: AutoRunDelegationEvent) => void>>;

	beforeEach(() => {
		resetAutoRunStateTracker();
		notifyAutoRun = vi.fn<(event: AutoRunDelegationEvent) => void>();
		initDispatchCallbacks({
			enqueue: vi.fn().mockResolvedValue({ success: true }),
			openTab: vi.fn().mockResolvedValue({ success: true }),
			notifyAutoRun,
		});
	});

	afterEach(() => {
		disposeDispatchCallbacks();
		resetAutoRunStateTracker();
	});

	it('arms tracking addressed to the run while the caller has one running', () => {
		getAutoRunStateTracker().update('manager', {
			isRunning: true,
			completedTasks: 0,
			totalTasks: 1,
		});
		const armed = armDispatchCallback(ctx, message({ callbackTimeout: 120 }), target);
		expect(armed.error).toBeUndefined();
		const entry = getDispatchCallbackRegistry()!.get(armed.callbackId!);
		expect(entry).toMatchObject({
			autoRunId: 'autorun-1',
			callerAgentId: 'manager',
			targetName: 'Worker',
			timeoutMs: 120_000,
		});
		expect(notifyAutoRun).toHaveBeenCalledWith(expect.objectContaining({ kind: 'started' }));
	});

	it('leaves the dispatch untracked, not refused, when the run is over', () => {
		// A daemon an earlier task started still carries the run id in its env.
		const armed = armDispatchCallback(ctx, message(), target);
		expect(armed).toEqual({});
		expect(getDispatchCallbackRegistry()!.list()).toHaveLength(0);
	});

	it('leaves the dispatch untracked when the tab already carries a callback', () => {
		getAutoRunStateTracker().update('manager', {
			isRunning: true,
			completedTasks: 0,
			totalTasks: 1,
		});
		getDispatchCallbackRegistry()!.register({
			targetAgentId: 'worker',
			targetTabId: 'tab-1',
			callerAgentId: 'someone',
			timeoutMs: 60_000,
			prompt: 'earlier',
		});
		const armed = armDispatchCallback(ctx, message(), target);
		expect(armed).toEqual({});
	});

	it('allows a run to delegate to a new tab of its own agent', () => {
		getAutoRunStateTracker().update('manager', {
			isRunning: true,
			completedTasks: 0,
			totalTasks: 1,
		});
		const armed = armDispatchCallback(ctx, message(), { ...target, agentId: 'manager' });
		expect(armed.callbackId).toBeDefined();
	});
});
