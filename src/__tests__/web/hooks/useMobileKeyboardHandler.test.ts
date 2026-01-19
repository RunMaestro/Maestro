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
