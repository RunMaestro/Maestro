/**
 * R15: New Tab while the link is down opens a tab at once, in every mode. A local and an SSH
 * agent open it here (`createTab()`); a hosted agent whose host is not connected opens it here too
 * (`openHostedTabOrHere()`, `AITab.pendingHostTab`) and makes it on the host under the same id when
 * the link is back or at its first send, so its draft, its kept message and its retry stay on it.
 */

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	__hostedTabBookSizesForTests,
	closeHostedTab,
	closingHostTabIds,
	createPendingHostTabs,
	hostedTargetOf,
	nextPendingHostTabRetryAt,
	openHostedTabOrHere,
	PENDING_HOST_TAB_RETRY_MS,
	pruneHostedTabBooks,
	sendHostedTurn,
} from '../../../renderer/services/hostedTurns';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import type { Session } from '../../../renderer/types';
import { projectHostedSession } from '../../../renderer/utils/hostedSession';
import { closeTab, createTab } from '../../../renderer/utils/tabHelpers';
import {
	createMirroredPeer,
	replacePeerAgents,
	type PeerMirrorConnection,
} from '../../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import { AGENT_MODES, createModeSession, resetStores, type AgentMode } from '../../helpers';
import { createMockAITab } from '../../helpers/mockTab';

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function hostAgent(tabIds: readonly string[]): AgentRecord {
	return {
		id: 'h1',
		name: 'Docs',
		toolType: 'claude-code',
		activeTabId: tabIds[0],
		aiTabs: tabIds.map((id) => ({ id, agentSessionId: `s-${id}` })),
	};
}

function hydrateHost(tabIds: readonly string[], connection: PeerMirrorConnection) {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[hostAgent(tabIds)],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection }]);
}

function seed(mode: AgentMode): Session {
	const session = createModeSession(mode, {
		id: `row-${mode}`,
		activeTabId: 't1',
		aiTabs: [createMockAITab({ id: 't1', agentSessionId: 's-t1', logs: [] })],
		unifiedTabOrder: [{ type: 'ai' as const, id: 't1' }],
		executionQueue: [],
		state: 'idle',
	});
	const shown =
		mode === 'hosted' ? projectHostedSession(session, { agent: hostAgent(['t1']) }) : session;
	useSessionStore.setState({ sessions: [shown], activeSessionId: shown.id });
	return shown;
}

const current = () => useSessionStore.getState().sessions[0];

/** The host takes the id it is asked for, as a current host does. */
function hostTakesIds() {
	act$.mockImplementation(async (_peer: string, _agent: string, action: { kind: string }) => {
		const asked = action as { kind: string; tabId?: string };
		if (asked.kind === 'new-tab') {
			return { ok: true, result: { kind: 'new-tab', tabId: asked.tabId ?? 'host-own' } };
		}
		if (asked.kind === 'send') {
			return { ok: true, result: { kind: 'send', receipt: { status: 'started' } } };
		}
		return { ok: true, result: { kind: asked.kind, tabId: asked.tabId } };
	});
}

describe('New Tab while the link is down (R15)', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSettingsStore.setState({ federationHostedAgents: true });
		useNotificationStore.setState({ toasts: [] });
		act$.mockReset();
		maestro.federation = { act: act$ };
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it('opens the tab at once, shown and after the others, in every mode', async () => {
		const outcomes: Record<string, unknown> = {};
		for (const mode of AGENT_MODES) {
			const session = seed(mode);
			let newId: string | null = null;
			if (mode === 'hosted') {
				hydrateHost(['t1'], 'lost');
				await act(async () => {
					newId = await openHostedTabOrHere(session);
				});
			} else {
				const created = createTab(session)!;
				useSessionStore.setState({ sessions: [created.session] });
				newId = created.tab.id;
			}
			const shown = current();
			outcomes[mode] = {
				opened: !!newId,
				shown: shown.activeTabId === newId,
				strip: shown.unifiedTabOrder.map((ref) => (ref.id === newId ? 'NEW' : ref.id)),
			};
		}
		expect(outcomes.hosted).toEqual(outcomes.local);
		expect(outcomes.ssh).toEqual(outcomes.local);
		expect(outcomes.hosted).toEqual({ opened: true, shown: true, strip: ['t1', 'NEW'] });
		// Nothing was asked of a host that is not connected, and nothing was refused.
		expect(act$).not.toHaveBeenCalled();
		expect(useNotificationStore.getState().toasts).toHaveLength(0);
	});

	it('keeps the blank tab through the host sync while it waits', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		const synced = projectHostedSession(current(), { agent: hostAgent(['t1']) });
		expect(synced.aiTabs.map((tab) => tab.id)).toEqual(['t1', tabId]);
		expect(synced.aiTabs[1].pendingHostTab).toBe(true);
	});

	it('makes the tab on the host under the same id once the link is back', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		hydrateHost(['t1'], 'connected');
		hostTakesIds();

		createPendingHostTabs(current());
		createPendingHostTabs(current());
		await flush();

		const creates = act$.mock.calls.filter(([, , action]) => action?.kind === 'new-tab');
		expect(creates).toHaveLength(1);
		expect(creates[0][2]).toEqual({ kind: 'new-tab', tabId });
		// The host's report of it makes it the host's: same id, no longer waiting.
		const synced = projectHostedSession(current(), { agent: hostAgent(['t1', tabId]) });
		const tab = synced.aiTabs.find((candidate) => candidate.id === tabId);
		expect(tab).toBeDefined();
		expect(tab?.pendingHostTab).toBeUndefined();
		expect(synced.activeTabId).toBe(tabId);
	});

	it('makes the tab on the host at its first send, and sends into it, with no new-tab notice', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		hydrateHost(['t1'], 'connected');
		hostTakesIds();

		await act(async () => {
			await sendHostedTurn(current(), tabId, 'hello', []);
		});

		const kinds = act$.mock.calls.map(([, , action]) => action?.kind);
		expect(kinds).toContain('new-tab');
		expect(kinds).toContain('send');
		expect(kinds.indexOf('new-tab')).toBeLessThan(kinds.indexOf('send'));
		const send = act$.mock.calls.find(([, , action]) => action?.kind === 'send')?.[2];
		expect(send).toMatchObject({ tabId, text: 'hello' });
		expect(useNotificationStore.getState().toasts).toHaveLength(0);
	});

	it('takes the id an older host answers when nothing here is keyed on the tab yet', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		hydrateHost(['t1'], 'connected');
		act$.mockResolvedValue({ ok: true, result: { kind: 'new-tab', tabId: 'host-own' } });

		createPendingHostTabs(current());
		await flush();

		const ids = current().aiTabs.map((tab) => tab.id);
		expect(ids).toEqual(['t1', 'host-own']);
		expect(ids).not.toContain(tabId);
		expect(current().activeTabId).toBe('host-own');
	});

	// Parity R27: the tab stays a copy here (a kept message is keyed on it), and its first send goes
	// into the tab the older host made for it, never into yet another new one.
	it('sends the kept message of a tab an older host made under its own id into that host tab (R27)', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		useSessionStore.setState({
			sessions: [
				{
					...current(),
					executionQueue: [{ id: 'kept', timestamp: 1, tabId, type: 'message', text: 'continue' }],
				},
			],
		});
		hydrateHost(['t1'], 'connected');
		act$.mockImplementation(async (_peer: string, _agent: string, action: { kind: string }) => {
			if (action.kind === 'new-tab') {
				return { ok: true, result: { kind: 'new-tab', tabId: 'host-own' } };
			}
			if (action.kind === 'send') {
				return { ok: true, result: { kind: 'send', receipt: { status: 'started' } } };
			}
			return { ok: true, result: { kind: action.kind } };
		});

		createPendingHostTabs(current());
		await flush();
		// The copy keeps its id: the kept message is keyed on it.
		expect(current().aiTabs.map((tab) => tab.id)).toContain(tabId);

		await act(async () => {
			await sendHostedTurn(current(), tabId, 'continue', []);
		});

		const creates = act$.mock.calls.filter(([, , action]) => action?.kind === 'new-tab');
		expect(creates).toHaveLength(1);
		const send = act$.mock.calls.find(([, , action]) => action?.kind === 'send')?.[2];
		expect(send).toMatchObject({ tabId: 'host-own', text: 'continue' });
	});

	// Parity R28: the copy's host tab is forgotten with the copy, so the book does not grow.
	it('forgets the host tab an older host made for a copy once the copy is closed (R28)', async () => {
		pruneHostedTabBooks([]);
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		useSessionStore.setState({
			sessions: [
				{
					...current(),
					executionQueue: [{ id: 'kept', timestamp: 1, tabId, type: 'message', text: 'go' }],
				},
			],
		});
		hydrateHost(['t1'], 'connected');
		act$.mockImplementation(async (_peer: string, _agent: string, action: { kind: string }) =>
			action.kind === 'new-tab'
				? { ok: true, result: { kind: 'new-tab', tabId: 'host-own' } }
				: { ok: true, result: { kind: action.kind } }
		);
		createPendingHostTabs(current());
		await flush();
		expect(__hostedTabBookSizesForTests().copies).toBe(1);

		// Kept while the copy is on the record.
		pruneHostedTabBooks(useSessionStore.getState().sessions);
		expect(__hostedTabBookSizesForTests().copies).toBe(1);

		const closed = closeTab({ ...current(), executionQueue: [] }, tabId)!.session;
		useSessionStore.setState({ sessions: [closed] });
		pruneHostedTabBooks(useSessionStore.getState().sessions);
		expect(__hostedTabBookSizesForTests().copies).toBe(0);
	});

	it.each(['agent', 'peer'] as const)(
		'forgets a close owed to a host tab once the %s is gone (R28)',
		async (gone) => {
			pruneHostedTabBooks([]);
			const session = seed('hosted');
			hydrateHost(['t1'], 'lost');
			let tabId = '';
			await act(async () => {
				tabId = (await openHostedTabOrHere(session)) as string;
			});
			hydrateHost(['t1'], 'connected');
			let answer!: (value: unknown) => void;
			act$.mockImplementation(async (_peer: string, _agent: string, action: { kind: string }) =>
				action.kind === 'new-tab'
					? new Promise((resolve) => (answer = resolve))
					: { ok: true, result: { kind: action.kind, tabId } }
			);
			createPendingHostTabs(current());
			const before = current();
			useSessionStore.setState({ sessions: [closeTab(before, tabId)!.session] });
			closeHostedTab(before, tabId);
			answer({ ok: false, error: 'The host did not answer in time.', code: 'timeout' });
			await flush();
			expect(__hostedTabBookSizesForTests().closesOwed).toBe(1);

			// Kept while the agent is held: the host may still list the tab.
			pruneHostedTabBooks(useSessionStore.getState().sessions);
			expect(__hostedTabBookSizesForTests().closesOwed).toBe(1);

			if (gone === 'agent') {
				const { peer } = replacePeerAgents(
					createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
					[],
					[],
					2
				);
				usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
			} else {
				usePeerMirrorStore.getState().hydrate([]);
			}
			pruneHostedTabBooks(useSessionStore.getState().sessions);
			expect(__hostedTabBookSizesForTests().closesOwed).toBe(0);
			expect(closingHostTabIds(hostedTargetOf(current())!, current()).has(tabId)).toBe(false);
		}
	);

	it("gives the older host's tab the copy's pills and name when the copy keeps its id (CodeRabbit on #2161)", async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		useSessionStore.setState({
			sessions: [
				{
					...current(),
					aiTabs: current().aiTabs.map((tab) =>
						tab.id === tabId ? { ...tab, saveToHistory: false, name: 'Notes' } : tab
					),
					executionQueue: [{ id: 'kept', timestamp: 1, tabId, type: 'message', text: 'go' }],
				},
			],
		});
		hydrateHost(['t1'], 'connected');
		act$.mockImplementation(async (_peer: string, _agent: string, action: { kind: string }) =>
			action.kind === 'new-tab'
				? { ok: true, result: { kind: 'new-tab', tabId: 'host-own' } }
				: { ok: true, result: { kind: action.kind } }
		);

		createPendingHostTabs(current());
		await flush();

		expect(current().aiTabs.map((tab) => tab.id)).toContain(tabId);
		const update = act$.mock.calls.find(([, , action]) => action?.kind === 'update-tab')?.[2];
		expect(update).toMatchObject({ tabId: 'host-own', patch: { saveToHistory: false } });
	});

	it("spends the merged context of a tab that took an older host's id on the tab it is now (CodeRabbit on #2161)", async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		useSessionStore.setState({
			sessions: [
				{
					...current(),
					aiTabs: current().aiTabs.map((tab) =>
						tab.id === tabId ? { ...tab, pendingMergedContext: 'merged notes' } : tab
					),
				},
			],
		});
		hydrateHost(['t1'], 'connected');
		act$.mockImplementation(async (_peer: string, _agent: string, action: { kind: string }) => {
			if (action.kind === 'new-tab') {
				return { ok: true, result: { kind: 'new-tab', tabId: 'host-own' } };
			}
			if (action.kind === 'send') {
				return { ok: true, result: { kind: 'send', receipt: { status: 'started' } } };
			}
			return { ok: true, result: { kind: action.kind } };
		});

		await act(async () => {
			await sendHostedTurn(current(), tabId, 'hello', []);
		});

		const handed = act$.mock.calls.find(
			([, , action]) => action?.kind === 'update-tab' && action.patch?.mergedContext
		)?.[2];
		expect(handed).toMatchObject({ tabId: 'host-own', patch: { mergedContext: 'merged notes' } });
		const adopted = current().aiTabs.find((tab) => tab.id === 'host-own');
		expect(adopted).toBeDefined();
		expect(adopted?.pendingMergedContext).toBeUndefined();
	});

	it('names when a pending tab whose making failed is asked again, only while its host is connected (CodeRabbit on #2161)', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		await act(async () => {
			await openHostedTabOrHere(session);
		});
		hydrateHost(['t1'], 'connected');
		act$.mockResolvedValue({ ok: false, error: 'The host refused the tab.' });
		const before = Date.now();
		createPendingHostTabs(current());
		await flush();

		const at = nextPendingHostTabRetryAt(useSessionStore.getState().sessions);
		expect(at).toBeGreaterThanOrEqual(before + PENDING_HOST_TAB_RETRY_MS);
		expect(at).toBeLessThanOrEqual(Date.now() + PENDING_HOST_TAB_RETRY_MS);
		hydrateHost(['t1'], 'lost');
		expect(nextPendingHostTabRetryAt(useSessionStore.getState().sessions)).toBeUndefined();
	});

	it('leaves one tab when the report of an older host draws its tab before the answer (Greptile on #2161)', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		await act(async () => {
			await openHostedTabOrHere(session);
		});
		hydrateHost(['t1'], 'connected');
		act$.mockImplementation(async () => {
			// The client reads the agents again before it answers: the sync draws the host's tab.
			useSessionStore.setState({
				sessions: [projectHostedSession(current(), { agent: hostAgent(['t1', 'host-own']) })],
			});
			return { ok: true, result: { kind: 'new-tab', tabId: 'host-own' } };
		});

		createPendingHostTabs(current());
		await flush();

		expect(current().aiTabs.map((tab) => tab.id)).toEqual(['t1', 'host-own']);
		expect(current().unifiedTabOrder.filter((ref) => ref.id === 'host-own')).toHaveLength(1);
	});

	it('closes the tab on the host, and never draws it back, when the tab was closed while being made (Greptile and CodeRabbit on #2161)', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		hydrateHost(['t1'], 'connected');
		let answer!: (value: unknown) => void;
		act$.mockImplementation(async (_peer: string, _agent: string, action: { kind: string }) =>
			action.kind === 'new-tab'
				? new Promise((resolve) => (answer = resolve))
				: { ok: true, result: { kind: action.kind, tabId } }
		);

		createPendingHostTabs(current());
		// The user closes it here while the host makes it.
		const before = current();
		useSessionStore.setState({ sessions: [closeTab(before, tabId)!.session] });
		closeHostedTab(before, tabId);
		const target = hostedTargetOf(current())!;
		expect(closingHostTabIds(target).has(tabId)).toBe(true);

		answer({ ok: true, result: { kind: 'new-tab', tabId } });
		await flush();

		const closes = act$.mock.calls.filter(([, , action]) => action?.kind === 'close-tab');
		expect(closes.map(([, , action]) => action.tabId)).toEqual([tabId]);
		// The host reports the tab it made before it reports the close.
		hydrateHost(['t1', tabId], 'connected');
		const synced = projectHostedSession(current(), {
			agent: hostAgent(['t1', tabId]),
			closing: closingHostTabIds(hostedTargetOf(current())!),
		});
		expect(synced.aiTabs.map((tab) => tab.id)).toEqual(['t1']);
	});

	it('closes the tab on the host when it left the record while being made by a path that never told the host (R24)', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		hydrateHost(['t1'], 'connected');
		let answer!: (value: unknown) => void;
		act$.mockImplementation(async (_peer: string, _agent: string, action: { kind: string }) =>
			action.kind === 'new-tab'
				? new Promise((resolve) => (answer = resolve))
				: { ok: true, result: { kind: action.kind, tabId } }
		);

		createPendingHostTabs(current());
		// Gone here with no closeHostedTab() call.
		useSessionStore.setState({ sessions: [closeTab(current(), tabId)!.session] });

		answer({ ok: true, result: { kind: 'new-tab', tabId } });
		await flush();

		const actions = act$.mock.calls.map(([, , action]) => action);
		expect(actions.filter((action) => action?.kind === 'close-tab').map((a) => a.tabId)).toEqual([
			tabId,
		]);
		// No follow-up settings or name for a tab that is gone.
		expect(actions.some((action) => action?.kind === 'update-tab')).toBe(false);
		expect(actions.some((action) => action?.kind === 'rename-tab')).toBe(false);
		// The host reports the tab it made before it reports the close.
		hydrateHost(['t1', tabId], 'connected');
		const synced = projectHostedSession(current(), {
			agent: hostAgent(['t1', tabId]),
			closing: closingHostTabIds(hostedTargetOf(current())!),
		});
		expect(synced.aiTabs.map((tab) => tab.id)).toEqual(['t1']);
	});

	it('keeps a pending tab that left the record closed when the report of the host lists it before the answer (CodeRabbit on #2161)', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		hydrateHost(['t1'], 'connected');
		let answer!: (value: unknown) => void;
		act$.mockImplementation(async (_peer: string, _agent: string, action: { kind: string }) =>
			action.kind === 'new-tab'
				? new Promise((resolve) => (answer = resolve))
				: { ok: true, result: { kind: action.kind, tabId } }
		);

		createPendingHostTabs(current());
		// Gone here with no closeHostedTab() call, then the host reports the tab it made.
		useSessionStore.setState({ sessions: [closeTab(current(), tabId)!.session] });
		hydrateHost(['t1', tabId], 'connected');
		const target = hostedTargetOf(current())!;
		const synced = projectHostedSession(current(), {
			agent: hostAgent(['t1', tabId]),
			closing: closingHostTabIds(target, current()),
		});
		expect(synced.aiTabs.map((tab) => tab.id)).toEqual(['t1']);
		useSessionStore.setState({ sessions: [synced] });

		answer({ ok: true, result: { kind: 'new-tab', tabId } });
		await flush();

		const actions = act$.mock.calls.map(([, , action]) => action);
		expect(actions.filter((action) => action?.kind === 'close-tab').map((a) => a.tabId)).toEqual([
			tabId,
		]);
		expect(actions.some((action) => action?.kind === 'update-tab')).toBe(false);
	});

	it('closes a tab closed while being made on the host once it lists it, when the answer was lost (CodeRabbit on #2161)', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		hydrateHost(['t1'], 'connected');
		let answer!: (value: unknown) => void;
		act$.mockImplementation(async (_peer: string, _agent: string, action: { kind: string }) =>
			action.kind === 'new-tab'
				? new Promise((resolve) => (answer = resolve))
				: { ok: true, result: { kind: action.kind, tabId } }
		);

		createPendingHostTabs(current());
		const before = current();
		useSessionStore.setState({ sessions: [closeTab(before, tabId)!.session] });
		closeHostedTab(before, tabId);

		// The answer is lost: the host may have made the tab.
		answer({ ok: false, error: 'The host did not answer in time.', code: 'timeout' });
		await flush();
		const closes = () =>
			act$.mock.calls
				.filter(([, , action]) => action?.kind === 'close-tab')
				.map(([, , a]) => a.tabId);
		expect(closes()).toEqual([]);

		// The host lists it: never drawn, and closed there.
		hydrateHost(['t1', tabId], 'connected');
		const target = hostedTargetOf(current())!;
		const synced = projectHostedSession(current(), {
			agent: hostAgent(['t1', tabId]),
			closing: closingHostTabIds(target, current()),
		});
		expect(synced.aiTabs.map((tab) => tab.id)).toEqual(['t1']);
		createPendingHostTabs(current());
		await flush();
		expect(closes()).toEqual([tabId]);
	});

	it('closes nothing on the host when it refused to make a tab closed here (CodeRabbit on #2161)', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		hydrateHost(['t1'], 'connected');
		let answer!: (value: unknown) => void;
		act$.mockImplementation(async (_peer: string, _agent: string, action: { kind: string }) =>
			action.kind === 'new-tab'
				? new Promise((resolve) => (answer = resolve))
				: { ok: true, result: { kind: action.kind, tabId } }
		);

		createPendingHostTabs(current());
		const before = current();
		useSessionStore.setState({ sessions: [closeTab(before, tabId)!.session] });
		closeHostedTab(before, tabId);
		answer({ ok: false, error: 'No.', code: 'rejected' });
		await flush();

		hydrateHost(['t1'], 'connected');
		createPendingHostTabs(current());
		await flush();
		expect(act$.mock.calls.some(([, , action]) => action?.kind === 'close-tab')).toBe(false);
		expect(closingHostTabIds(hostedTargetOf(current())!, current()).has(tabId)).toBe(false);
	});

	it('gives the host the name the tab got while it waited, even when the report of the host lands first (CodeRabbit on #2161)', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		useSessionStore.setState({
			sessions: [
				{
					...current(),
					aiTabs: current().aiTabs.map((tab) =>
						tab.id === tabId ? { ...tab, name: 'Notes' } : tab
					),
				},
			],
		});
		hydrateHost(['t1'], 'connected');
		act$.mockImplementation(async (_peer: string, _agent: string, action: { kind: string }) => {
			if (action.kind === 'new-tab') {
				// The host's blank report of the tab lands before the answer.
				useSessionStore.setState({
					sessions: [projectHostedSession(current(), { agent: hostAgent(['t1', tabId]) })],
				});
				return { ok: true, result: { kind: 'new-tab', tabId } };
			}
			return { ok: true, result: { kind: action.kind, tabId } };
		});

		createPendingHostTabs(current());
		await flush();

		const rename = act$.mock.calls.find(([, , action]) => action?.kind === 'rename-tab')?.[2];
		expect(rename).toMatchObject({ tabId, name: 'Notes' });
	});

	it('keeps a tile on the tab when an older host gives it its own id (CodeRabbit on #2161)', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		const layout = {
			kind: 'split' as const,
			id: 'split-1',
			direction: 'row' as const,
			sizes: [50, 50],
			children: [
				{ kind: 'leaf' as const, id: 'leaf-1', tab: { type: 'ai' as const, id: 't1' } },
				{ kind: 'leaf' as const, id: 'leaf-2', tab: { type: 'ai' as const, id: tabId } },
			],
		};
		useSessionStore.setState({
			sessions: [
				{
					...current(),
					tabGroups: [{ id: 'g1', name: 'Pair', layout, focusedPaneId: 'leaf-2', createdAt: 1 }],
				},
			],
		});
		hydrateHost(['t1'], 'connected');
		act$.mockResolvedValue({ ok: true, result: { kind: 'new-tab', tabId: 'host-own' } });

		createPendingHostTabs(current());
		await flush();

		const [group] = current().tabGroups;
		const leaves = group.layout.kind === 'split' ? group.layout.children : [];
		expect(leaves.map((leaf) => (leaf.kind === 'leaf' ? leaf.tab.id : null))).toEqual([
			't1',
			'host-own',
		]);
	});

	it('gives the host the pills the tab has when the host answers, not when it was asked (CodeRabbit on #2161)', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session, { fields: { showThinking: 'on' } })) as string;
		});
		hydrateHost(['t1'], 'connected');
		act$.mockImplementation(async (_peer: string, _agent: string, action: { kind: string }) => {
			if (action.kind === 'new-tab') {
				// The user turns thinking off while the host makes the tab, then its report lands.
				useSessionStore.setState({
					sessions: [
						{
							...current(),
							aiTabs: current().aiTabs.map((tab) =>
								tab.id === tabId ? { ...tab, showThinking: 'off' as const } : tab
							),
						},
					],
				});
				useSessionStore.setState({
					sessions: [projectHostedSession(current(), { agent: hostAgent(['t1', tabId]) })],
				});
				return { ok: true, result: { kind: 'new-tab', tabId } };
			}
			return { ok: true, result: { kind: action.kind, tabId } };
		});

		createPendingHostTabs(current());
		await flush();

		const patch = act$.mock.calls.find(([, , action]) => action?.kind === 'update-tab')?.[2];
		expect(patch).toMatchObject({ tabId, patch: { thinking: 'off' } });
		expect(current().aiTabs.find((tab) => tab.id === tabId)?.showThinking).toBe('off');
	});

	it('keeps the host id in one tile when the drawn copy was tiled too (CodeRabbit on #2161)', async () => {
		const session = seed('hosted');
		hydrateHost(['t1'], 'lost');
		let tabId = '';
		await act(async () => {
			tabId = (await openHostedTabOrHere(session)) as string;
		});
		const pair = (id: string, a: string, b: string) => ({
			id,
			name: id,
			focusedPaneId: null,
			createdAt: 1,
			layout: {
				kind: 'split' as const,
				id: `${id}-split`,
				direction: 'row' as const,
				sizes: [50, 50],
				children: [
					{ kind: 'leaf' as const, id: `${id}-a`, tab: { type: 'ai' as const, id: a } },
					{ kind: 'leaf' as const, id: `${id}-b`, tab: { type: 'ai' as const, id: b } },
				],
			},
		});
		hydrateHost(['t1'], 'connected');
		act$.mockImplementation(async (_peer: string, _agent: string, action: { kind: string }) => {
			if (action.kind !== 'new-tab') return { ok: true, result: { kind: action.kind } };
			// The host's copy lands first, and is tiled with t1 before the answer arrives.
			const drawn = projectHostedSession(current(), { agent: hostAgent(['t1', 'host-own']) });
			useSessionStore.setState({
				sessions: [
					{
						...drawn,
						aiTabs: [...drawn.aiTabs, createMockAITab({ id: 't9', logs: [] })],
						tabGroups: [pair('g1', 't1', 'host-own'), pair('g2', 't9', tabId)],
					},
				],
			});
			return { ok: true, result: { kind: 'new-tab', tabId: 'host-own' } };
		});

		createPendingHostTabs(current());
		await flush();

		const leaves = current().tabGroups.flatMap((group) =>
			group.layout.kind === 'split'
				? group.layout.children.map((leaf) => (leaf.kind === 'leaf' ? leaf.tab.id : ''))
				: [group.layout.tab.id]
		);
		expect(leaves.filter((id) => id === 'host-own')).toHaveLength(1);
		const live = new Set(current().aiTabs.map((tab) => tab.id));
		expect(leaves.every((id) => live.has(id))).toBe(true);
	});
});
