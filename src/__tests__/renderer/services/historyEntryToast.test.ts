/**
 * Tests for `services/historyEntryToast.ts`: a saved `/history` raises the same "History Entry
 * Added" toast for a local, an SSH, and a hosted agent (M13). A local or SSH agent's handler raises
 * it as it saves the entry; a hosted agent's host saves it, and the window that sent `/history`
 * raises the toast when the host's "Synopsis saved to history" line reaches the tab's mirror.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { notifyToast } = vi.hoisted(() => ({ notifyToast: vi.fn() }));
vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast,
}));

import {
	HOSTED_HISTORY_CLOCK_SKEW_MS,
	notifyHistoryEntryAdded,
	watchHostedHistoryCommand,
} from '../../../renderer/services/historyEntryToast';
import { sendHostedTurn } from '../../../renderer/services/hostedTurns';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import type { LogEntryRecord } from '../../../shared/maestro-lib/store/transcript';
import { HISTORY_COMMAND_TEXT } from '../../../shared/maestroBuiltinCommandText';
import { resetStores } from '../../helpers';
import { AGENT_MODES, createModeSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();
const transcript$ = vi.fn();

function hydrateHost() {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[{ id: 'h1', name: 'Docs', toolType: 'claude-code', aiTabs: [{ id: 't1' }] }],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

const line = (id: string, text: string, timestamp = Date.now()): LogEntryRecord => ({
	id,
	timestamp,
	source: 'system',
	text,
});

/** What the host's tab holds, as the next transcript read answers it. */
function hostTabHolds(entries: LogEntryRecord[]): void {
	transcript$.mockResolvedValue(entries);
}

/** The host wrote to the tab: the mirror marks it stale, as a `gap` does. */
function hostWroteTab(): void {
	usePeerMirrorStore
		.getState()
		.applyPush({ peerId: 'box', event: { type: 'tab.stale', agentId: 'h1', tabId: 't1' } });
}

const toastOf = () =>
	notifyToast.mock.calls.filter(([toast]) => toast.title === 'History Entry Added');

describe('historyEntryToast', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		notifyToast.mockReset();
		useSettingsStore.setState({ federationHostedAgents: true });
		act$.mockReset();
		act$.mockResolvedValue({ ok: true, result: { kind: 'send', receipt: { status: 'ran' } } });
		transcript$.mockReset();
		hostTabHolds([]);
		maestro.federation = { act: act$, transcript: transcript$ };
	});

	afterEach(() => {
		delete maestro.federation;
		vi.useRealTimers();
	});

	it.each(AGENT_MODES)(
		'%s: a saved /history raises the same History Entry Added toast',
		async (mode) => {
			hydrateHost();
			useSessionStore.setState({ groups: [{ id: 'g1', name: 'Work' }] as never });
			const session = createModeSession(mode, {
				id: 'row',
				name: 'Docs',
				groupId: 'g1',
				activeTabId: 't1',
				aiTabs: [createMockAITab({ id: 't1', name: 'Planning', agentSessionId: 's1' })],
			});
			useSessionStore.setState({ sessions: [session] });

			if (mode === 'hosted') {
				// The host runs it; its lines reach this window through the mirror.
				hostTabHolds([line('old', 'hello')]);
				expect(await sendHostedTurn(session, 't1', '/history', [])).toEqual({ status: 'ran' });
				hostTabHolds([
					line('old', 'hello'),
					line('p1', HISTORY_COMMAND_TEXT.pending),
					line('p2', HISTORY_COMMAND_TEXT.saved('Fixed the parser')),
				]);
				hostWroteTab();
				await vi.waitFor(() => expect(toastOf()).toHaveLength(1));
			} else {
				// What `useWizardHandlers`' `/history` calls once it saved the entry.
				notifyHistoryEntryAdded(session, session.aiTabs[0], 'Fixed the parser');
			}

			expect(toastOf()).toEqual([
				[
					{
						type: 'success',
						title: 'History Entry Added',
						message: 'Fixed the parser',
						group: 'Work',
						project: 'Docs',
						sessionId: 'row',
						tabId: 't1',
						tabName: 'Planning',
					},
				],
			]);
		}
	);

	it('raises no toast for a hosted /history that had nothing to report, and stops watching', async () => {
		hydrateHost();
		const session = createModeSession('hosted', { id: 'row', name: 'Docs', activeTabId: 't1' });
		useSessionStore.setState({ sessions: [session] });
		await sendHostedTurn(session, 't1', '/history', []);
		hostTabHolds([line('p1', HISTORY_COMMAND_TEXT.nothingToReport)]);
		hostWroteTab();
		await vi.waitFor(() => expect(transcript$).toHaveBeenCalledTimes(2));
		hostTabHolds([
			line('p1', HISTORY_COMMAND_TEXT.nothingToReport),
			line('p2', HISTORY_COMMAND_TEXT.saved('later run')),
		]);
		hostWroteTab();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(toastOf()).toEqual([]);
	});

	it('watches only a /history the host ran: a plain message or a held /history raises none', async () => {
		hydrateHost();
		const session = createModeSession('hosted', { id: 'row', name: 'Docs', activeTabId: 't1' });
		useSessionStore.setState({ sessions: [session] });
		hostTabHolds([line('p2', HISTORY_COMMAND_TEXT.saved('old run'))]);
		await sendHostedTurn(session, 't1', 'hello', []);
		await sendHostedTurn(session, 't1', '/history', [], { held: true });
		hostWroteTab();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(transcript$).not.toHaveBeenCalled();
		expect(toastOf()).toEqual([]);
	});

	it("ignores an older run's saved line: by id when the tab was read before, else by time", async () => {
		hydrateHost();
		useSessionStore.setState({
			sessions: [createModeSession('hosted', { id: 'row', name: 'Docs', activeTabId: 't1' })],
		});
		const sentAt = Date.now();
		// Read before the send: the old line's id is in the baseline.
		const stop = watchHostedHistoryCommand('row', { peerId: 'box', agentId: 'h1' }, 't1', {
			sentAt,
			baseline: new Set(['old']),
		});
		hostTabHolds([line('old', HISTORY_COMMAND_TEXT.saved('old run'))]);
		hostWroteTab();
		await vi.waitFor(() => expect(transcript$).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(toastOf()).toEqual([]);
		stop();

		// Never read: a line older than the send (beyond the clock skew) is an older run.
		transcript$.mockReset();
		hostTabHolds([
			line('old', HISTORY_COMMAND_TEXT.saved('old run'), sentAt - HOSTED_HISTORY_CLOCK_SKEW_MS - 1),
		]);
		resetStores(usePeerMirrorStore);
		hydrateHost();
		const stopAgain = watchHostedHistoryCommand('row', { peerId: 'box', agentId: 'h1' }, 't1', {
			sentAt,
		});
		await vi.waitFor(() => expect(transcript$).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(toastOf()).toEqual([]);
		stopAgain();
	});

	it('stops watching once its time is up', async () => {
		vi.useFakeTimers();
		hydrateHost();
		useSessionStore.setState({
			sessions: [createModeSession('hosted', { id: 'row', name: 'Docs', activeTabId: 't1' })],
		});
		watchHostedHistoryCommand('row', { peerId: 'box', agentId: 'h1' }, 't1', {
			sentAt: Date.now(),
			baseline: new Set(),
			timeoutMs: 1_000,
		});
		vi.advanceTimersByTime(1_001);
		vi.useRealTimers();
		hostTabHolds([line('p2', HISTORY_COMMAND_TEXT.saved('too late'))]);
		hostWroteTab();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(toastOf()).toEqual([]);
	});
});
