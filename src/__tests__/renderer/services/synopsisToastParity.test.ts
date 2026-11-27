/**
 * Parity U3: after a plain turn that saves to History, every mode raises the same "Synopsis" toast
 * once the turn's History entry is saved.
 *
 * A local and an SSH agent raise it from the exit synopsis (`runExitSynopsis()`), in the window
 * that runs the turn. A hosted agent's synopsis runs on its host, which writes the entry there:
 * the window that sent the turn reads the host's History and raises the same toast
 * (`watchHostedTurnSynopsis()`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runExitSynopsis } from '../../../renderer/hooks/agent/internal/helpers/exitSynopsis';
import {
	HOSTED_SYNOPSIS_IDLE_MS,
	HOSTED_SYNOPSIS_POLL_MS,
	resetHostedSynopsisWatchesForTest,
	watchHostedTurnSynopsis,
} from '../../../renderer/services/historyEntryToast';
import { sendHostedTurn } from '../../../renderer/services/hostedTurns';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { HistoryEntry } from '../../../renderer/types';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import { AGENT_MODES, createModeSession, resetStores, type AgentMode } from '../../helpers';
import { createMockAITab } from '../../helpers/mockTab';

const maestro = window.maestro as unknown as Record<string, unknown>;
const SUMMARY = 'Fake reply';

function hostTab(state: 'idle' | 'busy', thinkingStartTime?: number) {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[
			{
				id: 'h1',
				name: 'Docs',
				toolType: 'claude-code',
				aiTabs: [
					{
						id: 't1',
						name: 'Main',
						agentSessionId: 's1',
						state,
						...(thinkingStartTime !== undefined ? { thinkingStartTime } : {}),
					},
				],
			},
		],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

function seed(mode: AgentMode) {
	const session = createModeSession(mode, {
		id: 'row',
		name: 'Docs',
		activeTabId: 't1',
		aiTabs: [
			createMockAITab({ id: 't1', name: 'Main', agentSessionId: 's1', saveToHistory: true }),
		],
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id, groups: [] });
}

const entry = (
	id: string,
	timestamp: number,
	overrides: Partial<HistoryEntry> = {}
): HistoryEntry =>
	({
		id,
		type: 'USER',
		timestamp,
		summary: SUMMARY,
		agentSessionId: 's1',
		sessionId: 'h1',
		projectPath: '/p',
		...overrides,
	}) as HistoryEntry;

/** The toasts on screen, as the user reads them (each mode measures its own synopsis time). */
const toasts = () => useNotificationStore.getState().toasts;
const shown = () =>
	toasts().map((toast) => {
		expect(typeof toast.taskDuration).toBe('number');
		return {
			type: toast.type,
			title: toast.title,
			message: toast.message,
			group: toast.group,
			project: toast.project,
			sessionId: toast.sessionId,
			tabId: toast.tabId,
			tabName: toast.tabName,
			skipCustomNotification: toast.skipCustomNotification,
		};
	});

describe('U3: the "Synopsis" toast after a plain turn', () => {
	let hostEntries: HistoryEntry[];

	beforeEach(() => {
		vi.useFakeTimers();
		resetStores(usePeerMirrorStore, useSessionStore);
		resetHostedSynopsisWatchesForTest();
		useNotificationStore.getState().clearToasts();
		hostEntries = [entry('old', 50, { summary: 'an earlier turn' })];
		maestro.federation = {
			historyPage: vi.fn(async () => ({
				entries: [...hostEntries].reverse(),
				hasMore: false,
				total: hostEntries.length,
			})),
		};
		// The exit synopsis keeps the tab's name with the provider session.
		vi.mocked(window.maestro.claude.updateSessionName).mockResolvedValue(undefined as never);
	});

	afterEach(() => {
		resetHostedSynopsisWatchesForTest();
		vi.useRealTimers();
		delete maestro.federation;
	});

	/** Run one plain turn to its saved History entry, in `mode`. */
	async function plainTurn(mode: AgentMode): Promise<void> {
		seed(mode);
		if (mode !== 'hosted') {
			await runExitSynopsis(
				{
					sessionId: 'row',
					cwd: '/p',
					projectRoot: '/p',
					agentSessionId: 's1',
					command: '',
					groupName: 'Ungrouped',
					projectName: 'Docs',
					tabName: 'Main',
					tabId: 't1',
					toolType: 'claude-code',
				},
				{
					spawnBackgroundSynopsisRef: {
						current: vi.fn(async () => ({
							success: true,
							response: `**Summary:** ${SUMMARY}\n\n**Details:** It replied.`,
						})),
					} as never,
					addHistoryEntryRef: { current: vi.fn() } as never,
					rightPanelRef: { current: null } as never,
					updateLastSynopsisTime: vi.fn(),
					getAutorunSynopsisPrompt: () => 'Summarize.',
				}
			);
			return;
		}
		// The host took the turn and runs it; this window watches for its History entry.
		hostTab('busy', 100);
		watchHostedTurnSynopsis('row', { peerId: 'box', agentId: 'h1' }, 't1');
		await vi.advanceTimersByTimeAsync(HOSTED_SYNOPSIS_POLL_MS * 2);
		// The turn ends; the host's synopsis runs, then saves the entry.
		hostTab('idle');
		await vi.advanceTimersByTimeAsync(HOSTED_SYNOPSIS_POLL_MS * 2);
		expect(toasts()).toEqual([]);
		hostEntries.push(entry('turn', 140));
		await vi.advanceTimersByTimeAsync(HOSTED_SYNOPSIS_POLL_MS * 2);
	}

	it.each(AGENT_MODES)('%s: one "Synopsis" toast with the same words and target', async (mode) => {
		await plainTurn(mode);
		expect(shown()).toEqual([
			{
				type: 'info',
				title: 'Synopsis',
				message: SUMMARY,
				group: 'Ungrouped',
				project: 'Docs',
				sessionId: 'row',
				tabId: 't1',
				tabName: 'Main',
				skipCustomNotification: true,
			},
		]);
		// No second toast for the same entry.
		await vi.advanceTimersByTimeAsync(HOSTED_SYNOPSIS_POLL_MS * 5);
		expect(toasts()).toHaveLength(1);
	});

	it('hosted: an entry saved before the turn started is not taken for its own', async () => {
		seed('hosted');
		hostTab('busy', 100);
		watchHostedTurnSynopsis('row', { peerId: 'box', agentId: 'h1' }, 't1');
		await vi.advanceTimersByTimeAsync(HOSTED_SYNOPSIS_POLL_MS);
		// An earlier turn's synopsis lands now, stamped before this turn started.
		hostEntries.push(entry('earlier', 90, { summary: 'the turn before' }));
		hostTab('idle');
		await vi.advanceTimersByTimeAsync(HOSTED_SYNOPSIS_POLL_MS * 3);
		expect(toasts()).toEqual([]);
	});

	it('hosted: a turn the host wrote no entry for (skipped synopsis) raises nothing, and the watch ends', async () => {
		seed('hosted');
		hostTab('busy', 100);
		watchHostedTurnSynopsis('row', { peerId: 'box', agentId: 'h1' }, 't1');
		await vi.advanceTimersByTimeAsync(HOSTED_SYNOPSIS_POLL_MS);
		hostTab('idle');
		await vi.advanceTimersByTimeAsync(HOSTED_SYNOPSIS_IDLE_MS + HOSTED_SYNOPSIS_POLL_MS * 2);
		const reads = vi.mocked((maestro.federation as { historyPage: () => unknown }).historyPage).mock
			.calls.length;
		hostEntries.push(entry('late', 140));
		await vi.advanceTimersByTimeAsync(HOSTED_SYNOPSIS_POLL_MS * 5);
		expect(toasts()).toEqual([]);
		expect(
			vi.mocked((maestro.federation as { historyPage: () => unknown }).historyPage).mock.calls
				.length
		).toBe(reads);
	});

	it('hosted: a turn this window sends to a tab that saves to History is watched; one that does not is not', async () => {
		useSettingsStore.setState({ federationHostedAgents: true });
		const act = vi.fn(async () => ({
			ok: true,
			result: { kind: 'send', receipt: { status: 'started' } },
		}));
		const historyPage = vi.fn(async () => ({ entries: [], hasMore: false, total: 0 }));
		maestro.federation = { act, historyPage };
		seed('hosted');
		hostTab('busy', 100);
		const row = () => useSessionStore.getState().sessions[0];
		await sendHostedTurn(row(), 't1', 'hello', []);
		expect(historyPage).toHaveBeenCalledTimes(1);

		resetHostedSynopsisWatchesForTest();
		historyPage.mockClear();
		useSessionStore.setState((state) => ({
			sessions: state.sessions.map((s) => ({
				...s,
				aiTabs: s.aiTabs.map((t) => ({ ...t, saveToHistory: false })),
			})),
		}));
		await sendHostedTurn(row(), 't1', 'hello again', []);
		expect(historyPage).not.toHaveBeenCalled();
	});

	it("hosted: another tab's entry is not this tab's", async () => {
		seed('hosted');
		hostTab('busy', 100);
		watchHostedTurnSynopsis('row', { peerId: 'box', agentId: 'h1' }, 't1');
		await vi.advanceTimersByTimeAsync(HOSTED_SYNOPSIS_POLL_MS);
		hostTab('idle');
		hostEntries.push(entry('other', 140, { agentSessionId: 's9' }));
		await vi.advanceTimersByTimeAsync(HOSTED_SYNOPSIS_POLL_MS * 3);
		expect(toasts()).toEqual([]);
	});
});
