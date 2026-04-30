/**
 * Test helpers for verifying that DOM event listeners attached to a target
 * are removed by the time the component is unmounted.
 *
 * Usage:
 *   const target = document; // or window, or an element
 *   const { addSpy, removeSpy } = spyOnListeners(target);
 *   const { unmount } = render(<MyComponent />);
 *   unmount();
 *   expectAllListenersRemoved(addSpy, removeSpy);
 *
 * The assertion verifies that every (eventType, listener, capture) triple
 * passed to addEventListener was later passed to removeEventListener with
 * matching identity. Per DOM spec, only the `capture` flag from the options
 * bag (or the legacy boolean `useCapture`) participates in listener identity
 * — `passive`, `once`, `signal` do not. Anonymous-handler leaks are caught
 * because we compare listener references by identity, not by name.
 */

import { vi, type MockInstance } from 'vitest';

export type AddListenerSpy = MockInstance<typeof EventTarget.prototype.addEventListener>;
export type RemoveListenerSpy = MockInstance<typeof EventTarget.prototype.removeEventListener>;

export interface ListenerSpyHandles {
	addSpy: AddListenerSpy;
	removeSpy: RemoveListenerSpy;
	/** Restore the original methods. Idempotent. */
	restore: () => void;
}

/**
 * Spy on `addEventListener` and `removeEventListener` of the given target.
 * The originals are still invoked via vi.spyOn's default behaviour, so
 * listeners attached during the test still fire.
 */
export function spyOnListeners(target: EventTarget = document): ListenerSpyHandles {
	const addSpy = vi.spyOn(target, 'addEventListener') as AddListenerSpy;
	const removeSpy = vi.spyOn(target, 'removeEventListener') as RemoveListenerSpy;
	return {
		addSpy,
		removeSpy,
		restore: () => {
			addSpy.mockRestore();
			removeSpy.mockRestore();
		},
	};
}

/**
 * Normalize the third argument to addEventListener / removeEventListener
 * (which can be `undefined`, a boolean useCapture flag, or an
 * AddEventListenerOptions object) into the single `capture` boolean that
 * actually participates in listener identity per the DOM spec.
 */
function getCaptureFlag(options: unknown): boolean {
	if (typeof options === 'boolean') return options;
	if (options !== null && typeof options === 'object' && 'capture' in options) {
		return Boolean((options as { capture?: unknown }).capture);
	}
	return false;
}

/**
 * Throw if any (eventType, listener, capture) triple added via
 * addEventListener was not later passed to removeEventListener with matching
 * identity. A listener registered with `{ capture: true }` and removed
 * without options is correctly reported as a leak — the spec treats those
 * as two different listener registrations.
 *
 * If the same triple was added more than once (rare but legal), each add
 * needs a matching remove — this is a count-aware multiset comparison.
 */
export function expectAllListenersRemoved(
	addSpy: AddListenerSpy,
	removeSpy: RemoveListenerSpy
): void {
	const added = addSpy.mock.calls.map(([eventType, listener, options]) => ({
		eventType: String(eventType),
		listener,
		capture: getCaptureFlag(options),
	}));
	const removed = removeSpy.mock.calls.map(([eventType, listener, options]) => ({
		eventType: String(eventType),
		listener,
		capture: getCaptureFlag(options),
	}));

	const remaining = [...removed];
	const leaked: Array<{ eventType: string; capture: boolean }> = [];

	for (const add of added) {
		const idx = remaining.findIndex(
			(r) =>
				r.eventType === add.eventType && r.listener === add.listener && r.capture === add.capture
		);
		if (idx === -1) {
			leaked.push({ eventType: add.eventType, capture: add.capture });
		} else {
			remaining.splice(idx, 1);
		}
	}

	if (leaked.length > 0) {
		const summary = leaked.map((l) => `${l.eventType}${l.capture ? ' (capture)' : ''}`).join(', ');
		throw new Error(
			`Listener leak: ${leaked.length} listener(s) added but never removed [${summary}]. ` +
				`Total adds: ${added.length}, total removes: ${removed.length}.`
		);
	}
}
