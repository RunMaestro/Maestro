import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useNavigationHistory } from '../../renderer/hooks/session/useNavigationHistory';

describe('useNavigationHistory integration', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('starts empty and tolerates no-op navigation helpers', () => {
		const { result } = renderHook(() => useNavigationHistory());

		expect(result.current.canGoBack()).toBe(false);
		expect(result.current.canGoForward()).toBe(false);
		expect(result.current.navigateBack()).toBeNull();
		expect(result.current.navigateForward()).toBeNull();

		act(() => {
			result.current.updateCurrentTab('tab-without-current');
			result.current.clearHistory();
		});

		expect(result.current.canGoBack()).toBe(false);
		expect(result.current.canGoForward()).toBe(false);
	});

	it('tracks back and forward history while suppressing duplicate and in-flight navigation pushes', () => {
		const { result } = renderHook(() => useNavigationHistory());

		act(() => {
			result.current.pushNavigation({ sessionId: 'session-1', tabId: 'tab-1' });
			result.current.pushNavigation({ sessionId: 'session-1', tabId: 'tab-1' });
		});
		expect(result.current.canGoBack()).toBe(false);

		act(() => {
			result.current.pushNavigation({ sessionId: 'session-2', tabId: 'tab-2' });
		});
		expect(result.current.canGoBack()).toBe(true);
		expect(result.current.canGoForward()).toBe(false);

		let backEntry: ReturnType<typeof result.current.navigateBack>;
		act(() => {
			backEntry = result.current.navigateBack();
			result.current.pushNavigation({ sessionId: 'ignored-during-back' });
		});

		expect(backEntry!).toEqual({ sessionId: 'session-1', tabId: 'tab-1' });
		expect(result.current.canGoBack()).toBe(false);
		expect(result.current.canGoForward()).toBe(true);

		act(() => {
			vi.runOnlyPendingTimers();
		});
		act(() => {
			result.current.pushNavigation({ sessionId: 'session-3', groupChatId: 'group-1' });
		});

		expect(result.current.canGoBack()).toBe(true);
		expect(result.current.canGoForward()).toBe(false);

		act(() => {
			backEntry = result.current.navigateBack();
		});
		expect(backEntry!).toEqual({ sessionId: 'session-1', tabId: 'tab-1' });

		act(() => {
			vi.runOnlyPendingTimers();
		});

		let forwardEntry: ReturnType<typeof result.current.navigateForward>;
		act(() => {
			forwardEntry = result.current.navigateForward();
			result.current.pushNavigation({ sessionId: 'ignored-during-forward' });
		});

		expect(forwardEntry!).toEqual({ sessionId: 'session-3', groupChatId: 'group-1' });
		expect(result.current.canGoForward()).toBe(false);

		act(() => {
			vi.runOnlyPendingTimers();
		});
	});

	it('updates the current tab without adding history and clears both stacks', () => {
		const { result } = renderHook(() => useNavigationHistory());

		act(() => {
			result.current.pushNavigation({ sessionId: 'session-1', tabId: 'tab-1' });
			result.current.updateCurrentTab('tab-2');
			result.current.pushNavigation({ sessionId: 'session-1', tabId: 'tab-2' });
		});

		expect(result.current.canGoBack()).toBe(false);

		act(() => {
			result.current.pushNavigation({ sessionId: 'session-2', tabId: undefined });
		});

		expect(result.current.navigateBack()).toEqual({ sessionId: 'session-1', tabId: 'tab-2' });

		act(() => {
			result.current.clearHistory();
		});

		expect(result.current.canGoBack()).toBe(false);
		expect(result.current.canGoForward()).toBe(false);
		expect(result.current.navigateBack()).toBeNull();
		expect(result.current.navigateForward()).toBeNull();
	});

	it('caps stored back history at the most recent 50 entries', () => {
		const { result } = renderHook(() => useNavigationHistory());

		act(() => {
			for (let index = 0; index < 55; index += 1) {
				result.current.pushNavigation({ sessionId: `session-${index}` });
			}
		});

		const visited: string[] = [];
		for (let index = 0; index < 50; index += 1) {
			act(() => {
				const entry = result.current.navigateBack();
				if (entry?.sessionId) {
					visited.push(entry.sessionId);
				}
				vi.runOnlyPendingTimers();
			});
		}

		expect(visited[0]).toBe('session-53');
		expect(visited[visited.length - 1]).toBe('session-4');
		expect(result.current.navigateBack()).toBeNull();
	});
});
