import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMainPanelProps, type UseMainPanelPropsDeps } from '../../../../renderer/hooks/props';
import type { Session, QueuedItem } from '../../../../renderer/types';

// The props object is memoized with a primitive dependency array (id, activeTabId,
// inputMode, projectRoot, cwd, executionQueue, ...) rather than the full session
// object. This test guards the specific regression where editing a queued item
// left the inline QUEUED list stale because `executionQueue` was NOT tracked: the
// memo kept returning the previous `activeSession` reference even though the store
// had a fresh one with the edited text.

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

function makeSession(executionQueue: QueuedItem[]): Session {
	return {
		id: 's1',
		activeTabId: 't1',
		inputMode: 'ai',
		projectRoot: '/repo',
		cwd: '/repo',
		executionQueue,
	} as unknown as Session;
}

// Only `activeSession` matters for this regression; the rest of the (very large)
// deps surface is intentionally omitted and read as undefined by the memo body.
function makeDeps(activeSession: Session): UseMainPanelPropsDeps {
	return { activeSession } as unknown as UseMainPanelPropsDeps;
}

describe('useMainPanelProps', () => {
	it('recomputes activeSession when the execution queue reference changes', () => {
		const first = makeSession([makeQueuedItem({ text: 'original' })]);

		const { result, rerender } = renderHook(
			(session: Session) => useMainPanelProps(makeDeps(session)),
			{
				initialProps: first,
			}
		);

		expect(result.current.activeSession).toBe(first);
		expect(result.current.activeSession?.executionQueue?.[0]?.text).toBe('original');

		// Simulate an in-place queue edit: same session id/tab, brand-new session
		// object and a brand-new executionQueue array carrying the edited text.
		const edited = makeSession([makeQueuedItem({ text: 'edited' })]);
		rerender(edited);

		// Without executionQueue in the memo deps this would still be `first`.
		expect(result.current.activeSession).toBe(edited);
		expect(result.current.activeSession?.executionQueue?.[0]?.text).toBe('edited');
	});

	it('keeps the memoized props stable when nothing tracked changes', () => {
		const session = makeSession([makeQueuedItem()]);

		const { result, rerender } = renderHook((s: Session) => useMainPanelProps(makeDeps(s)), {
			initialProps: session,
		});

		const firstProps = result.current;
		// Re-render with the exact same session reference: memo must not recompute.
		rerender(session);
		expect(result.current).toBe(firstProps);
	});
});
