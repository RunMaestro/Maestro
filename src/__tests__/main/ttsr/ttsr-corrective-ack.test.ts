/**
 * Phase 4b: the corrective-spawn watchdog.
 *
 * The interrupt toast is optimistic - main raises it before any renderer has
 * spawned anything - so the behaviour worth testing here is what happens when
 * that promise is not kept: an ack cancels the alarm, silence and explicit
 * failure both raise it, and shutdown drops it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TtsrCorrectiveAckTracker } from '../../../main/ttsr/ttsr-corrective-ack';
import type { TtsrTriggeredPayload } from '../../../shared/ttsr-types';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TIMEOUT_MS = 10_000;

function makePayload(overrides: Partial<TtsrTriggeredPayload> = {}): TtsrTriggeredPayload {
	return {
		sessionId: 'session-1-ai-tab-1',
		tabId: 'tab-1',
		agentId: 'claude-code',
		rules: [{ name: 'no-console-log', path: '.maestro/rules/no-console-log.md' }],
		injectionPrompt: '<system-interrupt rule="no-console-log">Use the logger.</system-interrupt>',
		mode: 'resume',
		providerSessionId: 'prov-1',
		originalGoal: 'Refactor the auth module',
		contextMode: 'keep',
		...overrides,
	};
}

let safeSend: ReturnType<typeof vi.fn>;
let tracker: TtsrCorrectiveAckTracker;

/** Every `remote:notifyToast` the tracker sent. */
function toasts(): Array<Record<string, unknown>> {
	return safeSend.mock.calls
		.filter((call) => call[0] === 'remote:notifyToast')
		.map((call) => call[1] as Record<string, unknown>);
}

beforeEach(() => {
	vi.useFakeTimers();
	safeSend = vi.fn();
	tracker = new TtsrCorrectiveAckTracker({ safeSend, timeoutMs: TIMEOUT_MS });
});

afterEach(() => {
	tracker.dispose();
	vi.useRealTimers();
});

describe('TtsrCorrectiveAckTracker', () => {
	it('stays quiet when the corrective turn reports success', () => {
		tracker.arm(makePayload());
		tracker.resolve({ sessionId: 'session-1-ai-tab-1', ok: true });

		vi.advanceTimersByTime(TIMEOUT_MS * 2);

		expect(safeSend).not.toHaveBeenCalled();
		expect(tracker.pendingCount).toBe(0);
	});

	// The web-desktop case the whole mechanism exists for: no renderer acks, so
	// only the timeout can tell the user the orange toast became a lie.
	it('broadcasts the red "did not start" toast when nothing acks in time', () => {
		tracker.arm(makePayload());

		vi.advanceTimersByTime(TIMEOUT_MS - 1);
		expect(safeSend).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(toasts()).toHaveLength(1);
		const toast = toasts()[0];
		expect(toast.color).toBe('red');
		expect(toast.dismissible).toBe(true);
		expect(toast.message).toContain('did not start');
		expect(toast.message).toContain('open the desktop app');
		// The bare agent id, so the toast resolves an agent to jump to.
		expect(toast.sessionId).toBe('session-1');
		expect(tracker.pendingCount).toBe(0);
	});

	it('raises the toast immediately on an explicit failure, naming the reason', () => {
		tracker.arm(makePayload());
		tracker.resolve({
			sessionId: 'session-1-ai-tab-1',
			ok: false,
			error: 'ssh remote unresolvable',
		});

		expect(toasts()).toHaveLength(1);
		expect(toasts()[0].message).toContain('ssh remote unresolvable');

		// The watchdog is gone, so the same failure is not reported twice.
		vi.advanceTimersByTime(TIMEOUT_MS * 2);
		expect(toasts()).toHaveLength(1);
	});

	it('ignores an ack for a turn it never armed', () => {
		tracker.resolve({ sessionId: 'session-9-ai-tab-1', ok: false, error: 'boom' });
		expect(safeSend).not.toHaveBeenCalled();
	});

	// A late ack lost the race with the timeout; the user has already been told.
	// Reporting again would contradict the toast still on their screen.
	it('ignores an ack that arrives after the timeout fired', () => {
		tracker.arm(makePayload());
		vi.advanceTimersByTime(TIMEOUT_MS);
		expect(toasts()).toHaveLength(1);

		tracker.resolve({ sessionId: 'session-1-ai-tab-1', ok: false, error: 'too late' });
		expect(toasts()).toHaveLength(1);
	});

	// Only the newest corrective turn is the one a renderer is trying to spawn.
	it('supersedes an earlier watchdog for the same turn', () => {
		tracker.arm(makePayload());
		vi.advanceTimersByTime(TIMEOUT_MS - 1);
		tracker.arm(makePayload());

		// The first timer would have fired here had it survived.
		vi.advanceTimersByTime(1);
		expect(safeSend).not.toHaveBeenCalled();
		expect(tracker.pendingCount).toBe(1);

		vi.advanceTimersByTime(TIMEOUT_MS);
		expect(toasts()).toHaveLength(1);
	});

	it('tracks turns independently', () => {
		tracker.arm(makePayload());
		tracker.arm(makePayload({ sessionId: 'session-2-ai-tab-1', tabId: 'tab-1' }));
		tracker.resolve({ sessionId: 'session-1-ai-tab-1', ok: true });

		vi.advanceTimersByTime(TIMEOUT_MS);

		expect(toasts()).toHaveLength(1);
		expect(toasts()[0].sessionId).toBe('session-2');
	});

	// Shutdown: a timer firing on the way out would toast a renderer that is
	// already gone.
	it('drops every pending watchdog on dispose', () => {
		tracker.arm(makePayload());
		tracker.arm(makePayload({ sessionId: 'session-2-ai-tab-1' }));
		expect(tracker.pendingCount).toBe(2);

		tracker.dispose();

		expect(tracker.pendingCount).toBe(0);
		vi.advanceTimersByTime(TIMEOUT_MS * 2);
		expect(safeSend).not.toHaveBeenCalled();
	});

	it('never throws when the push channel does', () => {
		safeSend.mockImplementation(() => {
			throw new Error('no window');
		});
		tracker.arm(makePayload());

		expect(() => vi.advanceTimersByTime(TIMEOUT_MS)).not.toThrow();
	});
});
