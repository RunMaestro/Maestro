/**
 * Tests for useMobileKeyboardHandler hook
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useMobileKeyboardHandler,
	type MobileKeyboardSession,
} from '../../../web/hooks/useMobileKeyboardHandler';
import type { AITabData } from '../../../web/hooks/useWebSocket';

function createTabs(): AITabData[] {
	return [
		{
			id: 'tab-1',
			agentSessionId: null,
			name: 'One',
			starred: false,
			inputValue: '',
			createdAt: 0,
			state: 'idle',
		},
		{
			id: 'tab-2',
			agentSessionId: null,
			name: 'Two',
			starred: false,
			inputValue: '',
			createdAt: 1,
			state: 'idle',
		},
		{
			id: 'tab-3',
			agentSessionId: null,
			name: 'Three',
			starred: false,
			inputValue: '',
			createdAt: 2,
			state: 'idle',
		},
	];
}

describe('useMobileKeyboardHandler', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('toggles input mode with Cmd+J', () => {
		const handleModeToggle = vi.fn();
		const handleSelectTab = vi.fn();
		const activeSession: MobileKeyboardSession = { inputMode: 'ai' };

		renderHook(() =>
			useMobileKeyboardHandler({
				activeSessionId: 'session-1',
				activeSession,
				handleModeToggle,
				handleSelectTab,
			})
		);

		const event = new KeyboardEvent('keydown', { key: 'j', metaKey: true, cancelable: true });

		act(() => {
			document.dispatchEvent(event);
		});

		expect(handleModeToggle).toHaveBeenCalledTimes(1);
		expect(handleModeToggle).toHaveBeenCalledWith('terminal');
	});

	it('toggles terminal mode to AI with Ctrl+J and defaults missing mode to AI', () => {
		const handleModeToggle = vi.fn();
		const handleSelectTab = vi.fn();
		const { rerender } = renderHook(
			({ activeSession }) =>
				useMobileKeyboardHandler({
					activeSessionId: 'session-1',
					activeSession,
					handleModeToggle,
					handleSelectTab,
				}),
			{
				initialProps: {
					activeSession: { inputMode: 'terminal' } as MobileKeyboardSession,
				},
			}
		);

		act(() => {
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, cancelable: true })
			);
		});

		expect(handleModeToggle).toHaveBeenCalledWith('ai');

		rerender({ activeSession: {} });

		act(() => {
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, cancelable: true })
			);
		});

		expect(handleModeToggle).toHaveBeenLastCalledWith('terminal');
	});

	it('cycles to previous and next tabs with Cmd+[ and Cmd+]', () => {
		const handleModeToggle = vi.fn();
		const handleSelectTab = vi.fn();
		const tabs = createTabs();
		const activeSession: MobileKeyboardSession = {
			inputMode: 'ai',
			aiTabs: tabs,
			activeTabId: 'tab-2',
		};

		renderHook(() =>
			useMobileKeyboardHandler({
				activeSessionId: 'session-1',
				activeSession,
				handleModeToggle,
				handleSelectTab,
			})
		);

		const prevEvent = new KeyboardEvent('keydown', { key: '[', metaKey: true, cancelable: true });
		const nextEvent = new KeyboardEvent('keydown', { key: ']', metaKey: true, cancelable: true });

		act(() => {
			document.dispatchEvent(prevEvent);
		});

		expect(handleSelectTab).toHaveBeenCalledWith('tab-1');

		act(() => {
			document.dispatchEvent(nextEvent);
		});

		expect(handleSelectTab).toHaveBeenCalledWith('tab-3');
	});

	it('wraps previous and next tab shortcuts at list boundaries', () => {
		const handleModeToggle = vi.fn();
		const handleSelectTab = vi.fn();
		const tabs = createTabs();
		const { rerender } = renderHook(
			({ activeTabId }) =>
				useMobileKeyboardHandler({
					activeSessionId: 'session-1',
					activeSession: {
						inputMode: 'ai',
						aiTabs: tabs,
						activeTabId,
					},
					handleModeToggle,
					handleSelectTab,
				}),
			{ initialProps: { activeTabId: 'tab-1' } }
		);

		act(() => {
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: '[', ctrlKey: true, cancelable: true })
			);
		});

		expect(handleSelectTab).toHaveBeenCalledWith('tab-3');

		rerender({ activeTabId: 'tab-3' });

		act(() => {
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: ']', ctrlKey: true, cancelable: true })
			);
		});

		expect(handleSelectTab).toHaveBeenLastCalledWith('tab-1');
	});

	it('ignores tab shortcuts when there are too few tabs or active tab is missing', () => {
		const handleModeToggle = vi.fn();
		const handleSelectTab = vi.fn();
		const { rerender } = renderHook(
			({ activeSession }) =>
				useMobileKeyboardHandler({
					activeSessionId: 'session-1',
					activeSession,
					handleModeToggle,
					handleSelectTab,
				}),
			{
				initialProps: {
					activeSession: {
						aiTabs: [createTabs()[0]],
						activeTabId: 'tab-1',
					} as MobileKeyboardSession,
				},
			}
		);

		act(() => {
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: '[', metaKey: true, cancelable: true })
			);
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: ']', metaKey: true, cancelable: true })
			);
		});

		expect(handleSelectTab).not.toHaveBeenCalled();

		rerender({
			activeSession: {
				aiTabs: createTabs(),
				activeTabId: 'missing-tab',
			},
		});

		act(() => {
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: '[', metaKey: true, cancelable: true })
			);
			document.dispatchEvent(
				new KeyboardEvent('keydown', { key: ']', metaKey: true, cancelable: true })
			);
		});

		expect(handleSelectTab).not.toHaveBeenCalled();
	});

	it('ignores unrelated keyboard events', () => {
		const handleModeToggle = vi.fn();
		const handleSelectTab = vi.fn();
		renderHook(() =>
			useMobileKeyboardHandler({
				activeSessionId: 'session-1',
				activeSession: {
					inputMode: 'ai',
					aiTabs: createTabs(),
					activeTabId: 'tab-1',
				},
				handleModeToggle,
				handleSelectTab,
			})
		);

		act(() => {
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', metaKey: true }));
			document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
			document.dispatchEvent(new KeyboardEvent('keydown', { key: '[', altKey: true }));
		});

		expect(handleModeToggle).not.toHaveBeenCalled();
		expect(handleSelectTab).not.toHaveBeenCalled();
	});

	it('does not handle shortcuts when there is no active session', () => {
		const handleModeToggle = vi.fn();
		const handleSelectTab = vi.fn();

		renderHook(() =>
			useMobileKeyboardHandler({
				activeSessionId: null,
				activeSession: null,
				handleModeToggle,
				handleSelectTab,
			})
		);

		const event = new KeyboardEvent('keydown', { key: 'j', metaKey: true, cancelable: true });

		act(() => {
			document.dispatchEvent(event);
		});

		expect(handleModeToggle).not.toHaveBeenCalled();
	});
});
