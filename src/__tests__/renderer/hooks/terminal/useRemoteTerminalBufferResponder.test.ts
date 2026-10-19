/**
 * Tests for the tail-truncation helper behind `maestro-cli read-terminal`, and
 * for the read refusing a terminal popped out into a tab window.
 *
 * The truncation runs in the renderer, before the buffer crosses IPC, so these
 * cover the boundary that decides how much of a `tail -f` tab reaches an agent's
 * context.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
	tailLines,
	MAX_TERMINAL_READ_LINES,
	useRemoteTerminalBufferResponder,
} from '../../../../renderer/hooks/terminal/useRemoteTerminalBufferResponder';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { TerminalViewHandle } from '../../../../renderer/components/TerminalView';
import type { Session } from '../../../../renderer/types';
import { clearTabWindowStore, popOutTabsInStore } from '../../../helpers/tabWindows';

const buffer = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('tailLines', () => {
	it('returns the buffer untouched when it is shorter than the tail', () => {
		const out = tailLines(buffer(10), 50);
		expect(out.content).toBe(buffer(10));
		expect(out.totalLines).toBe(10);
	});

	it('keeps the LAST n lines, not the first', () => {
		const out = tailLines(buffer(100), 3);
		// A head-truncating implementation would return "line 1..line 3" here and
		// hand back the start of a log when the caller asked for its end.
		expect(out.content).toBe('line 98\nline 99\nline 100');
	});

	it('reports the pre-truncation total so a partial read is detectable', () => {
		const out = tailLines(buffer(4000), 200);
		expect(out.content.split('\n')).toHaveLength(200);
		expect(out.totalLines).toBe(4000);
	});

	it('is exact at the boundary', () => {
		const out = tailLines(buffer(200), 200);
		expect(out.content).toBe(buffer(200));
		expect(out.totalLines).toBe(200);
	});

	it('caps an unbounded request at MAX_TERMINAL_READ_LINES', () => {
		// The cap is the whole point: without it a huge scrollback would be shipped
		// across IPC and blow the calling agent's context.
		const out = tailLines(buffer(MAX_TERMINAL_READ_LINES + 500));
		expect(out.content.split('\n')).toHaveLength(MAX_TERMINAL_READ_LINES);
		expect(out.totalLines).toBe(MAX_TERMINAL_READ_LINES + 500);
	});

	it('caps a caller asking for more than the maximum', () => {
		const out = tailLines(buffer(MAX_TERMINAL_READ_LINES + 500), 999_999);
		expect(out.content.split('\n')).toHaveLength(MAX_TERMINAL_READ_LINES);
	});

	it('handles an empty buffer', () => {
		const out = tailLines('', 100);
		expect(out.content).toBe('');
		expect(out.totalLines).toBe(1);
	});
});

describe('useRemoteTerminalBufferResponder - popped-out terminal (Tab Windows, D5)', () => {
	type ReadHandler = (
		sessionId: string,
		payload: { tabRef?: string; tail?: number },
		responseChannel: string
	) => void;
	let handler: ReadHandler | null;
	const respond = vi.fn();

	beforeEach(() => {
		handler = null;
		respond.mockReset();
		const process = (window as unknown as { maestro: { process: Record<string, unknown> } }).maestro
			.process;
		process.onRemoteReadTerminalTab = vi.fn((callback: ReadHandler) => {
			handler = callback;
			return () => {};
		});
		process.sendRemoteReadTerminalTabResponse = respond;
		useSessionStore.getState().setSessions([
			{
				id: 'agent-1',
				cwd: '/tmp',
				terminalTabs: [{ id: 'term-1', name: null, state: 'idle', cwd: '/tmp' }],
				activeTerminalTabId: 'term-1',
			} as unknown as Session,
		]);
	});

	afterEach(() => {
		clearTabWindowStore();
		useSessionStore.getState().setSessions([]);
	});

	function mountWith(buffer: string) {
		const view = { getTerminalBuffer: vi.fn(() => buffer) } as unknown as TerminalViewHandle;
		renderHook(() => useRemoteTerminalBufferResponder({ current: new Map([['agent-1', view]]) }));
		return view;
	}

	it('refuses to read a tab whose only xterm is in its tab window', () => {
		popOutTabsInStore('agent-1', [{ type: 'terminal', id: 'term-1' }]);
		const view = mountWith('');

		handler!('agent-1', {}, 'reply-1');

		expect(view.getTerminalBuffer).not.toHaveBeenCalled();
		expect(respond).toHaveBeenCalledWith(
			'reply-1',
			false,
			expect.objectContaining({ error: expect.stringContaining('popped out into its tab window') })
		);
	});

	it('reads a docked tab as before', () => {
		mountWith('$ ls');

		handler!('agent-1', {}, 'reply-2');

		expect(respond).toHaveBeenCalledWith(
			'reply-2',
			true,
			expect.objectContaining({ content: '$ ls' })
		);
	});
});
