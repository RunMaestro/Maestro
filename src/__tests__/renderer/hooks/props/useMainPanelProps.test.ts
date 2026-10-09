import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMainPanelProps, type UseMainPanelPropsDeps } from '../../../../renderer/hooks/props';
import type { Session, QueuedItem } from '../../../../renderer/types';

// MainPanel self-sources the full Session for paint (including executionQueue).
// useMainPanelProps must not re-export activeSession; doing so would either
// reintroduce App-level streaming wakes or leave a stale chrome slice on the
// prop bag. These tests guard that contract and the remaining session-field deps.

function makeQueuedItem(overrides: Partial<QueuedItem> = {}): QueuedItem {
	return {
		id: 'q1',
		timestamp: 0,
		tabId: 't1',
		type: 'message',
		text: 'original',
		...overrides,
	};
}

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 's1',
		activeTabId: 't1',
		inputMode: 'ai',
		projectRoot: '/repo',
		cwd: '/repo',
		executionQueue: [makeQueuedItem()],
		...overrides,
	} as unknown as Session;
}

const stableCancelTab = vi.fn();
const stableCancelMergeTab = vi.fn();

function makeDeps(activeSession: Session): UseMainPanelPropsDeps {
	return {
		activeSession,
		cancelTab: stableCancelTab,
		cancelMergeTab: stableCancelMergeTab,
	} as unknown as UseMainPanelPropsDeps;
}

describe('useMainPanelProps', () => {
	it('does not pass activeSession (MainPanel self-sources for paint)', () => {
		const session = makeSession();
		const { result } = renderHook(() => useMainPanelProps(makeDeps(session)));

		expect(result.current).not.toHaveProperty('activeSession');
	});

	it('does not recompute when only executionQueue changes', () => {
		// Queue edits must not wake this memo - MainPanel's store subscription
		// repaints the QUEUED list. Tracking executionQueue here would couple
		// App chrome props to a field chrome equality ignores.
		const first = makeSession({ executionQueue: [makeQueuedItem({ text: 'original' })] });
		const { result, rerender } = renderHook(
			(session: Session) => useMainPanelProps(makeDeps(session)),
			{ initialProps: first }
		);
		const firstProps = result.current;

		rerender(makeSession({ executionQueue: [makeQueuedItem({ text: 'edited' })] }));
		expect(result.current).toBe(firstProps);
	});

	it('recomputes when a tracked session field like activeTabId changes', () => {
		const first = makeSession({ activeTabId: 't1' });
		const { result, rerender } = renderHook(
			(session: Session) => useMainPanelProps(makeDeps(session)),
			{ initialProps: first }
		);
		const firstProps = result.current;

		rerender(makeSession({ activeTabId: 't2' }));
		expect(result.current).not.toBe(firstProps);
	});

	it('keeps the memoized props stable when nothing tracked changes', () => {
		const session = makeSession();

		const { result, rerender } = renderHook((s: Session) => useMainPanelProps(makeDeps(s)), {
			initialProps: session,
		});

		const firstProps = result.current;
		rerender(session);
		expect(result.current).toBe(firstProps);
	});
});
