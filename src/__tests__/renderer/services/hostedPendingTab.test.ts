/**
 * R15: New Tab while the link is down opens a tab at once, in every mode. A local and an SSH
 * agent open it here (`createTab()`); a hosted agent whose host is not connected opens it here too
 * (`openHostedTabOrHere()`, `AITab.pendingHostTab`) and makes it on the host under the same id when
 * the link is back or at its first send, so its draft, its kept message and its retry stay on it.
 */

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	closeHostedTab,
	closingHostTabIds,
	createPendingHostTabs,
	hostedTargetOf,
	openHostedTabOrHere,
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
});
