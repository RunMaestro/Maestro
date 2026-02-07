import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	terminalInstances: [] as any[],
	fitAddonInstances: [] as any[],
	webglAddonInstances: [] as any[],
	webLinksAddonInstances: [] as any[],
	searchAddonInstances: [] as any[],
	unicode11AddonInstances: [] as any[],
}));

vi.mock('@xterm/xterm', () => {
	class MockTerminal {
		options: Record<string, unknown>;
		cols = 80;
		rows = 24;
		unicode = { activeVersion: '' };
		dataHandler: ((data: string) => void) | null = null;
		dataDisposable = {
			dispose: vi.fn(() => {
				this.dataHandler = null;
			}),
		};
		loadAddon = vi.fn();
		onData = vi.fn((handler: (data: string) => void) => {
			this.dataHandler = handler;
			return this.dataDisposable;
		});
		open = vi.fn();
		dispose = vi.fn();
		write = vi.fn();
		focus = vi.fn();
		clear = vi.fn();
		scrollToBottom = vi.fn();
		getSelection = vi.fn(() => 'selected-text');
		emitData = (data: string) => {
			this.dataHandler?.(data);
		};

		constructor(options: Record<string, unknown>) {
			this.options = options;
			mocks.terminalInstances.push(this);
		}
	}

	return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => {
	class MockFitAddon {
		fit = vi.fn();

		constructor() {
			mocks.fitAddonInstances.push(this);
		}
	}

	return { FitAddon: MockFitAddon };
});

vi.mock('@xterm/addon-webgl', () => {
	class MockWebglAddon {
		onContextLoss = vi.fn();
		dispose = vi.fn();

		constructor() {
			mocks.webglAddonInstances.push(this);
		}
	}

	return { WebglAddon: MockWebglAddon };
});

vi.mock('@xterm/addon-web-links', () => {
	class MockWebLinksAddon {
		constructor() {
			mocks.webLinksAddonInstances.push(this);
		}
	}

	return { WebLinksAddon: MockWebLinksAddon };
});

vi.mock('@xterm/addon-search', () => {
	class MockSearchAddon {
		findNext = vi.fn(() => false);
		findPrevious = vi.fn(() => false);

		constructor() {
			mocks.searchAddonInstances.push(this);
		}
	}

	return { SearchAddon: MockSearchAddon };
});

vi.mock('@xterm/addon-unicode11', () => {
	class MockUnicode11Addon {
		constructor() {
			mocks.unicode11AddonInstances.push(this);
		}
	}

	return { Unicode11Addon: MockUnicode11Addon };
});

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { XTerminal, type XTerminalHandle } from '../../../renderer/components/XTerminal';
import type { Theme } from '../../../renderer/types';

const theme: Theme = {
	id: 'tokyo-night',
	name: 'Tokyo Night',
	mode: 'dark',
	colors: {
		bgMain: '#1a1b26',
		bgSidebar: '#16161e',
		bgActivity: '#202331',
		border: '#2f3549',
		textMain: '#c0caf5',
		textDim: '#9aa5ce',
		accent: '#7aa2f7',
		accentDim: '#3b4261',
		accentText: '#7dcfff',
		accentForeground: '#1a1b26',
		success: '#9ece6a',
		warning: '#e0af68',
		error: '#f7768e',
	},
};

describe('XTerminal', () => {
	let container: HTMLDivElement;
	let root: Root;
	let processDataHandler: ((sessionId: string, data: string) => void) | null;
	let processDataUnsubscribe: ReturnType<typeof vi.fn>;
	let processOnDataMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		mocks.terminalInstances.length = 0;
		mocks.fitAddonInstances.length = 0;
		mocks.webglAddonInstances.length = 0;
		mocks.webLinksAddonInstances.length = 0;
		mocks.searchAddonInstances.length = 0;
		mocks.unicode11AddonInstances.length = 0;
		vi.clearAllMocks();
		container = document.createElement('div');
		document.body.appendChild(container);
		root = createRoot(container);
		processDataHandler = null;
		processDataUnsubscribe = vi.fn();
		processOnDataMock = vi.fn((handler: (sessionId: string, data: string) => void) => {
			processDataHandler = handler;
			return processDataUnsubscribe;
		});
		(
			(globalThis as any).window.maestro.process as unknown as { onData: typeof processOnDataMock }
		).onData = processOnDataMock;
	});

	afterEach(() => {
		if (container.firstChild) {
			act(() => {
				root.unmount();
			});
		}
		vi.useRealTimers();
		container.remove();
	});

	it('renders a terminal container scaffold', () => {
		act(() => {
			root.render(
				<XTerminal sessionId="session-1" theme={theme} fontFamily="Menlo" fontSize={15} />
			);
		});

		expect(mocks.terminalInstances).toHaveLength(1);
		expect(mocks.fitAddonInstances).toHaveLength(1);
		expect(mocks.webglAddonInstances).toHaveLength(1);
		expect(mocks.webLinksAddonInstances).toHaveLength(1);
		expect(mocks.searchAddonInstances).toHaveLength(1);
		expect(mocks.unicode11AddonInstances).toHaveLength(1);

		const terminalContainer = container.firstElementChild as HTMLElement;
		expect(terminalContainer).toBeTruthy();
		expect(terminalContainer.dataset.sessionId).toBe('session-1');
		expect(terminalContainer.dataset.themeId).toBe('tokyo-night');
		expect(terminalContainer.dataset.fontFamily).toBe('Menlo');
		expect(terminalContainer.dataset.fontSize).toBe('15');
	});

	it('initializes terminal lifecycle and exposes imperative methods', () => {
		const ref = createRef<XTerminalHandle>();

		act(() => {
			root.render(<XTerminal ref={ref} sessionId="session-2" theme={theme} fontFamily="Monaco" />);
		});

		const terminal = mocks.terminalInstances[0];
		const fitAddon = mocks.fitAddonInstances[0];
		const webglAddon = mocks.webglAddonInstances[0];
		const searchAddon = mocks.searchAddonInstances[0];

		expect(terminal.options).toMatchObject({
			cursorBlink: true,
			cursorStyle: 'block',
			fontFamily: 'Monaco',
			fontSize: 14,
			theme: {
				background: '#1a1b26',
				foreground: '#c0caf5',
				cursor: '#c0caf5',
				cursorAccent: '#1a1b26',
				selectionBackground: '#3b4261',
				selectionInactiveBackground: '#3b4261',
				selectionForeground: '#c0caf5',
				black: '#000000',
				red: '#f7768e',
				green: '#9ece6a',
				yellow: '#e0af68',
				blue: '#7aa2f7',
				magenta: '#c678dd',
				cyan: '#7dcfff',
				white: '#c0caf5',
				brightBlack: '#9aa5ce',
				brightRed: '#f7768e',
				brightGreen: '#9ece6a',
				brightYellow: '#e0af68',
				brightBlue: '#7aa2f7',
				brightMagenta: '#c678dd',
				brightCyan: '#7dcfff',
				brightWhite: '#ffffff',
			},
			scrollback: 10000,
		});
		expect(terminal.unicode.activeVersion).toBe('11');
		expect(terminal.open).toHaveBeenCalledTimes(1);
		expect(fitAddon.fit).toHaveBeenCalledTimes(1);
		expect(webglAddon.onContextLoss).toHaveBeenCalledTimes(1);

		expect(ref.current).toBeTruthy();
		expect(ref.current?.search('needle')).toBe(false);
		expect(ref.current?.searchNext()).toBe(false);
		expect(ref.current?.searchPrevious()).toBe(false);
		expect(searchAddon.findNext).toHaveBeenNthCalledWith(1, 'needle');
		expect(searchAddon.findNext).toHaveBeenNthCalledWith(2, 'needle');
		expect(searchAddon.findPrevious).toHaveBeenCalledWith('needle');
		expect(ref.current?.getSelection()).toBe('selected-text');
		expect(() => {
			ref.current?.write('echo test');
			ref.current?.focus();
			ref.current?.clear();
			ref.current?.scrollToBottom();
			ref.current?.resize();
		}).not.toThrow();

		expect(terminal.write).toHaveBeenCalledWith('echo test');
		expect(terminal.focus).toHaveBeenCalledTimes(1);
		expect(terminal.clear).toHaveBeenCalledTimes(1);
		expect(terminal.scrollToBottom).toHaveBeenCalledTimes(1);
		expect(fitAddon.fit).toHaveBeenCalledTimes(2);

		act(() => {
			root.unmount();
		});

		expect(webglAddon.dispose).toHaveBeenCalledTimes(1);
		expect(terminal.dispose).toHaveBeenCalledTimes(1);
	});

	it('applies default font size when omitted', () => {
		act(() => {
			root.render(<XTerminal sessionId="session-3" theme={theme} fontFamily="Monaco" />);
		});

		const terminalContainer = container.firstElementChild as HTMLElement;
		expect(terminalContainer.dataset.fontSize).toBe('14');
	});

	it('handles debounced resize and notifies PTY + callbacks', () => {
		vi.useFakeTimers();
		const onResize = vi.fn();
		const processResize = (globalThis as any).window.maestro.process.resize as ReturnType<
			typeof vi.fn
		>;

		act(() => {
			root.render(
				<XTerminal
					sessionId="session-resize"
					theme={theme}
					fontFamily="Monaco"
					onResize={onResize}
				/>
			);
		});

		const fitAddon = mocks.fitAddonInstances[0];
		expect(fitAddon.fit).toHaveBeenCalledTimes(1);

		act(() => {
			vi.advanceTimersByTime(99);
		});

		expect(onResize).not.toHaveBeenCalled();
		expect(processResize).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(1);
		});

		expect(fitAddon.fit).toHaveBeenCalledTimes(2);
		expect(onResize).toHaveBeenCalledWith(80, 24);
		expect(processResize).toHaveBeenCalledWith('session-resize', 80, 24);
	});

	it('clears pending resize debounce on unmount', () => {
		vi.useFakeTimers();
		const processResize = (globalThis as any).window.maestro.process.resize as ReturnType<
			typeof vi.fn
		>;

		act(() => {
			root.render(<XTerminal sessionId="session-cleanup" theme={theme} fontFamily="Monaco" />);
		});

		act(() => {
			vi.advanceTimersByTime(0);
		});

		act(() => {
			root.unmount();
		});

		act(() => {
			vi.advanceTimersByTime(100);
		});

		expect(processResize).not.toHaveBeenCalled();
	});

	it('bridges PTY data to terminal and terminal input back to PTY', () => {
		const onInputData = vi.fn();
		const processWrite = (globalThis as any).window.maestro.process.write as ReturnType<
			typeof vi.fn
		>;

		act(() => {
			root.render(
				<XTerminal sessionId="session-pty" theme={theme} fontFamily="Monaco" onData={onInputData} />
			);
		});

		expect(processOnDataMock).toHaveBeenCalledTimes(1);
		expect(processDataHandler).toBeTypeOf('function');

		act(() => {
			processDataHandler?.('session-other', 'ignore-me');
			processDataHandler?.('session-pty', 'server-output');
		});

		const terminal = mocks.terminalInstances[0];
		expect(terminal.write).toHaveBeenCalledTimes(1);
		expect(terminal.write).toHaveBeenCalledWith('server-output');

		act(() => {
			terminal.emitData('user-input');
		});

		expect(processWrite).toHaveBeenCalledWith('session-pty', 'user-input');
		expect(onInputData).toHaveBeenCalledWith('user-input');

		const inputDisposable = terminal.onData.mock.results[0].value as {
			dispose: ReturnType<typeof vi.fn>;
		};

		act(() => {
			root.unmount();
		});

		expect(processDataUnsubscribe).toHaveBeenCalledTimes(1);
		expect(inputDisposable.dispose).toHaveBeenCalledTimes(1);
	});
});
