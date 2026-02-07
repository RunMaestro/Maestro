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

const lightTheme: Theme = {
	id: 'github-light',
	name: 'GitHub',
	mode: 'light',
	colors: {
		bgMain: '#ffffff',
		bgSidebar: '#f6f8fa',
		bgActivity: '#eff2f5',
		border: '#d0d7de',
		textMain: '#24292f',
		textDim: '#57606a',
		accent: '#0969da',
		accentDim: 'rgba(9, 105, 218, 0.1)',
		accentText: '#0969da',
		accentForeground: '#ffffff',
		success: '#1a7f37',
		warning: '#9a6700',
		error: '#cf222e',
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
		const expectedSearchOptions = {
			caseSensitive: false,
			wholeWord: false,
			regex: false,
			incremental: true,
			decorations: {
				matchBackground: '#e0af68',
				matchBorder: '#e0af68',
				matchOverviewRuler: '#e0af68',
				activeMatchBackground: '#7aa2f7',
				activeMatchBorder: '#7dcfff',
				activeMatchColorOverviewRuler: '#7aa2f7',
			},
		};

		expect(terminal.options).toMatchObject({
			cursorBlink: true,
			cursorStyle: 'block',
			fontFamily: 'Monaco',
			fontSize: 14,
			theme: {
				background: '#1a1b26',
				foreground: '#c0caf5',
				cursor: '#7aa2f7',
				cursorAccent: '#1a1b26',
				selectionBackground: 'rgba(255, 255, 255, 0.2)',
				selectionInactiveBackground: 'rgba(255, 255, 255, 0.2)',
				selectionForeground: undefined,
				black: '#282c34',
				red: '#e06c75',
				green: '#98c379',
				yellow: '#e5c07b',
				blue: '#61afef',
				magenta: '#c678dd',
				cyan: '#56b6c2',
				white: '#abb2bf',
				brightBlack: '#5c6370',
				brightRed: '#e06c75',
				brightGreen: '#98c379',
				brightYellow: '#e5c07b',
				brightBlue: '#61afef',
				brightMagenta: '#c678dd',
				brightCyan: '#56b6c2',
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
		expect(ref.current?.search('')).toBe(false);
		expect(ref.current?.searchNext()).toBe(false);
		expect(ref.current?.searchPrevious()).toBe(false);
		expect(searchAddon.findNext).toHaveBeenNthCalledWith(1, 'needle', {
			caseSensitive: false,
			wholeWord: false,
			regex: false,
			incremental: true,
			decorations: {
				matchBackground: '#e0af68',
				matchBorder: '#e0af68',
				matchOverviewRuler: '#e0af68',
				activeMatchBackground: '#7aa2f7',
				activeMatchBorder: '#7dcfff',
				activeMatchColorOverviewRuler: '#7aa2f7',
			},
		});
		expect(searchAddon.findNext).toHaveBeenNthCalledWith(2, 'needle', expectedSearchOptions);
		expect(searchAddon.findNext).toHaveBeenCalledTimes(2);
		expect(searchAddon.findPrevious).toHaveBeenCalledWith('needle', expectedSearchOptions);
		expect(searchAddon.findPrevious).toHaveBeenCalledTimes(1);
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

	it('uses light defaults and honors ANSI overrides when present', () => {
		const themeWithOverrides: Theme = {
			...lightTheme,
			colors: {
				...lightTheme.colors,
				selection: 'rgba(20, 40, 60, 0.4)',
				ansiRed: '#aa0011',
				ansiBrightWhite: '#fafafa',
			},
		};

		act(() => {
			root.render(
				<XTerminal sessionId="session-light" theme={themeWithOverrides} fontFamily="Monaco" />
			);
		});

		const terminal = mocks.terminalInstances[0];
		const xtermTheme = terminal.options.theme as Record<string, string | undefined>;

		expect(xtermTheme.black).toBe('#073642');
		expect(xtermTheme.red).toBe('#aa0011');
		expect(xtermTheme.brightWhite).toBe('#fafafa');
		expect(xtermTheme.selectionBackground).toBe('rgba(20, 40, 60, 0.4)');
		expect(xtermTheme.selectionInactiveBackground).toBe('rgba(20, 40, 60, 0.4)');
	});

	it('updates terminal theme when the Maestro theme prop changes', () => {
		act(() => {
			root.render(<XTerminal sessionId="session-theme" theme={theme} fontFamily="Monaco" />);
		});

		expect(mocks.terminalInstances).toHaveLength(1);

		const terminal = mocks.terminalInstances[0];
		let xtermTheme = terminal.options.theme as Record<string, string | undefined>;
		expect(xtermTheme.background).toBe('#1a1b26');
		expect(xtermTheme.selectionBackground).toBe('rgba(255, 255, 255, 0.2)');

		act(() => {
			root.render(<XTerminal sessionId="session-theme" theme={lightTheme} fontFamily="Monaco" />);
		});

		expect(mocks.terminalInstances).toHaveLength(1);
		xtermTheme = terminal.options.theme as Record<string, string | undefined>;
		expect(xtermTheme.background).toBe('#ffffff');
		expect(xtermTheme.foreground).toBe('#24292f');
		expect(xtermTheme.selectionBackground).toBe('rgba(0, 0, 0, 0.2)');
		expect(xtermTheme.red).toBe('#dc322f');
	});

	it('uses a sensible cursor default and applies cursor option updates', () => {
		act(() => {
			root.render(<XTerminal sessionId="session-cursor" theme={theme} fontFamily="Monaco" />);
		});

		expect(mocks.terminalInstances).toHaveLength(1);
		const terminal = mocks.terminalInstances[0];
		expect(terminal.options.cursorBlink).toBe(true);
		expect(terminal.options.cursorStyle).toBe('block');

		act(() => {
			root.render(
				<XTerminal
					sessionId="session-cursor"
					theme={theme}
					fontFamily="Monaco"
					cursorBlink={false}
					cursorStyle="underline"
				/>
			);
		});

		expect(mocks.terminalInstances).toHaveLength(1);
		expect(terminal.options.cursorBlink).toBe(false);
		expect(terminal.options.cursorStyle).toBe('underline');
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
