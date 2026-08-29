/**
 * XTerminal re-measures its cell after the web fonts arrive.
 *
 * The terminal fonts come from Google Fonts with `display=swap`, so the browser
 * paints with a fallback and swaps the real face in later. xterm measures its
 * cell size exactly once, in `term.open()`. If the swap lands after that, glyphs
 * are drawn at their own advance inside a cell sized for a different font, which
 * renders as `C l a u d e   C o d e` - correct letters, stretched spacing. It
 * showed up in the re-authentication modal because nothing there ever re-fits.
 */

import React from 'react';
import { render, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { XTerminal } from '../../../renderer/components/XTerminal';
import type { Theme } from '../../../shared/theme-types';

const { mockTerminalInstances, mockFit, mockClearTextureAtlas } = vi.hoisted(() => ({
	mockTerminalInstances: [] as Array<{
		options: Record<string, unknown>;
		fontSizeWrites: number[];
	}>,
	mockFit: vi.fn(),
	mockClearTextureAtlas: vi.fn(),
}));

vi.mock('@xterm/addon-fit', () => ({
	FitAddon: class {
		fit = mockFit;
	},
}));

vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));

vi.mock('@xterm/addon-webgl', () => ({
	WebglAddon: class {
		onContextLoss = vi.fn(() => ({ dispose: vi.fn() }));
		clearTextureAtlas = mockClearTextureAtlas;
		dispose = vi.fn();
	},
}));

vi.mock('@xterm/xterm', () => ({
	Terminal: class {
		rows = 24;
		cols = 80;
		unicode = { activeVersion: '' };
		buffer = { active: { length: 0, getLine: vi.fn() } };
		/** Every fontSize assignment, in order - the re-measure is a bump-and-restore. */
		fontSizeWrites: number[] = [];
		private _options: Record<string, unknown>;
		options: Record<string, unknown>;

		constructor(options: Record<string, unknown>) {
			this._options = { ...options };
			const writes = this.fontSizeWrites;
			const target = this._options;
			this.options = new Proxy(target, {
				set(obj, key, value) {
					if (key === 'fontSize') writes.push(value as number);
					obj[key as string] = value;
					return true;
				},
			});
			mockTerminalInstances.push(this as never);
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
		getSelection = vi.fn(() => '');
		onTitleChange = vi.fn(() => ({ dispose: vi.fn() }));
		onData = vi.fn(() => ({ dispose: vi.fn() }));
		onSelectionChange = vi.fn(() => ({ dispose: vi.fn() }));
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

let fontsReady: () => void;
const loadFace = vi.fn();

beforeEach(() => {
	mockTerminalInstances.length = 0;
	mockFit.mockReset();
	mockClearTextureAtlas.mockReset();
	loadFace.mockReset();
	loadFace.mockResolvedValue([]);

	Object.defineProperty(document, 'fonts', {
		configurable: true,
		value: {
			ready: new Promise<void>((resolve) => {
				fontsReady = resolve;
			}),
			load: loadFace,
		},
	});

	window.maestro.process.onData = vi.fn(() => () => {});
	window.maestro.process.resize = vi.fn().mockResolvedValue(undefined);
	window.maestro.process.write = vi.fn().mockResolvedValue(true);
});

/** Give the terminal container a real size, as a laid-out modal would. */
function withSize() {
	Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
		configurable: true,
		value: 800,
	});
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		value: 600,
	});
}

async function settleFonts() {
	await act(async () => {
		fontsReady();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe('XTerminal font metrics', () => {
	it('re-measures the cell once the fonts have settled', async () => {
		withSize();
		render(
			<XTerminal
				sessionId="s-1"
				theme={theme}
				fontFamily="JetBrains Mono, monospace"
				fontSize={12}
			/>
		);
		const term = mockTerminalInstances[0];

		// Only the mount-time sync so far; the swap has not happened.
		const beforeSwap = term.fontSizeWrites.length;

		await settleFonts();

		// Bumped and restored - a real change, because re-assigning the same value
		// is something xterm is free to treat as a no-op.
		expect(term.fontSizeWrites.slice(beforeSwap)).toEqual([13, 12]);
		expect(term.options.fontSize).toBe(12);
	});

	it('requests the terminal own face rather than trusting fonts.ready alone', async () => {
		withSize();
		render(
			<XTerminal
				sessionId="s-1"
				theme={theme}
				fontFamily="JetBrains Mono, monospace"
				fontSize={12}
			/>
		);
		await settleFonts();

		// `fonts.ready` only awaits loads already in flight, so a face nothing has
		// painted yet would still be unrequested when it resolves.
		expect(loadFace).toHaveBeenCalledWith('12px JetBrains Mono');
		// Bold has its own face and the login TUI leans on it heavily.
		expect(loadFace).toHaveBeenCalledWith('bold 12px JetBrains Mono');
	});

	// The WebGL renderer is loaded lazily and never resolves under jsdom, so the
	// atlas drop is a no-op here. What matters is that the re-measure does not
	// depend on it: a renderer that loads later builds its atlas from the fresh
	// metrics anyway.
	it('re-measures even when the WebGL renderer is not loaded', async () => {
		withSize();
		render(<XTerminal sessionId="s-1" theme={theme} fontFamily="JetBrains Mono" fontSize={12} />);
		const term = mockTerminalInstances[0];
		const beforeSwap = term.fontSizeWrites.length;

		await settleFonts();

		expect(mockClearTextureAtlas).not.toHaveBeenCalled();
		expect(term.fontSizeWrites.slice(beforeSwap)).toEqual([13, 12]);
	});

	it('refits so the new cell size becomes new columns', async () => {
		withSize();
		render(<XTerminal sessionId="s-1" theme={theme} fontFamily="JetBrains Mono" fontSize={12} />);
		mockFit.mockClear();

		await settleFonts();

		expect(mockFit).toHaveBeenCalled();
	});

	// A hidden container measures 0x0, and fitting there collapses the terminal
	// to xterm's 2x2 minimum - the guard the mount path already applies.
	it('does not refit while the container is not laid out', async () => {
		Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 0 });
		Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 0 });
		render(<XTerminal sessionId="s-1" theme={theme} fontFamily="JetBrains Mono" fontSize={12} />);
		mockFit.mockClear();

		await settleFonts();

		expect(mockFit).not.toHaveBeenCalled();
		// The re-measure itself still happens; only the refit is deferred.
		expect(mockTerminalInstances[0].fontSizeWrites.slice(-2)).toEqual([13, 12]);
	});

	it('survives a font the platform cannot resolve', async () => {
		withSize();
		loadFace.mockRejectedValue(new Error('no such font'));
		render(<XTerminal sessionId="s-1" theme={theme} fontFamily="Nonexistent Font" fontSize={12} />);

		await settleFonts();

		// Still re-measures against whatever the browser actually used.
		expect(mockTerminalInstances[0].fontSizeWrites.slice(-2)).toEqual([13, 12]);
	});
});
