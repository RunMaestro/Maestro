import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputProvider, useInputContext } from '../../renderer/contexts/InputContext';

function wrapper({ children }: { children: React.ReactNode }) {
	return <InputProvider>{children}</InputProvider>;
}

function expectDefaultState(result: { current: ReturnType<typeof useInputContext> }) {
	expect(result.current).toMatchObject({
		slashCommandOpen: false,
		selectedSlashCommandIndex: 0,
		tabCompletionOpen: false,
		selectedTabCompletionIndex: 0,
		tabCompletionFilter: 'all',
		atMentionOpen: false,
		atMentionFilter: '',
		atMentionStartIndex: -1,
		selectedAtMentionIndex: 0,
		commandHistoryOpen: false,
		commandHistoryFilter: '',
		commandHistorySelectedIndex: 0,
	});
}

describe('InputContext', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('requires useInputContext to be called inside InputProvider', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const preventExpectedWindowError = (event: ErrorEvent) => {
			event.preventDefault();
		};

		window.addEventListener('error', preventExpectedWindowError);
		try {
			expect(() => renderHook(() => useInputContext())).toThrow(
				'useInputContext must be used within an InputProvider'
			);
		} finally {
			window.removeEventListener('error', preventExpectedWindowError);
			consoleError.mockRestore();
		}
	});

	it('provides default completion and command history state', () => {
		const { result } = renderHook(() => useInputContext(), { wrapper });

		expectDefaultState(result);
		expect(result.current.resetSlashCommand).toEqual(expect.any(Function));
		expect(result.current.resetTabCompletion).toEqual(expect.any(Function));
		expect(result.current.resetAtMention).toEqual(expect.any(Function));
		expect(result.current.resetCommandHistory).toEqual(expect.any(Function));
		expect(result.current.closeAllCompletions).toEqual(expect.any(Function));
	});

	it('resets slash command state without changing other completion state', () => {
		const { result } = renderHook(() => useInputContext(), { wrapper });

		act(() => {
			result.current.setSlashCommandOpen(true);
			result.current.setSelectedSlashCommandIndex(4);
			result.current.setTabCompletionOpen(true);
			result.current.setSelectedTabCompletionIndex(2);
		});

		act(() => {
			result.current.resetSlashCommand();
		});

		expect(result.current.slashCommandOpen).toBe(false);
		expect(result.current.selectedSlashCommandIndex).toBe(0);
		expect(result.current.tabCompletionOpen).toBe(true);
		expect(result.current.selectedTabCompletionIndex).toBe(2);
	});

	it('resets tab completion state to the all filter', () => {
		const { result } = renderHook(() => useInputContext(), { wrapper });

		act(() => {
			result.current.setTabCompletionOpen(true);
			result.current.setSelectedTabCompletionIndex(3);
			result.current.setTabCompletionFilter('branch');
		});

		act(() => {
			result.current.resetTabCompletion();
		});

		expect(result.current.tabCompletionOpen).toBe(false);
		expect(result.current.selectedTabCompletionIndex).toBe(0);
		expect(result.current.tabCompletionFilter).toBe('all');
	});

	it('resets at-mention state including the tracked input start index', () => {
		const { result } = renderHook(() => useInputContext(), { wrapper });

		act(() => {
			result.current.setAtMentionOpen(true);
			result.current.setAtMentionFilter('readme');
			result.current.setAtMentionStartIndex(12);
			result.current.setSelectedAtMentionIndex(5);
		});

		act(() => {
			result.current.resetAtMention();
		});

		expect(result.current.atMentionOpen).toBe(false);
		expect(result.current.atMentionFilter).toBe('');
		expect(result.current.atMentionStartIndex).toBe(-1);
		expect(result.current.selectedAtMentionIndex).toBe(0);
	});

	it('resets command history state', () => {
		const { result } = renderHook(() => useInputContext(), { wrapper });

		act(() => {
			result.current.setCommandHistoryOpen(true);
			result.current.setCommandHistoryFilter('deploy');
			result.current.setCommandHistorySelectedIndex(6);
		});

		act(() => {
			result.current.resetCommandHistory();
		});

		expect(result.current.commandHistoryOpen).toBe(false);
		expect(result.current.commandHistoryFilter).toBe('');
		expect(result.current.commandHistorySelectedIndex).toBe(0);
	});

	it('closes every completion surface and command history together', () => {
		const { result } = renderHook(() => useInputContext(), { wrapper });

		act(() => {
			result.current.setSlashCommandOpen(true);
			result.current.setSelectedSlashCommandIndex(7);
			result.current.setTabCompletionOpen(true);
			result.current.setSelectedTabCompletionIndex(3);
			result.current.setTabCompletionFilter('file');
			result.current.setAtMentionOpen(true);
			result.current.setAtMentionFilter('src');
			result.current.setAtMentionStartIndex(2);
			result.current.setSelectedAtMentionIndex(8);
			result.current.setCommandHistoryOpen(true);
			result.current.setCommandHistoryFilter('npm');
			result.current.setCommandHistorySelectedIndex(9);
		});

		act(() => {
			result.current.closeAllCompletions();
		});

		expectDefaultState(result);
	});
});
