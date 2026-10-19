/**
 * Tests for the Tab Windows terminal handoff in main (D5).
 *
 * Tests cover:
 * - A claim with nothing announced answers null at once (an ordinary mount)
 * - A move: announce, release, held output, commit, and the replay a claim gets
 * - A claim that comes before the release waits for the commit (pop-out race)
 * - Output while a move is only announced is not held (the old view writes it)
 * - A release with no begin (a closing window) holds output from the commit
 * - Expiry: an announced move nobody releases, a scrollback nobody claims
 * - A new move drops what an older one held; the size cap
 * - The IPC listeners: replies on the asking window's own channel, bad ids
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: { on: vi.fn() },
}));

vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	createTerminalHandoff,
	expectTerminalHandoff,
	registerTerminalHandoffHandlers,
	terminalHandoff,
	type TerminalHandoff,
} from '../../main/terminal-handoff';
import { TERMINAL_HANDOFF_MAX_CHARS } from '../../shared/terminalReplay';

const PTY = 'agent-1-terminal-term-1';

describe('createTerminalHandoff', () => {
	let handoff: TerminalHandoff;

	beforeEach(() => {
		vi.useFakeTimers();
		handoff = createTerminalHandoff({ waitMs: 1000, unclaimedTtlMs: 5000 });
	});

	afterEach(() => {
		handoff.clear();
		vi.useRealTimers();
	});

	it('answers a claim with null at once when no move was announced', () => {
		const reply = vi.fn();
		handoff.claim(PTY, reply);
		expect(reply).toHaveBeenCalledWith(null);
	});

	it('replays the committed scrollback and the output held after the release', () => {
		handoff.expect(PTY);
		handoff.noteData(PTY, 'still drawn by the old view');
		handoff.begin(PTY);
		handoff.noteData(PTY, 'after the cut 1\r\n');
		handoff.commit(PTY, 'old scrollback\r\n');
		handoff.noteData(PTY, 'after the cut 2');

		const reply = vi.fn();
		handoff.claim(PTY, reply);

		expect(reply).toHaveBeenCalledWith('old scrollback\r\nafter the cut 1\r\nafter the cut 2');
		// Claimed: the next view of this PTY starts live.
		expect(handoff.has(PTY)).toBe(false);
	});

	it('makes a claim that beats the release wait for the commit', () => {
		handoff.expect(PTY);
		const reply = vi.fn();
		handoff.claim(PTY, reply);
		expect(reply).not.toHaveBeenCalled();

		handoff.begin(PTY);
		handoff.noteData(PTY, 'live');
		expect(reply).not.toHaveBeenCalled();

		handoff.commit(PTY, 'scrollback ');
		expect(reply).toHaveBeenCalledWith('scrollback live');
		expect(handoff.has(PTY)).toBe(false);
	});

	it('holds output from the commit when a release had no begin (a closing window)', () => {
		handoff.expect(PTY);
		handoff.commit(PTY, 'closing window scrollback');
		handoff.noteData(PTY, ' + later');

		const reply = vi.fn();
		handoff.claim(PTY, reply);
		expect(reply).toHaveBeenCalledWith('closing window scrollback + later');
	});

	it('answers null when an announced move is never released', () => {
		handoff.expect(PTY);
		const reply = vi.fn();
		handoff.claim(PTY, reply);

		vi.advanceTimersByTime(1000);

		expect(reply).toHaveBeenCalledWith(null);
		expect(handoff.has(PTY)).toBe(false);
	});

	it('answers null when the releaser never commits', () => {
		handoff.expect(PTY);
		handoff.begin(PTY);
		const reply = vi.fn();
		handoff.claim(PTY, reply);

		vi.advanceTimersByTime(1000);

		expect(reply).toHaveBeenCalledWith(null);
	});

	it('drops a scrollback nobody claims', () => {
		handoff.begin(PTY);
		handoff.commit(PTY, 'unclaimed');
		vi.advanceTimersByTime(4999);
		expect(handoff.has(PTY)).toBe(true);

		vi.advanceTimersByTime(1);

		expect(handoff.has(PTY)).toBe(false);
	});

	it('drops what an older move held once a new move is announced', () => {
		handoff.begin(PTY);
		handoff.commit(PTY, 'stale');
		handoff.noteData(PTY, 'stale output');

		handoff.expect(PTY);
		const reply = vi.fn();
		handoff.claim(PTY, reply);
		handoff.begin(PTY);
		handoff.commit(PTY, 'fresh');

		expect(reply).toHaveBeenCalledWith('fresh');
	});

	it('ignores output of other PTYs', () => {
		handoff.begin(PTY);
		handoff.noteData('agent-1-terminal-other', 'not mine');
		handoff.commit(PTY, 'mine');

		const reply = vi.fn();
		handoff.claim(PTY, reply);
		expect(reply).toHaveBeenCalledWith('mine');
	});

	it('keeps the newest output when the held output passes the cap', () => {
		handoff.begin(PTY);
		handoff.noteData(PTY, 'x'.repeat(TERMINAL_HANDOFF_MAX_CHARS));
		handoff.noteData(PTY, 'END');
		handoff.commit(PTY, '');

		const reply = vi.fn();
		handoff.claim(PTY, reply);
		const replay = reply.mock.calls[0][0] as string;
		expect(replay.length).toBe(TERMINAL_HANDOFF_MAX_CHARS);
		expect(replay.endsWith('END')).toBe(true);
	});
});

describe('expectTerminalHandoff', () => {
	afterEach(() => terminalHandoff.clear());

	it('announces a move for a terminal tab only', () => {
		expectTerminalHandoff('agent-1', { type: 'ai', id: 'tab-1' });
		expect(terminalHandoff.has('agent-1-terminal-tab-1')).toBe(false);

		expectTerminalHandoff('agent-1', { type: 'terminal', id: 'term-1' });
		expect(terminalHandoff.has(PTY)).toBe(true);
	});
});

describe('registerTerminalHandoffHandlers', () => {
	let listeners: Map<string, (...args: unknown[]) => void>;
	let handoff: TerminalHandoff;

	function makeSender() {
		return { send: vi.fn(), isDestroyed: vi.fn(() => false) };
	}

	beforeEach(() => {
		listeners = new Map();
		vi.mocked(ipcMain.on).mockImplementation(((
			channel: string,
			listener: (...args: unknown[]) => void
		) => {
			listeners.set(channel, listener);
			return ipcMain;
		}) as never);
		handoff = createTerminalHandoff();
		registerTerminalHandoffHandlers(handoff);
	});

	afterEach(() => handoff.clear());

	it('answers a release on the releasing window channel, then holds output', () => {
		const sender = makeSender();
		listeners.get('tabWindow:terminalRelease')!({ sender }, PTY);

		expect(sender.send).toHaveBeenCalledWith('tabWindow:terminalReleaseBegun', PTY);
		handoff.noteData(PTY, 'held');
		listeners.get('tabWindow:terminalCommit')!({ sender }, PTY, 'scrollback ');

		const claimer = makeSender();
		listeners.get('tabWindow:terminalClaim')!({ sender: claimer }, PTY);
		expect(claimer.send).toHaveBeenCalledWith('tabWindow:terminalReplay', PTY, 'scrollback held');
	});

	it('answers a claim with null when nothing is held', () => {
		const claimer = makeSender();
		listeners.get('tabWindow:terminalClaim')!({ sender: claimer }, PTY);
		expect(claimer.send).toHaveBeenCalledWith('tabWindow:terminalReplay', PTY, null);
	});

	it('does not answer a window that went away', () => {
		const claimer = makeSender();
		claimer.isDestroyed.mockReturnValue(true);
		listeners.get('tabWindow:terminalClaim')!({ sender: claimer }, PTY);
		expect(claimer.send).not.toHaveBeenCalled();
	});

	it('ignores an id that is not a terminal PTY', () => {
		const sender = makeSender();
		listeners.get('tabWindow:terminalRelease')!({ sender }, 'agent-1-ai-tab-1');
		listeners.get('tabWindow:terminalClaim')!({ sender }, 42);
		listeners.get('tabWindow:terminalCommit')!({ sender }, 'agent-1-ai-tab-1', 'text');

		expect(sender.send).not.toHaveBeenCalled();
		expect(handoff.has('agent-1-ai-tab-1')).toBe(false);
	});
});
