import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentSessionsFocusRestore } from '../../../../../renderer/components/AgentSessionsBrowser/hooks/useAgentSessionsFocusRestore';
import type { AgentSession } from '../../../../../renderer/hooks/agent/useSessionViewer';

function makeSession(sessionId = 's1'): AgentSession {
	return {
		sessionId,
		projectPath: '/p',
		timestamp: '2024-01-01T00:00:00Z',
		modifiedAt: '2024-01-01T00:00:00Z',
		firstMessage: '',
		messageCount: 0,
		sizeBytes: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 0,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

function makeRefs() {
	const inputFocus = vi.fn();
	const itemScroll = vi.fn();
	const inputRef = { current: { focus: inputFocus } } as any;
	const selectedItemRef = { current: { scrollIntoView: itemScroll } } as any;
	return { inputRef, selectedItemRef, inputFocus, itemScroll };
}

describe('useAgentSessionsFocusRestore', () => {
	it('no-op on initial mount with no previous viewingSession', () => {
		const { inputRef, selectedItemRef, inputFocus } = makeRefs();
		renderHook(() =>
			useAgentSessionsFocusRestore({ viewingSession: null, inputRef, selectedItemRef })
		);
		act(() => {
			vi.runAllTimers();
		});
		expect(inputFocus).not.toHaveBeenCalled();
	});

	it('no-op when entering detail view (prev null → set)', () => {
		const { inputRef, selectedItemRef, inputFocus } = makeRefs();
		const { rerender } = renderHook((args: any) => useAgentSessionsFocusRestore(args), {
			initialProps: { viewingSession: null, inputRef, selectedItemRef },
		});
		act(() => {
			rerender({ viewingSession: makeSession(), inputRef, selectedItemRef });
		});
		act(() => {
			vi.runAllTimers();
		});
		expect(inputFocus).not.toHaveBeenCalled();
	});

	it('fires when exiting detail view (prev set → null)', () => {
		const { inputRef, selectedItemRef, inputFocus } = makeRefs();
		const { rerender } = renderHook((args: any) => useAgentSessionsFocusRestore(args), {
			initialProps: { viewingSession: makeSession(), inputRef, selectedItemRef },
		});
		act(() => {
			rerender({ viewingSession: null, inputRef, selectedItemRef });
		});
		act(() => {
			vi.runAllTimers();
		});
		expect(inputFocus).toHaveBeenCalled();
	});

	it('focuses inputRef on exit from detail view', () => {
		const { inputRef, selectedItemRef, inputFocus } = makeRefs();
		const { rerender } = renderHook((args: any) => useAgentSessionsFocusRestore(args), {
			initialProps: { viewingSession: makeSession(), inputRef, selectedItemRef },
		});
		act(() => {
			rerender({ viewingSession: null, inputRef, selectedItemRef });
		});
		act(() => {
			vi.runAllTimers();
		});
		expect(inputFocus).toHaveBeenCalledTimes(1);
	});

	it('calls scrollIntoView on selectedItemRef on exit from detail view', () => {
		const { inputRef, selectedItemRef, itemScroll } = makeRefs();
		const { rerender } = renderHook((args: any) => useAgentSessionsFocusRestore(args), {
			initialProps: { viewingSession: makeSession(), inputRef, selectedItemRef },
		});
		act(() => {
			rerender({ viewingSession: null, inputRef, selectedItemRef });
		});
		act(() => {
			vi.runAllTimers();
		});
		expect(itemScroll).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
	});

	it('does NOT fire when transitioning between detail views', () => {
		const { inputRef, selectedItemRef, inputFocus } = makeRefs();
		const { rerender } = renderHook((args: any) => useAgentSessionsFocusRestore(args), {
			initialProps: { viewingSession: makeSession('s1'), inputRef, selectedItemRef },
		});
		act(() => {
			rerender({ viewingSession: makeSession('s2'), inputRef, selectedItemRef });
		});
		act(() => {
			vi.runAllTimers();
		});
		expect(inputFocus).not.toHaveBeenCalled();
	});

	it('cleans up timer on unmount without throwing', () => {
		const { inputRef, selectedItemRef } = makeRefs();
		const { rerender, unmount } = renderHook((args: any) => useAgentSessionsFocusRestore(args), {
			initialProps: { viewingSession: makeSession(), inputRef, selectedItemRef },
		});
		act(() => {
			rerender({ viewingSession: null, inputRef, selectedItemRef });
		});
		expect(() => unmount()).not.toThrow();
	});

	it('handles null inputRef.current without throwing', () => {
		const inputRef = { current: null } as any;
		const selectedItemRef = { current: null } as any;
		const { rerender } = renderHook((args: any) => useAgentSessionsFocusRestore(args), {
			initialProps: { viewingSession: makeSession(), inputRef, selectedItemRef },
		});
		expect(() => {
			act(() => {
				rerender({ viewingSession: null, inputRef, selectedItemRef });
			});
			act(() => {
				vi.runAllTimers();
			});
		}).not.toThrow();
	});

	it('handles null selectedItemRef.current without throwing', () => {
		const inputRef = { current: { focus: vi.fn() } } as any;
		const selectedItemRef = { current: null } as any;
		const { rerender } = renderHook((args: any) => useAgentSessionsFocusRestore(args), {
			initialProps: { viewingSession: makeSession(), inputRef, selectedItemRef },
		});
		expect(() => {
			act(() => {
				rerender({ viewingSession: null, inputRef, selectedItemRef });
			});
			act(() => {
				vi.runAllTimers();
			});
		}).not.toThrow();
	});
});
