/**
 * Tests for the renderer's Files-panel nudge.
 *
 * The panel refreshes on a timer, so anything that writes or deletes outside
 * that cadence has to say so. This exists as a helper rather than a hand-rolled
 * `new CustomEvent('maestro:refreshFileTree', ...)` in each caller (there were
 * four copies), so the two things worth pinning are the event NAME the single
 * app-level listener binds, and that a missing session id is a no-op rather
 * than a throw - callers write files from surfaces that may have no agent.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	requestFileTreeRefresh,
	FILE_TREE_REFRESH_EVENT,
} from '../../../renderer/utils/fileTreeRefresh';

let listener: ReturnType<typeof vi.fn<(event: Event) => void>>;

beforeEach(() => {
	listener = vi.fn<(event: Event) => void>();
	window.addEventListener(FILE_TREE_REFRESH_EVENT, listener);
	return () => window.removeEventListener(FILE_TREE_REFRESH_EVENT, listener);
});

describe('requestFileTreeRefresh', () => {
	it('binds the event name the app-level listener listens for', () => {
		// Hard-coded rather than read from the constant: this string is the
		// contract with useAppRemoteEventListeners and the CLI/web bridges.
		expect(FILE_TREE_REFRESH_EVENT).toBe('maestro:refreshFileTree');
	});

	it('raises the event carrying the session to refresh', () => {
		requestFileTreeRefresh('agent-1');

		expect(listener).toHaveBeenCalledTimes(1);
		const event = listener.mock.calls[0][0] as CustomEvent;
		expect(event.detail).toEqual({ sessionId: 'agent-1' });
	});

	it.each([
		['undefined', undefined],
		['null', null],
		['an empty string', ''],
	])('is a silent no-op for %s', (_label, sessionId) => {
		expect(() => requestFileTreeRefresh(sessionId)).not.toThrow();
		expect(listener).not.toHaveBeenCalled();
	});
});
