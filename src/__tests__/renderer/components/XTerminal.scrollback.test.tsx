import { createRef } from 'react';
import { render, act } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { XTerminal, type XTerminalHandle } from '../../../renderer/components/XTerminal';
import type { Theme } from '../../../shared/theme-types';
import {
	TERMINAL_SCROLLBACK_MAX_SAVE_WAIT_MS,
	TERMINAL_SCROLLBACK_SAVE_DELAY_MS,
} from '../../../shared/terminalScrollback';

const { mockTerminalInstances, mockSerialize } = vi.hoisted(() => ({
	mockTerminalInstances: [] as Array<{ write: ReturnType<typeof vi.fn> }>,
	mockSerialize: vi.fn(),
}));

vi.mock('@xterm/addon-fit', () => ({
	FitAddon: class {
		fit = vi.fn();
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

vi.mock('@xterm/addon-serialize', () => ({
	SerializeAddon: class {
		serialize = mockSerialize;
	},
}));

vi.mock('@xterm/addon-webgl', () => ({
	WebglAddon: class {
		onContextLoss = vi.fn();
		dispose = vi.fn();
	},
}));

vi.mock('@xterm/xterm', () => ({
	Terminal: class {
		rows = 24;
		cols = 80;
		options: Record<string, unknown>;
		unicode = { activeVersion: '' };
		buffer = { active: { length: 0, getLine: vi.fn() } };

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
		getSelection = vi.fn(() => '');
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

const KEY = 'agent-1-terminal-tab-1';

/** Capture the PTY data listener so tests can push output at the terminal. */
let emitPtyData: (sid: string, data: string) => void;

function writtenText(): string[] {
	return mockTerminalInstances[0].write.mock.calls.map((call) => call[0] as string);
}

async function flushPromises() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe('XTerminal scrollback persistence', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockTerminalInstances.length = 0;
		mockSerialize.mockReset();
		mockSerialize.mockReturnValue('SNAPSHOT');
		window.maestro.process.onData = vi.fn((listener) => {
			emitPtyData = listener;
			return () => {};
		});
		window.maestro.process.resize = vi.fn().mockResolvedValue(true);
		window.maestro.terminalScrollback.load = vi.fn().mockResolvedValue(null);
		window.maestro.terminalScrollback.save = vi.fn().mockResolvedValue(true);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('writes restored history before output that arrived while it loaded', async () => {
		let resolveLoad: (value: string | null) => void = () => {};
		window.maestro.terminalScrollback.load = vi.fn(
			() => new Promise<string | null>((resolve) => (resolveLoad = resolve))
		);
		const ref = createRef<XTerminalHandle>();
		render(
			<XTerminal ref={ref} sessionId={KEY} theme={theme} fontFamily="Menlo" persistScrollback />
		);

		ref.current!.write('Starting terminal...');
		act(() => emitPtyData(KEY, 'new prompt $ '));
		expect(writtenText()).toEqual([]);

		resolveLoad('old history');
		await flushPromises();

		const writes = writtenText();
		expect(window.maestro.terminalScrollback.load).toHaveBeenCalledWith(KEY);
		expect(writes[0]).toMatch(/^old history/);
		expect(writes[0]).toContain('restored from previous session');
		expect(writes.slice(1)).toEqual(['Starting terminal...', 'new prompt $ ']);

		// Output held back during the restore still gets saved.
		act(() => vi.advanceTimersByTime(TERMINAL_SCROLLBACK_SAVE_DELAY_MS));
		expect(window.maestro.terminalScrollback.save).toHaveBeenCalledTimes(1);
	});

	it('writes nothing extra when there is no saved snapshot', async () => {
		render(<XTerminal sessionId={KEY} theme={theme} fontFamily="Menlo" persistScrollback />);
		await flushPromises();
		act(() => emitPtyData(KEY, 'hello'));

		expect(writtenText()).toEqual(['hello']);
	});

	it('saves once after output goes quiet, not once per chunk', async () => {
		render(<XTerminal sessionId={KEY} theme={theme} fontFamily="Menlo" persistScrollback />);
		await flushPromises();

		act(() => emitPtyData(KEY, 'a'));
		act(() => vi.advanceTimersByTime(TERMINAL_SCROLLBACK_SAVE_DELAY_MS - 1));
		act(() => emitPtyData(KEY, 'b'));
		act(() => vi.advanceTimersByTime(TERMINAL_SCROLLBACK_SAVE_DELAY_MS - 1));
		expect(window.maestro.terminalScrollback.save).not.toHaveBeenCalled();

		act(() => vi.advanceTimersByTime(1));
		expect(window.maestro.terminalScrollback.save).toHaveBeenCalledTimes(1);
		expect(window.maestro.terminalScrollback.save).toHaveBeenCalledWith(KEY, 'SNAPSHOT');
		expect(mockSerialize).toHaveBeenCalledWith(
			expect.objectContaining({ excludeAltBuffer: true, excludeModes: true })
		);
	});

	it('still saves within the max wait when output never goes quiet', async () => {
		render(<XTerminal sessionId={KEY} theme={theme} fontFamily="Menlo" persistScrollback />);
		await flushPromises();

		const step = TERMINAL_SCROLLBACK_SAVE_DELAY_MS / 2;
		for (let elapsed = 0; elapsed < TERMINAL_SCROLLBACK_MAX_SAVE_WAIT_MS; elapsed += step) {
			act(() => emitPtyData(KEY, 'tick'));
			act(() => vi.advanceTimersByTime(step));
		}

		expect(window.maestro.terminalScrollback.save).toHaveBeenCalledTimes(1);
	});

	it('flushes a pending save on beforeunload', async () => {
		render(<XTerminal sessionId={KEY} theme={theme} fontFamily="Menlo" persistScrollback />);
		await flushPromises();

		act(() => emitPtyData(KEY, 'output'));
		window.dispatchEvent(new Event('beforeunload'));

		expect(window.maestro.terminalScrollback.save).toHaveBeenCalledTimes(1);
	});

	it('neither loads nor saves without persistScrollback', async () => {
		render(<XTerminal sessionId={KEY} theme={theme} fontFamily="Menlo" />);
		await flushPromises();

		act(() => emitPtyData(KEY, 'output'));
		act(() => vi.advanceTimersByTime(TERMINAL_SCROLLBACK_MAX_SAVE_WAIT_MS));

		expect(writtenText()).toEqual(['output']);
		expect(window.maestro.terminalScrollback.load).not.toHaveBeenCalled();
		expect(window.maestro.terminalScrollback.save).not.toHaveBeenCalled();
	});
});
