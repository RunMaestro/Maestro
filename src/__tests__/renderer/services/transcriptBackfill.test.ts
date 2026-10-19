/**
 * Tests for services/transcriptBackfill: the history page a tab window's owner
 * loads for a popped tab (Tab Windows, the `loadEarlierTranscript` intent).
 *
 * The page logic itself is the hook's (covered in useTranscriptBackfill.test);
 * what the owner adds is the per-tab paging state the hook keeps for a tab on
 * screen: one load at a time, a window that keeps growing, and no more reads
 * once the tab starts at the first message.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	loadEarlierTranscriptForTab,
	resetTranscriptBackfillForTests,
	TRANSCRIPT_BACKFILL_PAGE,
} from '../../../renderer/services/transcriptBackfill';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { TRANSCRIPT_RESUME_READ_LIMIT } from '../../../renderer/utils/transcriptMessages';
import type { LogEntry, Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

const read = vi.fn();

function message(n: number) {
	return {
		type: n % 2 === 0 ? 'user' : 'assistant',
		content: `message ${n}`,
		timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(),
		uuid: `uuid-${n}`,
	};
}

function page(total: number, count: number) {
	const start = Math.max(0, total - count);
	return {
		messages: Array.from({ length: total - start }, (_, i) => message(start + i)),
		total,
		hasMore: start > 0,
	};
}

function visible(...ns: number[]): LogEntry[] {
	return ns.map((n) => ({
		id: `uuid-${n}`,
		timestamp: 1_700_000_000_000 + n * 1000,
		source: n % 2 === 0 ? 'user' : 'stdout',
		text: `message ${n}`,
	}));
}

function seed(logs: LogEntry[]): void {
	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: 'agent-1',
				projectRoot: '/repo',
				aiTabs: [
					createMockAITab({ id: 'home' }),
					createMockAITab({ id: 'popped', agentSessionId: 'claude-1', logs }),
				],
				activeTabId: 'home',
			}),
		],
		activeSessionId: 'agent-1',
	} as Partial<ReturnType<typeof useSessionStore.getState>> as never);
}

function poppedLogs(): string[] {
	const session = useSessionStore.getState().sessions[0] as Session;
	return session.aiTabs.find((t) => t.id === 'popped')!.logs.map((l) => l.text);
}

beforeEach(() => {
	vi.clearAllMocks();
	resetTranscriptBackfillForTests();
	(window as any).maestro = { ...((window as any).maestro || {}), agentSessions: { read } };
});

describe('loadEarlierTranscriptForTab', () => {
	it('prepends the older history of the named tab, not of the active one', async () => {
		seed(visible(8, 9));
		read.mockResolvedValue(page(10, 10));

		await loadEarlierTranscriptForTab('agent-1', 'popped');

		expect(read).toHaveBeenCalledWith(
			'claude-code',
			'/repo',
			'claude-1',
			{ offset: 0, limit: TRANSCRIPT_RESUME_READ_LIMIT + TRANSCRIPT_BACKFILL_PAGE },
			undefined
		);
		expect(poppedLogs()).toEqual(Array.from({ length: 10 }, (_, i) => `message ${i}`));
	});

	it('widens the window on the next load, and stops once the tab starts at the first message', async () => {
		seed(visible(4998, 4999));
		read.mockImplementation((_t, _p, _s, { limit }: { limit: number }) =>
			Promise.resolve(page(5000, limit))
		);

		await loadEarlierTranscriptForTab('agent-1', 'popped');
		const first = read.mock.calls[0][3].limit;
		await loadEarlierTranscriptForTab('agent-1', 'popped');
		expect(read.mock.calls.at(-1)![3].limit).toBe(first + TRANSCRIPT_BACKFILL_PAGE);

		// This read spans the whole file (hasMore false): the tab starts at the first message.
		read.mockResolvedValueOnce(page(5000, 5000));
		read.mockClear();
		await loadEarlierTranscriptForTab('agent-1', 'popped');
		expect(read).toHaveBeenCalledTimes(1);
		await loadEarlierTranscriptForTab('agent-1', 'popped');
		expect(read).toHaveBeenCalledTimes(1);
	});

	it('runs one load per tab at a time', async () => {
		seed(visible(8, 9));
		let resolve: (value: unknown) => void = () => {};
		read.mockReturnValue(new Promise((r) => (resolve = r)));

		const first = loadEarlierTranscriptForTab('agent-1', 'popped');
		await loadEarlierTranscriptForTab('agent-1', 'popped');
		expect(read).toHaveBeenCalledTimes(1);

		resolve(page(10, 10));
		await first;
	});

	it('does nothing for a tab with no provider session yet, and survives a failed read', async () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'agent-1', aiTabs: [createMockAITab({ id: 'popped' })] })],
		} as never);
		await loadEarlierTranscriptForTab('agent-1', 'popped');
		expect(read).not.toHaveBeenCalled();

		seed(visible(8, 9));
		read.mockRejectedValue(new Error('file gone'));
		await expect(loadEarlierTranscriptForTab('agent-1', 'popped')).resolves.toBeUndefined();
	});
});
