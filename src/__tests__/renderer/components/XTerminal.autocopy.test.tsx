import React from 'react';
import { render, act } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { XTerminal } from '../../../renderer/components/XTerminal';
import type { Theme } from '../../../shared/theme-types';

const { mockSafeClipboardWrite, mockTerminalInstances, mockFit, mockResize, mockOnData } =
	vi.hoisted(() => ({
		mockSafeClipboardWrite: vi.fn(),
		mockTerminalInstances: [] as Array<{
			selection: string;
			selectionListeners: Array<() => void>;
			triggerSelectionChange(): void;
		}>,
		mockFit: vi.fn(),
		mockResize: vi.fn(),
		mockOnData: vi.fn(),
	}));

vi.mock('../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: (...args: unknown[]) => mockSafeClipboardWrite(...args),
}));

vi.mock('@xterm/addon-fit', () => ({
	FitAddon: class {
		fit = mockFit;
	},
}));

vi.mock('@xterm/addon-search', () => ({
	SearchAddon: class {
		findNext = vi.fn().mockReturnValue(false);
		findPrevious = vi.fn().mockReturnValue(false);
	},
}));

vi.mock('@xterm/addon-unicode11', () => ({
	Unicode11Addon: class {},
}));

vi.mock('@xterm/addon-webgl', () => ({
	WebglAddon: class {
		onContextLoss = vi.fn();
		dispose = vi.fn();
	},
}));

vi.mock('@xterm/xterm', () => ({
	Terminal: class {
		selection = '';
		selectionListeners: Array<() => void> = [];
		rows = 24;
		cols = 80;
		options: Record<string, unknown>;
		unicode = { activeVersion: '' };
		buffer = {
			active: {
				length: 0,
				getLine: vi.fn(),
			},
		};

		constructor(options: Record<string, unknown>) {
			this.options = options;
			mockTerminalInstances.push(this);
		}

		loadAddon = vi.fn();
		registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
		attachCustomKeyEventHandler = vi.fn();
		open = vi.fn();
		write = vi.fn();
		focus = vi.fn();
		clear = vi.fn();
		scrollToBottom = vi.fn();
		refresh = vi.fn();
		dispose = vi.fn();
		onTitleChange = vi.fn(() => ({ dispose: vi.fn() }));
		onData = vi.fn(() => ({ dispose: vi.fn() }));
		getSelection = vi.fn(() => this.selection);
		onSelectionChange = vi.fn((listener: () => void) => {
			this.selectionListeners.push(listener);
			return {
				dispose: () => {
					this.selectionListeners = this.selectionListeners.filter((entry) => entry !== listener);
				},
			};
		});

		triggerSelectionChange() {
			this.selectionListeners.forEach((listener) => listener());
		}
	},
}));

const theme = {
	id: 'dark',
	name: 'Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		textMain: '#eeeeee',
		accent: '#00aaff',
		accentDim: '#004466',
		border: '#222222',
	},
} as unknown as Theme;

describe('XTerminal auto-copy selection', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockSafeClipboardWrite.mockReset();
		mockSafeClipboardWrite.mockResolvedValue(true);
		mockTerminalInstances.length = 0;
		mockFit.mockReset();
		mockResize.mockReset();
		mockOnData.mockReset();
		mockOnData.mockReturnValue(() => {});
		window.maestro.process.onData = mockOnData;
		window.maestro.process.resize = mockResize.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('copies the settled non-empty terminal selection to the clipboard', async () => {
		render(
			<XTerminal
				sessionId="session-1-terminal-tab-1"
				theme={theme}
				fontFamily="Menlo"
				fontSize={12}
			/>
		);

		const terminal = mockTerminalInstances[0];
		terminal.selection = 'partial';
		terminal.triggerSelectionChange();
		act(() => vi.advanceTimersByTime(60));

		terminal.selection = 'selected text';
		terminal.triggerSelectionChange();
		act(() => vi.advanceTimersByTime(119));
		expect(mockSafeClipboardWrite).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(1);
			await Promise.resolve();
		});

		expect(mockSafeClipboardWrite).toHaveBeenCalledTimes(1);
		expect(mockSafeClipboardWrite).toHaveBeenCalledWith('selected text');
	});

	it('skips duplicate selections until the selection is cleared', async () => {
		render(
			<XTerminal
				sessionId="session-1-terminal-tab-1"
				theme={theme}
				fontFamily="Menlo"
				fontSize={12}
			/>
		);

		const terminal = mockTerminalInstances[0];
		terminal.selection = 'same text';
		terminal.triggerSelectionChange();
		await act(async () => {
			vi.advanceTimersByTime(120);
			await Promise.resolve();
		});

		terminal.triggerSelectionChange();
		await act(async () => {
			vi.advanceTimersByTime(120);
			await Promise.resolve();
		});

		terminal.selection = '';
		terminal.triggerSelectionChange();
		await act(async () => {
			vi.advanceTimersByTime(120);
			await Promise.resolve();
		});

		terminal.selection = 'same text';
		terminal.triggerSelectionChange();
		await act(async () => {
			vi.advanceTimersByTime(120);
			await Promise.resolve();
		});

		expect(mockSafeClipboardWrite).toHaveBeenCalledTimes(2);
		expect(mockSafeClipboardWrite).toHaveBeenNthCalledWith(1, 'same text');
		expect(mockSafeClipboardWrite).toHaveBeenNthCalledWith(2, 'same text');
	});
});
