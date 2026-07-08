import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { WebTerminal, type WebTerminalHandle } from '../../../web/mobile/WebTerminal';
import type { Theme } from '../../../shared/theme-types';

const terminalMocks = vi.hoisted(() => {
	const terminalInstances: any[] = [];
	const fitInstances: any[] = [];
	const searchInstances: any[] = [];
	const unicodeInstances: any[] = [];

	class MockTerminal {
		options: any;
		cols = 80;
		rows = 24;
		unicode = { activeVersion: '' };
		buffer = {
			active: {
				getLine: vi.fn(() => ({
					translateToString: () => 'open https://example.com/docs.',
				})),
			},
		};
		loadAddon = vi.fn();
		registerLinkProvider = vi.fn((provider) => {
			this.linkProvider = provider;
			return { dispose: vi.fn() };
		});
		attachCustomKeyEventHandler = vi.fn((handler) => {
			this.keyHandler = handler;
		});
		open = vi.fn();
		onData = vi.fn((handler) => {
			this.dataHandler = handler;
			return { dispose: vi.fn() };
		});
		write = vi.fn();
		focus = vi.fn();
		clear = vi.fn();
		scrollToBottom = vi.fn();
		getSelection = vi.fn(() => '');
		dispose = vi.fn();
		keyHandler?: (event: KeyboardEvent) => boolean;
		dataHandler?: (data: string) => void;
		linkProvider?: any;

		constructor(options: any) {
			this.options = options;
			terminalInstances.push(this);
		}
	}

	class MockFitAddon {
		fit = vi.fn();
		constructor() {
			fitInstances.push(this);
		}
	}

	class MockSearchAddon {
		findNext = vi.fn(() => true);
		findPrevious = vi.fn(() => true);
		constructor() {
			searchInstances.push(this);
		}
	}

	class MockUnicode11Addon {
		constructor() {
			unicodeInstances.push(this);
		}
	}

	return {
		terminalInstances,
		fitInstances,
		searchInstances,
		unicodeInstances,
		MockTerminal,
		MockFitAddon,
		MockSearchAddon,
		MockUnicode11Addon,
	};
});

vi.mock('@xterm/xterm', () => ({
	Terminal: terminalMocks.MockTerminal,
}));

vi.mock('@xterm/addon-fit', () => ({
	FitAddon: terminalMocks.MockFitAddon,
}));

vi.mock('@xterm/addon-search', () => ({
	SearchAddon: terminalMocks.MockSearchAddon,
}));

vi.mock('@xterm/addon-unicode11', () => ({
	Unicode11Addon: terminalMocks.MockUnicode11Addon,
}));

const theme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101014',
		bgSidebar: '#18181c',
		bgActivity: '#202024',
		border: '#303036',
		textMain: '#f5f5f5',
		textDim: '#a0a0a0',
		accent: '#60a5fa',
		accentDim: '#1e3a8a',
		accentText: '#bfdbfe',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		selection: '#334155',
	},
};

function renderTerminal(overrides: Partial<Parameters<typeof WebTerminal>[0]> = {}) {
	const ref = createRef<WebTerminalHandle>();
	const props = {
		onData: vi.fn(),
		onResize: vi.fn(),
		theme,
		...overrides,
	};
	render(<WebTerminal ref={ref} {...props} />);
	const terminal = terminalMocks.terminalInstances.at(-1);
	const fit = terminalMocks.fitInstances.at(-1);
	const search = terminalMocks.searchInstances.at(-1);
	return { ref, props, terminal, fit, search };
}

describe('WebTerminal', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		terminalMocks.terminalInstances.length = 0;
		terminalMocks.fitInstances.length = 0;
		terminalMocks.searchInstances.length = 0;
		terminalMocks.unicodeInstances.length = 0;
		Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
			configurable: true,
			get() {
				return 500;
			},
		});
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: vi.fn().mockResolvedValue(undefined) },
		});
		vi.spyOn(window, 'open').mockImplementation(() => null);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('initializes xterm with theme, addons, unicode, fit, focus, and resize callback', () => {
		const { terminal, fit, props } = renderTerminal({ fontSize: 15 });

		expect(terminal.options.fontSize).toBe(15);
		expect(terminal.options.theme.background).toBe('#101014');
		expect(terminal.options.theme.foreground).toBe('#f5f5f5');
		expect(terminal.loadAddon).toHaveBeenCalledTimes(3);
		expect(terminal.unicode.activeVersion).toBe('11');
		expect(terminal.open).toHaveBeenCalled();
		expect(fit.fit).toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(150);
		});

		expect(props.onResize).toHaveBeenCalledWith(80, 24);
		expect(terminal.focus).toHaveBeenCalled();
	});

	it('exposes imperative terminal methods through the ref', () => {
		const { ref, terminal, fit, search } = renderTerminal();
		terminal.getSelection.mockReturnValue('selected');

		ref.current!.write('hello');
		ref.current!.focus();
		ref.current!.clear();
		ref.current!.scrollToBottom();
		const size = ref.current!.fitAndGetSize();
		const found = ref.current!.search('needle', { caseSensitive: true });
		const next = ref.current!.searchNext();
		const previous = ref.current!.searchPrevious();

		expect(terminal.write).toHaveBeenCalledWith('hello');
		expect(terminal.focus).toHaveBeenCalled();
		expect(terminal.clear).toHaveBeenCalled();
		expect(terminal.scrollToBottom).toHaveBeenCalled();
		expect(ref.current!.getSelection()).toBe('selected');
		expect(fit.fit).toHaveBeenCalled();
		expect(size).toEqual({ cols: 80, rows: 24 });
		expect(search.findNext).toHaveBeenCalledWith('needle', {
			incremental: true,
			caseSensitive: true,
		});
		expect(found).toBe(true);
		expect(next).toBe(true);
		expect(previous).toBe(true);
	});

	it('forwards PTY data and handles custom terminal navigation keys', () => {
		const { props, terminal } = renderTerminal();

		terminal.dataHandler?.('typed');
		expect(props.onData).toHaveBeenCalledWith('typed');

		expect(
			terminal.keyHandler?.(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true }))
		).toBe(false);
		expect(props.onData).toHaveBeenLastCalledWith('\x1bb');

		expect(
			terminal.keyHandler?.(new KeyboardEvent('keydown', { key: 'ArrowRight', metaKey: true }))
		).toBe(false);
		expect(props.onData).toHaveBeenLastCalledWith('\x05');

		expect(terminal.keyHandler?.(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
		expect(terminal.keyHandler?.(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))).toBe(
			false
		);
	});

	it('opens search from Ctrl+F and drives search add-on actions', () => {
		const { terminal, search } = renderTerminal();

		act(() => {
			expect(terminal.keyHandler?.(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))).toBe(
				false
			);
		});

		fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'error' } });
		expect(search.findNext).toHaveBeenCalledWith('error', { incremental: true });

		fireEvent.keyDown(screen.getByPlaceholderText('Search...'), { key: 'Enter' });
		expect(search.findNext).toHaveBeenLastCalledWith('error');

		fireEvent.keyDown(screen.getByPlaceholderText('Search...'), { key: 'Enter', shiftKey: true });
		expect(search.findPrevious).toHaveBeenCalledWith('error');

		fireEvent.keyDown(screen.getByPlaceholderText('Search...'), { key: 'Escape' });
		expect(screen.queryByPlaceholderText('Search...')).not.toBeInTheDocument();
		expect(terminal.focus).toHaveBeenCalled();
	});

	it('detects and opens terminal links and copies selected text on clipboard shortcut', async () => {
		const { terminal } = renderTerminal();
		const linksCallback = vi.fn();

		terminal.linkProvider.provideLinks(1, linksCallback);
		const links = linksCallback.mock.calls[0][0];
		expect(links[0].text).toBe('https://example.com/docs');
		links[0].activate(new MouseEvent('click'), links[0].text);
		expect(window.open).toHaveBeenCalledWith(
			'https://example.com/docs',
			'_blank',
			'noopener,noreferrer'
		);

		terminal.getSelection.mockReturnValue('copy me');
		expect(terminal.keyHandler?.(new KeyboardEvent('keydown', { key: 'c', metaKey: true }))).toBe(
			false
		);
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith('copy me');
	});
});
