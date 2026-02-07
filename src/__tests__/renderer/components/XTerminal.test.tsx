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
		loadAddon = vi.fn();
		open = vi.fn();
		dispose = vi.fn();
		write = vi.fn();
		focus = vi.fn();
		clear = vi.fn();
		scrollToBottom = vi.fn();
		getSelection = vi.fn(() => 'selected-text');

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
	});

	afterEach(() => {
		if (container.firstChild) {
			act(() => {
				root.unmount();
			});
		}
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
		expect(searchAddon.findNext).toHaveBeenNthCalledWith(2, '');
		expect(searchAddon.findPrevious).toHaveBeenCalledWith('');
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
});
