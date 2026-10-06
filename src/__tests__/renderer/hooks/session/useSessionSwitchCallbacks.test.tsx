/**
 * Tests for useSessionSwitchCallbacks - specifically handleToastSessionClick's
 * stale-jump guard (I1). This shared handler serves Board worker, Cue, and CLI
 * toasts, so a deleted agent id must fail loudly (an "Agent not found" toast)
 * rather than silently activating a nonexistent session.
 */

import type { RefObject } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// The deep-link effect subscribes on mount; stub it to a no-op unsubscribe so
// the hook mounts without touching the real maestro:// pipeline.
vi.mock('../../../../renderer/utils/openMaestroLink', () => ({
	subscribeToInAppDeepLinks: () => () => {},
}));

// Assert on the toast the guard fires without rendering the notification UI.
vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

import { useSessionSwitchCallbacks } from '../../../../renderer/hooks/session/useSessionSwitchCallbacks';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { notifyToast } from '../../../../renderer/stores/notificationStore';
import { createMockSession } from '../../../helpers/mockSession';

/** Build the hook's deps; only setActiveSessionId matters for these tests. */
function makeDeps() {
	return {
		setActiveSessionId: vi.fn(),
		handleResumeSession: vi.fn().mockResolvedValue(true),
		inputRef: { current: null } as RefObject<HTMLTextAreaElement | null>,
		handleFileClick: vi.fn(),
	};
}

function seedSessions(ids: string[]): void {
	useSessionStore.setState({
		sessions: ids.map((id) => createMockSession({ id, name: id })),
		groups: [],
		activeSessionId: ids[0] ?? '',
		sessionsLoaded: true,
	} as never);
}

describe('useSessionSwitchCallbacks - handleToastSessionClick stale guard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// The hook's deep-link effect subscribes to the OS-notification IPC channel
		// on mount; the global harness does not include it, so stub it here.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(window.maestro as any).app = { onDeepLink: vi.fn(() => vi.fn()) };
		seedSessions(['a', 'b']);
	});

	it('fires an "Agent not found" toast and never switches when the id is unknown', () => {
		const deps = makeDeps();
		const { result } = renderHook(() => useSessionSwitchCallbacks(deps));

		result.current.handleToastSessionClick('ghost');

		expect(notifyToast).toHaveBeenCalledTimes(1);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'orange', title: 'Agent not found' })
		);
		expect(deps.setActiveSessionId).not.toHaveBeenCalled();
	});

	it('switches to the session and fires no "not found" toast when the id exists', () => {
		const deps = makeDeps();
		const { result } = renderHook(() => useSessionSwitchCallbacks(deps));

		result.current.handleToastSessionClick('b');

		expect(deps.setActiveSessionId).toHaveBeenCalledWith('b');
		expect(notifyToast).not.toHaveBeenCalled();
	});
});
