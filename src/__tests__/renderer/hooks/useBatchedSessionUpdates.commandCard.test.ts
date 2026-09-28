/**
 * Regression tests for the one rule that keeps command-mode cards intact:
 * streamed agent output must never be coalesced INTO a `!` command's card.
 *
 * The card is `source: 'stdout'` (its body is terminal output), which is also
 * what streamed agent text coalesces into. Command mode deliberately runs
 * commands while the agent is mid-turn, so a card appended during a stream is
 * the `lastLog` when the agent's next chunk arrives - and without the guard,
 * that chunk gets appended to the card's text and the agent's reply renders
 * inside the terminal output box.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBatchedSessionUpdates } from '../../../renderer/hooks/session/useBatchedSessionUpdates';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { LogEntry } from '../../../renderer/types';

const SESSION_ID = 'session-1';
const TAB_ID = 'tab-1';

/** The transcript card appended by services/shellCommand.ts for a `!` command. */
function commandCard(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		id: 'card-1',
		timestamp: Date.now(),
		source: 'stdout',
		text: 'file-a\nfile-b\n',
		shellCommand: {
			command: 'ls',
			cwd: '/repo',
			status: 'finished',
			exitCode: 0,
		},
		...overrides,
	};
}

function seed(logs: LogEntry[]): void {
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: SESSION_ID,
				activeTabId: TAB_ID,
				aiTabs: [createMockAITab({ id: TAB_ID, logs })],
			}),
		],
		activeSessionId: SESSION_ID,
	});
}

function tabLogs(): LogEntry[] {
	const session = useSessionStore.getState().sessions.find((s) => s.id === SESSION_ID);
	return session?.aiTabs.find((t) => t.id === TAB_ID)?.logs ?? [];
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('useBatchedSessionUpdates - command-mode card is not a coalesce target', () => {
	it('does not append streamed agent output into a command card', () => {
		const card = commandCard();
		seed([card]);

		const { result } = renderHook(() => useBatchedSessionUpdates());

		act(() => {
			// Agent chunk arriving immediately after the card - inside the 500ms
			// grouping window, which is exactly the real-world case (running `!ls`
			// while the agent is streaming).
			result.current.appendLog(SESSION_ID, TAB_ID, true, 'Shipped to main.');
			result.current.flushNow();
		});

		const logs = tabLogs();
		const cardAfter = logs.find((l) => l.id === 'card-1')!;

		// The card keeps ONLY its own terminal output.
		expect(cardAfter.text).toBe('file-a\nfile-b\n');
		expect(cardAfter.text).not.toContain('Shipped to main.');

		// The agent's text lands in its own entry instead.
		expect(logs).toHaveLength(2);
		expect(logs[1].text).toBe('Shipped to main.');
		expect(logs[1].shellCommand).toBeUndefined();
	});

	it('keeps the card intact across several streamed chunks', () => {
		seed([commandCard()]);

		const { result } = renderHook(() => useBatchedSessionUpdates());

		act(() => {
			result.current.appendLog(SESSION_ID, TAB_ID, true, 'chunk one ');
			result.current.appendLog(SESSION_ID, TAB_ID, true, 'chunk two');
			result.current.flushNow();
		});

		const logs = tabLogs();
		expect(logs.find((l) => l.id === 'card-1')!.text).toBe('file-a\nfile-b\n');
		// The chunks still coalesce with EACH OTHER, just not into the card.
		expect(logs).toHaveLength(2);
		expect(logs[1].text).toBe('chunk one chunk two');
	});

	it('does not append streamed stderr into a command card either', () => {
		seed([commandCard()]);

		const { result } = renderHook(() => useBatchedSessionUpdates());

		act(() => {
			result.current.appendLog(SESSION_ID, TAB_ID, true, 'a warning', true);
			result.current.flushNow();
		});

		const logs = tabLogs();
		expect(logs.find((l) => l.id === 'card-1')!.text).toBe('file-a\nfile-b\n');
		expect(logs).toHaveLength(2);
		expect(logs[1].source).toBe('stderr');
	});

	it('does not append into a still-running command card', () => {
		// The window where this matters most: the command is in flight, so its
		// card is the newest entry while the agent keeps streaming.
		seed([
			commandCard({
				text: '',
				shellCommand: { command: 'tail -f log', cwd: '/repo', status: 'running' },
			}),
		]);

		const { result } = renderHook(() => useBatchedSessionUpdates());

		act(() => {
			result.current.appendLog(SESSION_ID, TAB_ID, true, 'agent still talking');
			result.current.flushNow();
		});

		const logs = tabLogs();
		expect(logs.find((l) => l.id === 'card-1')!.text).toBe('');
		expect(logs).toHaveLength(2);
	});

	it('still coalesces normal agent output into a plain stdout entry', () => {
		// Guard against over-correcting: ordinary streaming must keep grouping,
		// or every chunk becomes its own bubble.
		seed([{ id: 'plain-1', timestamp: Date.now(), source: 'stdout', text: 'hello ' }]);

		const { result } = renderHook(() => useBatchedSessionUpdates());

		act(() => {
			result.current.appendLog(SESSION_ID, TAB_ID, true, 'world');
			result.current.flushNow();
		});

		const logs = tabLogs();
		expect(logs).toHaveLength(1);
		expect(logs[0].text).toBe('hello world');
	});
});
