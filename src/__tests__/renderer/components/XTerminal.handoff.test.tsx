/**
 * XTerminal and the Tab Windows terminal handoff (D5).
 *
 * Tests cover:
 * - Routing: output of the view's own PTY only; held back until main answers
 *   the replay claim, then dropped (it is inside the replay) or written (no replay)
 * - The replay call: written before any later live output
 * - Release on unmount: the buffer, the writes xterm has not parsed yet, and
 *   the output that arrives before main's answer, committed in that order
 * - Release on unload, and no handoff at all without the prop
 */

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XTerminal, type XTerminalHandoff } from '../../../renderer/components/XTerminal';
import {
	releaseRegisteredTerminalViews,
	resetTerminalHandoffForTests,
} from '../../../renderer/services/terminalHandoff';
import type { Theme } from '../../../shared/theme-types';
import { installTerminalHandoffApi, type TerminalHandoffApiDouble } from '../../helpers/tabWindows';

interface MockTerminal {
	written: string[];
	lines: string[];
	/** Whether a write is parsed at once (its callback runs), as xterm does on its timer. */
	parseWrites: boolean;
}

const { terminals } = vi.hoisted(() => ({ terminals: [] as MockTerminal[] }));

vi.mock('@xterm/addon-fit', () => ({
	FitAddon: class {
		fit = vi.fn();
	},
}));
vi.mock('@xterm/addon-search', () => ({
	SearchAddon: class {
		findNext = vi.fn();
		findPrevious = vi.fn();
	},
}));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({
	WebglAddon: class {
		onContextLoss = vi.fn(() => ({ dispose: vi.fn() }));
		dispose = vi.fn();
	},
}));
vi.mock('@xterm/xterm', () => ({
	Terminal: class {
		written: string[] = [];
		lines: string[] = [];
		parseWrites = true;
		rows = 24;
		cols = 80;
		options: Record<string, unknown>;
		unicode = { activeVersion: '' };
		parser = { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) };
		buffer = {
			active: {
				get length() {
					return 0;
				},
				getLine: (i: number) => ({ translateToString: () => this.lines[i] ?? '' }),
			},
		};
		constructor(options: Record<string, unknown>) {
			this.options = options;
			const self = this;
			Object.defineProperty(this.buffer.active, 'length', { get: () => self.lines.length });
			terminals.push(this);
		}
		write = vi.fn((data: string, callback?: () => void) => {
			this.written.push(data);
			if (this.parseWrites) callback?.();
		});
		loadAddon = vi.fn();
		registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
		attachCustomKeyEventHandler = vi.fn();
		open = vi.fn();
		focus = vi.fn();
		clear = vi.fn();
		refresh = vi.fn();
		dispose = vi.fn();
		onTitleChange = vi.fn(() => ({ dispose: vi.fn() }));
		onData = vi.fn(() => ({ dispose: vi.fn() }));
		onSelectionChange = vi.fn(() => ({ dispose: vi.fn() }));
		getSelection = vi.fn(() => '');
	},
}));

const theme = {
	id: 'dark',
	name: 'Dark',
	mode: 'dark',
	colors: { bgMain: '#111', textMain: '#eee', accent: '#0af', accentDim: '#046', border: '#222' },
} as unknown as Theme;

const PTY = 'agent-1-terminal-term-1';

describe('XTerminal terminal handoff', () => {
	let api: TerminalHandoffApiDouble;
	let dataListeners: Set<(sessionId: string, data: string) => void>;
	const emitData = (sessionId: string, data: string) => {
		for (const listener of [...dataListeners]) listener(sessionId, data);
	};

	beforeEach(() => {
		terminals.length = 0;
		resetTerminalHandoffForTests();
		api = installTerminalHandoffApi();
		dataListeners = new Set();
		window.maestro.process.onData = vi.fn((listener) => {
			dataListeners.add(listener);
			return () => dataListeners.delete(listener);
		}) as never;
		window.maestro.process.resize = vi.fn().mockResolvedValue(true) as never;
	});

	afterEach(() => {
		cleanup();
		api.restore();
	});

	const mount = (handoff?: XTerminalHandoff) =>
		render(<XTerminal sessionId={PTY} theme={theme} fontFamily="monospace" handoff={handoff} />);

	const stay: XTerminalHandoff = { releaseOnUnmount: () => false };

	it('claims a replay on mount and holds live output until the answer', () => {
		mount(stay);
		expect(api.claimTerminalReplay).toHaveBeenCalledWith(PTY);

		act(() => emitData(PTY, 'before the answer'));
		expect(terminals[0].written).toEqual([]);
	});

	it('writes the replay and drops the output that came before it (it is inside the replay)', () => {
		mount(stay);
		act(() => {
			emitData(PTY, 'chunk-1');
			api.emitReplay(PTY, 'scrollback\r\n$ chunk-1');
			emitData(PTY, 'chunk-2');
		});

		expect(terminals[0].written).toEqual(['scrollback\r\n$ chunk-1', 'chunk-2']);
	});

	it('writes the held output in order when there is nothing to replay', () => {
		mount(stay);
		act(() => {
			emitData(PTY, 'a');
			emitData(PTY, 'b');
			api.emitReplay(PTY, null);
			emitData(PTY, 'c');
		});

		expect(terminals[0].written).toEqual(['a', 'b', 'c']);
	});

	it('routes by process id: another PTY output and another PTY answer never land here', () => {
		mount(stay);
		act(() => {
			emitData('agent-1-terminal-other', 'not mine');
			api.emitReplay('agent-1-terminal-other', 'not my replay');
			api.emitReplay(PTY, null);
			emitData('agent-2-terminal-term-1', 'nor this');
			emitData(PTY, 'mine');
		});

		expect(terminals[0].written).toEqual(['mine']);
	});

	it('writes live output at once and never claims without a handoff', () => {
		mount();
		act(() => emitData(PTY, 'live'));

		expect(api.claimTerminalReplay).not.toHaveBeenCalled();
		expect(terminals[0].written).toEqual(['live']);
	});

	it('hands the scrollback over on unmount when the tab moves to another window', () => {
		const view = mount({ releaseOnUnmount: () => true });
		act(() => api.emitReplay(PTY, null));
		const term = terminals[0];
		term.lines = ['$ ls', 'file', '$'];
		// xterm has not parsed this one yet: it is not in the buffer.
		term.parseWrites = false;
		act(() => emitData(PTY, ' unparsed'));

		view.unmount();
		expect(api.beginTerminalRelease).toHaveBeenCalledWith(PTY);
		expect(api.commitTerminalRelease).not.toHaveBeenCalled();

		// Sent by main before it started holding: this window keeps it.
		act(() => emitData(PTY, ' before-begun'));
		act(() => api.emitReleaseBegun(PTY));
		// Main holds this one itself.
		act(() => emitData(PTY, ' after-begun'));

		expect(api.commitTerminalRelease).toHaveBeenCalledTimes(1);
		expect(api.commitTerminalRelease).toHaveBeenCalledWith(
			PTY,
			'$ ls\r\nfile\r\n$ unparsed before-begun'
		);
	});

	it('keeps the scrollback when the view unmounts for any other reason', () => {
		const view = mount(stay);
		view.unmount();
		expect(api.beginTerminalRelease).not.toHaveBeenCalled();
	});

	it('hands the scrollback over when the window unloads', () => {
		mount({ releaseOnUnmount: () => false, releaseOnUnload: true });
		act(() => api.emitReplay(PTY, null));
		terminals[0].lines = ['$ top'];

		releaseRegisteredTerminalViews();

		expect(api.commitTerminalRelease).toHaveBeenCalledWith(PTY, '$ top');
	});

	it('shares one claim between two mounts of the same PTY (React StrictMode)', () => {
		const first = mount(stay);
		first.unmount();
		mount(stay);
		expect(api.claimTerminalReplay).toHaveBeenCalledTimes(1);

		act(() => api.emitReplay(PTY, 'replayed'));

		expect(terminals[1].written).toEqual(['replayed']);
	});
});
