/**
 * useTabWindowSelection - a tab window shows a selection at once and lets
 * main's record catch up (Tab Windows, TW-6, D3).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTabWindowSelection } from '../../../../renderer/components/TabWindow/useTabWindowSelection';
import { useNotificationStore } from '../../../../renderer/stores/notificationStore';
import type { TabWindowTabRef } from '../../../../shared/tabWindowTypes';

const A: TabWindowTabRef = { type: 'ai', id: 'a' };
const B: TabWindowTabRef = { type: 'file', id: 'b' };
const C: TabWindowTabRef = { type: 'ai', id: 'c' };

let resolveFocus: ((result: { focused: boolean; error?: string }) => void) | null = null;
const focus = vi.fn(
	() =>
		new Promise<{ focused: boolean; error?: string }>((resolve) => {
			resolveFocus = resolve;
		})
);

function renderSelection(initial: TabWindowTabRef | null) {
	return renderHook(({ confirmed }) => useTabWindowSelection('agent-1', confirmed), {
		initialProps: { confirmed: initial },
	});
}

beforeEach(() => {
	useNotificationStore.getState().clearToasts();
	focus.mockClear();
	resolveFocus = null;
	(window.maestro as unknown as { tabWindows: { focus: typeof focus } }).tabWindows = { focus };
});

afterEach(() => {
	delete (window.maestro as unknown as { tabWindows?: unknown }).tabWindows;
});

describe('useTabWindowSelection', () => {
	it('shows the record until something is selected', () => {
		const { result } = renderSelection(A);
		expect(result.current.activeTabRef).toEqual(A);
	});

	it('shows a selection before main answers, and asks main to record it', () => {
		const { result } = renderSelection(A);
		act(() => result.current.selectTab('file', 'b'));
		expect(result.current.activeTabRef).toEqual(B);
		expect(focus).toHaveBeenCalledWith('agent-1', B);
	});

	it('keeps the selection through a re-read that predates it', () => {
		const { result, rerender } = renderSelection(A);
		act(() => result.current.selectTab('file', 'b'));
		rerender({ confirmed: { ...A } });
		expect(result.current.activeTabRef).toEqual(B);
	});

	it('hands back to the record once a re-read names the selection', () => {
		const { result, rerender } = renderSelection(A);
		act(() => result.current.selectTab('file', 'b'));
		rerender({ confirmed: { ...B } });
		expect(result.current.activeTabRef).toEqual(B);
		// A later change from elsewhere is shown, not masked.
		rerender({ confirmed: C });
		expect(result.current.activeTabRef).toEqual(C);
	});

	it('lets the next re-read win once main accepted the selection', async () => {
		const { result, rerender } = renderSelection(A);
		act(() => result.current.selectTab('file', 'b'));
		await act(async () => resolveFocus?.({ focused: true }));
		rerender({ confirmed: C });
		expect(result.current.activeTabRef).toEqual(C);
	});

	it('drops a refused selection and says why', async () => {
		const { result } = renderSelection(A);
		act(() => result.current.selectTab('file', 'b'));
		await act(async () => resolveFocus?.({ focused: false, error: 'The tab is gone' }));
		expect(result.current.activeTabRef).toEqual(A);
		expect(useNotificationStore.getState().toasts.map((t) => t.message)).toContain(
			'The tab is gone'
		);
	});

	it('ignores an older call settling after a newer selection', async () => {
		const { result } = renderSelection(A);
		act(() => result.current.selectTab('file', 'b'));
		const settleFirst = resolveFocus;
		act(() => result.current.selectTab('ai', 'c'));
		await act(async () => settleFirst?.({ focused: false, error: 'stale' }));
		expect(result.current.activeTabRef).toEqual(C);
	});
});
