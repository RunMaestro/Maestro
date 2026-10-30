/**
 * Tests for src/renderer/services/closedTabCommands.ts, the renderer end of
 * `maestro-cli tab closed` / `tab reopen`.
 *
 * What it owes the CLI: list the live stack in the order Cmd+Shift+T pops it;
 * reopen the entry the caller named (head, `--index`, `--tab` id or prefix)
 * through the shortcut's own function; leave the view alone on `--background`;
 * answer only after the tab's content was read (or the budget ran out) and a
 * tracked flush wrote the change; and answer, never throw, for a bad target.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const loadReopenedTabContent = vi.fn();
vi.mock('../../../renderer/services/reopenedTabContent', () => ({
	loadReopenedTabContent: (...args: unknown[]) => loadReopenedTabContent(...args),
}));

const flushSessionPersistenceNow = vi.fn();
vi.mock('../../../renderer/services/sessionPersistenceFlush', () => ({
	flushSessionPersistenceNow: (...args: unknown[]) => flushSessionPersistenceNow(...args),
}));

import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	REOPEN_CONTENT_BUDGET_MS,
	listClosedTabs,
	runRemoteClosedTabCommand,
} from '../../../renderer/services/closedTabCommands';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab, createMockFileTab } from '../../helpers/mockTab';
import type { ClosedTabEntry, Session } from '../../../renderer/types';

const openTab = createMockAITab({ id: 'open-1', name: 'Current' });

function closedAi(id: string, name: string | null, closedAt: number): ClosedTabEntry {
	return {
		type: 'ai',
		tab: createMockAITab({ id, name, agentSessionId: `sess-${id}` }),
		unifiedIndex: 1,
		closedAt,
	};
}

function closedFile(id: string, closedAt: number): ClosedTabEntry {
	return {
		type: 'file',
		tab: createMockFileTab({ id, name: 'notes', extension: '.md', path: '/p/notes.md' }),
		unifiedIndex: 1,
		closedAt,
	};
}

function seed(history: ClosedTabEntry[]): Session {
	const session = createMockSession({
		id: 'agent-1',
		aiTabs: [openTab],
		activeTabId: 'open-1',
		unifiedTabOrder: [{ type: 'ai', id: 'open-1' }],
		unifiedClosedTabHistory: history,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: 'other-agent' });
	return session;
}

const current = () => useSessionStore.getState().sessions[0];

describe('closedTabCommands', () => {
	beforeEach(() => {
		loadReopenedTabContent.mockReset().mockResolvedValue('loaded');
		flushSessionPersistenceNow.mockReset().mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('list', () => {
		it('lists the stack newest first with index, type, label, original id and close time', async () => {
			seed([closedAi('ai-a', 'Refactor', 300), closedFile('file-b', 200)]);

			const result = await runRemoteClosedTabCommand({ action: 'list', sessionId: 'agent-1' });

			expect(result).toEqual({
				success: true,
				closedTabs: [
					{
						index: 0,
						type: 'ai',
						label: 'Refactor',
						tabId: 'ai-a',
						closedAt: 300,
						agentSessionId: 'sess-ai-a',
					},
					{ index: 1, type: 'file', label: 'notes.md', tabId: 'file-b', closedAt: 200 },
				],
			});
		});

		it('labels an unnamed AI tab with getTabDisplayName (its session id label)', () => {
			const session = seed([closedAi('ai-a', null, 1)]);
			expect(listClosedTabs(session)[0].label).not.toBe('');
		});

		it('reports an empty stack as an empty list', async () => {
			seed([]);
			expect(await runRemoteClosedTabCommand({ action: 'list', sessionId: 'agent-1' })).toEqual({
				success: true,
				closedTabs: [],
			});
		});

		it('answers a failure for an unknown agent', async () => {
			seed([]);
			const result = await runRemoteClosedTabCommand({ action: 'list', sessionId: 'ghost' });
			expect(result).toEqual({ success: false, error: 'Session not found: ghost' });
		});
	});

	describe('reopen', () => {
		it('reopens the head like Cmd+Shift+T and replies with the restored tab id', async () => {
			seed([closedAi('ai-a', 'Refactor', 300), closedFile('file-b', 200)]);

			const result = await runRemoteClosedTabCommand({ action: 'reopen', sessionId: 'agent-1' });

			expect(result.success).toBe(true);
			expect(result.tabType).toBe('ai');
			expect(result.reopened).toMatchObject({ index: 0, tabId: 'ai-a' });
			expect(result.content).toBe('loaded');
			const session = current();
			const restored = session.aiTabs.find((t) => t.id === result.tabId);
			expect(restored?.name).toBe('Refactor');
			expect(session.unifiedClosedTabHistory.map((e) => e.tab.id)).toEqual(['file-b']);
			// Foreground: the restored tab is the agent's active tab.
			expect(session.activeTabId).toBe(result.tabId);
		});

		it('reopens a deeper entry with --index and leaves the rest of the stack in order', async () => {
			seed([closedAi('ai-a', 'A', 300), closedFile('file-b', 200), closedAi('ai-c', 'C', 100)]);

			const result = await runRemoteClosedTabCommand({
				action: 'reopen',
				sessionId: 'agent-1',
				index: 1,
			});

			expect(result).toMatchObject({ success: true, tabType: 'file' });
			expect(current().filePreviewTabs.some((t) => t.id === result.tabId)).toBe(true);
			expect(current().unifiedClosedTabHistory.map((e) => e.tab.id)).toEqual(['ai-a', 'ai-c']);
		});

		it('reopens by original tab id, exact or a unique prefix', async () => {
			seed([closedAi('ai-alpha', 'A', 300), closedAi('ai-beta', 'B', 200)]);

			const byPrefix = await runRemoteClosedTabCommand({
				action: 'reopen',
				sessionId: 'agent-1',
				tabId: 'ai-be',
			});
			expect(byPrefix.reopened?.tabId).toBe('ai-beta');
			expect(current().unifiedClosedTabHistory.map((e) => e.tab.id)).toEqual(['ai-alpha']);
		});

		it('refuses an ambiguous prefix, an unknown id, an index past the end, and an empty stack', async () => {
			seed([closedAi('ai-alpha', 'A', 300), closedAi('ai-beta', 'B', 200)]);
			expect(
				await runRemoteClosedTabCommand({ action: 'reopen', sessionId: 'agent-1', tabId: 'ai-' })
			).toMatchObject({ success: false, error: expect.stringContaining('matches 2') });
			expect(
				await runRemoteClosedTabCommand({ action: 'reopen', sessionId: 'agent-1', tabId: 'zzz' })
			).toEqual({ success: false, error: 'No closed tab with id zzz' });
			expect(
				await runRemoteClosedTabCommand({ action: 'reopen', sessionId: 'agent-1', index: 5 })
			).toEqual({ success: false, error: 'No closed tab at index 5 (the stack holds 2)' });
			// Nothing was reopened by any of the refusals.
			expect(current().unifiedClosedTabHistory).toHaveLength(2);

			seed([]);
			expect(await runRemoteClosedTabCommand({ action: 'reopen', sessionId: 'agent-1' })).toEqual({
				success: false,
				error: 'No closed tabs to reopen',
			});
			expect(flushSessionPersistenceNow).not.toHaveBeenCalled();
		});

		it('--background restores the tab without changing the active tab or selecting the agent', async () => {
			seed([closedAi('ai-a', 'Refactor', 300)]);
			const selectAgent = vi.fn();

			const result = await runRemoteClosedTabCommand(
				{ action: 'reopen', sessionId: 'agent-1', background: true },
				{ selectAgent }
			);

			expect(result.success).toBe(true);
			const session = current();
			expect(session.aiTabs.some((t) => t.id === result.tabId)).toBe(true);
			expect(session.activeTabId).toBe('open-1');
			expect(session.inputMode).toBe('ai');
			expect(selectAgent).not.toHaveBeenCalled();
		});

		it('a foreground reopen selects the agent', async () => {
			seed([closedAi('ai-a', 'Refactor', 300)]);
			const selectAgent = vi.fn();

			await runRemoteClosedTabCommand({ action: 'reopen', sessionId: 'agent-1' }, { selectAgent });

			expect(selectAgent).toHaveBeenCalledWith('agent-1');
		});

		it('reads the content back and flushes with the post-reopen sessions before answering', async () => {
			seed([closedAi('ai-a', 'Refactor', 300)]);

			const result = await runRemoteClosedTabCommand({ action: 'reopen', sessionId: 'agent-1' });

			expect(loadReopenedTabContent).toHaveBeenCalledWith('agent-1', {
				type: 'ai',
				id: result.tabId,
			});
			expect(flushSessionPersistenceNow).toHaveBeenCalledTimes(1);
			const flushed = flushSessionPersistenceNow.mock.calls[0][0] as Session[];
			expect(flushed[0].aiTabs.some((t) => t.id === result.tabId)).toBe(true);
			expect(flushed[0].unifiedClosedTabHistory).toHaveLength(0);
		});

		it('answers with content "pending" when the read outlives the budget', async () => {
			vi.useFakeTimers();
			seed([closedAi('ai-a', 'Refactor', 300)]);
			loadReopenedTabContent.mockReturnValue(new Promise(() => {}));

			const pending = runRemoteClosedTabCommand({ action: 'reopen', sessionId: 'agent-1' });
			await vi.advanceTimersByTimeAsync(REOPEN_CONTENT_BUDGET_MS);

			await expect(pending).resolves.toMatchObject({ success: true, content: 'pending' });
			expect(flushSessionPersistenceNow).toHaveBeenCalledTimes(1);
		});

		it('reports a duplicate when the conversation is already open', async () => {
			seed([
				{
					type: 'ai',
					tab: createMockAITab({ id: 'ai-a', agentSessionId: 'sess-open-1' }),
					unifiedIndex: 1,
					closedAt: 1,
				},
			]);
			useSessionStore.setState({
				sessions: [
					{
						...current(),
						aiTabs: [{ ...openTab, agentSessionId: 'sess-open-1' }],
					},
				],
			});

			const result = await runRemoteClosedTabCommand({ action: 'reopen', sessionId: 'agent-1' });

			expect(result).toMatchObject({ success: true, tabId: 'open-1', wasDuplicate: true });
			expect(current().unifiedClosedTabHistory).toHaveLength(0);
		});
	});
});
