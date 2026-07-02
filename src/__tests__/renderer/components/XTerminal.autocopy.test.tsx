import React from 'react';
import { render, act, cleanup } from '@testing-library/react';
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
			focus: ReturnType<typeof vi.fn>;
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

// ---------------------------------------------------------------------------
// Tap-to-focus (mobile keyboard). Tapping the viewport must focus the terminal
// (its hidden helper textarea) so mobile browsers summon the soft keyboard. A
// scroll/drag gesture must NOT focus, so the keyboard doesn't pop while the user
// is scrolling the scrollback. Reuses the shared xterm mocks above; the mock
// Terminal exposes `focus` as a vi.fn() per instance.
// ---------------------------------------------------------------------------

/** Dispatch a native touch event with a single point. jsdom lacks TouchEvent, so
 *  we synthesize the touches/changedTouches lists the handler reads. */
function fireTouch(el: Element, type: 'touchstart' | 'touchend', x: number, y: number): void {
	const event = new Event(type, { bubbles: true, cancelable: true });
	const point = { clientX: x, clientY: y } as Touch;
	Object.defineProperty(event, 'touches', {
		value: type === 'touchend' ? [] : [point],
	});
	Object.defineProperty(event, 'changedTouches', { value: [point] });
	el.dispatchEvent(event);
}

describe('XTerminal tap-to-focus (mobile keyboard)', () => {
	beforeEach(() => {
		mockTerminalInstances.length = 0;
		window.maestro.process.onData = vi.fn().mockReturnValue(() => {});
		window.maestro.process.resize = vi.fn().mockResolvedValue(undefined);
	});

	function renderTerminal(): { container: Element } {
		const { container } = render(
			<XTerminal
				sessionId="session-1-terminal-tab-1"
				theme={theme}
				fontFamily="Menlo"
				fontSize={12}
			/>
		);
		return { container };
	}

	/** The inner div holds the xterm viewport and carries the touch listeners. */
	function viewport(container: Element): Element {
		return container.querySelectorAll('div')[1];
	}

	it('focuses the terminal when the viewport is tapped (no movement)', () => {
		const { container } = renderTerminal();
		const term = mockTerminalInstances[0];
		expect(term.focus).not.toHaveBeenCalled();

		const el = viewport(container);
		act(() => {
			fireTouch(el, 'touchstart', 100, 100);
			fireTouch(el, 'touchend', 101, 102);
		});

		expect(term.focus).toHaveBeenCalledTimes(1);
	});

	it('does NOT focus the terminal on a scroll gesture (finger travels past tolerance)', () => {
		const { container } = renderTerminal();
		const term = mockTerminalInstances[0];

		const el = viewport(container);
		act(() => {
			fireTouch(el, 'touchstart', 100, 100);
			// Scrolled ~80px down the scrollback — not a tap.
			fireTouch(el, 'touchend', 102, 180);
		});

		expect(term.focus).not.toHaveBeenCalled();
	});

	it('stops focusing after unmount (listeners are torn down)', () => {
		const { container } = renderTerminal();
		const term = mockTerminalInstances[0];
		const el = viewport(container);

		act(() => {
			fireTouch(el, 'touchstart', 50, 50);
			fireTouch(el, 'touchend', 50, 50);
		});
		expect(term.focus).toHaveBeenCalledTimes(1);

		cleanup();

		// A tap on the detached element must not reach the disposed terminal.
		act(() => {
			fireTouch(el, 'touchstart', 50, 50);
			fireTouch(el, 'touchend', 50, 50);
		});
		expect(term.focus).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Sticky-Ctrl bridge (touch key bar). When the touch key bar's Ctrl key is
// armed, the NEXT single character typed into the terminal is folded into its
// control code (e.g. 'c' -> \x03) and the arm is consumed. Multi-byte input
// (paste, IME) passes through untouched and does NOT consume the arm. Without a
// stickyCtrl prop (the native desktop app), input is a pure pass-through. The
// arm/disarm state machine itself is covered by TerminalView's tests; here we
// cover XTerminal's side - applying the armed state to terminal input. The full
// toControlChar mapping table is unit-tested in terminalKeys.test.ts, so these
// only exercise XTerminal's branching around it.
// ---------------------------------------------------------------------------

type StickyCtrlBridge = { isActive: () => boolean; onConsume: () => void };

describe('XTerminal sticky-Ctrl (touch key bar)', () => {
	const SESSION_ID = 'session-1-terminal-tab-1';

	beforeEach(() => {
		mockTerminalInstances.length = 0;
		window.maestro.process.onData = vi.fn().mockReturnValue(() => {});
		window.maestro.process.resize = vi.fn().mockResolvedValue(undefined);
		vi.mocked(window.maestro.process.write).mockClear();
		vi.mocked(window.maestro.process.write).mockResolvedValue(undefined);
	});

	/** The callback XTerminal registered via term.onData - i.e. the terminal input
	 *  path that carries the sticky-Ctrl folding. */
	function inputHandler(): (data: string) => void {
		const term = mockTerminalInstances[0] as unknown as {
			onData: { mock: { calls: Array<[(data: string) => void]> } };
		};
		return term.onData.mock.calls[0][0];
	}

	function renderWith(stickyCtrl?: StickyCtrlBridge, onData?: (data: string) => void): void {
		render(
			<XTerminal
				sessionId={SESSION_ID}
				theme={theme}
				fontFamily="Menlo"
				fontSize={12}
				stickyCtrl={stickyCtrl}
				onData={onData}
			/>
		);
	}

	it('folds the next single character to its control code and consumes the arm when armed', () => {
		const onConsume = vi.fn();
		const onData = vi.fn();
		renderWith({ isActive: () => true, onConsume }, onData);

		act(() => inputHandler()('c'));

		// 'c' -> Ctrl-C (\x03) reaches both the PTY and the onData callback.
		expect(window.maestro.process.write).toHaveBeenCalledWith(SESSION_ID, '\x03');
		expect(onData).toHaveBeenCalledWith('\x03');
		expect(onConsume).toHaveBeenCalledTimes(1);
	});

	it('leaves multi-byte input (paste/IME) untouched and does NOT consume the arm', () => {
		const onConsume = vi.fn();
		renderWith({ isActive: () => true, onConsume });

		act(() => inputHandler()('hello'));

		expect(window.maestro.process.write).toHaveBeenCalledWith(SESSION_ID, 'hello');
		expect(onConsume).not.toHaveBeenCalled();
	});

	it('passes input through unchanged when the bridge is not armed', () => {
		const onConsume = vi.fn();
		renderWith({ isActive: () => false, onConsume });

		act(() => inputHandler()('c'));

		expect(window.maestro.process.write).toHaveBeenCalledWith(SESSION_ID, 'c');
		expect(onConsume).not.toHaveBeenCalled();
	});

	it('is a pure pass-through with no stickyCtrl prop (native desktop app)', () => {
		const onData = vi.fn();
		renderWith(undefined, onData);

		act(() => inputHandler()('c'));

		expect(window.maestro.process.write).toHaveBeenCalledWith(SESSION_ID, 'c');
		expect(onData).toHaveBeenCalledWith('c');
	});
});
