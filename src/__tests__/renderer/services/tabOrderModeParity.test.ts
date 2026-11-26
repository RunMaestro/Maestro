/**
 * Parity round 5, P2: the tab strip of a hosted agent follows the rules of a local one. A new tab
 * goes where a local new tab goes (`newTabPlacement`), a reopened tab (Cmd+Shift+T) returns to its
 * old slot, and the order the user dragged survives the host sync. A local and an SSH agent do this
 * here (`createTab()`, `reopenUnifiedClosedTab()`, `moveUnifiedTabToTarget()`); a hosted agent
 * asks its host (`openHostedTab()`, `reopenHostedClosedEntry()`) and must draw the same strip.
 */

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reopenHostedClosedEntry } from '../../../renderer/services/closedTabCommands';
import { openHostedTab } from '../../../renderer/services/hostedTurns';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import type { Session } from '../../../renderer/types';
import { projectHostedSession } from '../../../renderer/utils/hostedSession';
import {
	addAiTabToUnifiedHistory,
	closeTab,
	createTab,
	moveUnifiedTabToTarget,
	reopenUnifiedClosedTab,
} from '../../../renderer/utils/tabHelpers';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import { AGENT_MODES, createModeSession, resetStores, type AgentMode } from '../../helpers';
import { createMockAITab } from '../../helpers/mockTab';

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();
const TABS = ['t1', 't2', 't3'];

function hostAgent(tabIds: readonly string[]): AgentRecord {
	return {
		id: 'h1',
		name: 'Docs',
		toolType: 'claude-code',
		activeTabId: tabIds[0],
		aiTabs: tabIds.map((id) => ({ id, agentSessionId: `s-${id}` })),
	};
}

function hydrateHost(tabIds: readonly string[]) {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[hostAgent(tabIds)],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

/** The agent with three tabs, `t1` shown, and a terminal tab at the end of the strip. */
function seed(mode: AgentMode): Session {
	const session = createModeSession(mode, {
		id: `row-${mode}`,
		activeTabId: 't1',
		aiTabs: TABS.map((id) => createMockAITab({ id, agentSessionId: `s-${id}`, logs: [] })),
		unifiedTabOrder: [
			...TABS.map((id) => ({ type: 'ai' as const, id })),
			{ type: 'terminal' as const, id: 'term' },
		],
		terminalTabs: [
			{ id: 'term', name: null, shellType: 'zsh', pid: 0, cwd: '/', createdAt: 0, state: 'idle' },
		],
		executionQueue: [],
		state: 'idle',
	});
	const shown =
		mode === 'hosted' ? projectHostedSession(session, { agent: hostAgent(TABS) }) : session;
	useSessionStore.setState({ sessions: [shown], activeSessionId: shown.id });
	return shown;
}

const strip = (session: Session, newId?: string) =>
	session.unifiedTabOrder.map((ref) => (ref.id === newId ? 'NEW' : ref.id));
const current = () => useSessionStore.getState().sessions[0];

async function newTabStrip(mode: AgentMode): Promise<string[]> {
	const session = seed(mode);
	if (mode !== 'hosted') {
		const created = createTab(session)!;
		return strip(created.session, created.tab.id);
	}
	hydrateHost(TABS);
	act$.mockResolvedValue({ ok: true, result: { kind: 'new-tab', tabId: 't-new' } });
	await act(async () => {
		await openHostedTab(session);
	});
	return strip(current(), 't-new');
}

/** Cmd+W, as `performTabClose()` does it: the close, then the entry Cmd+Shift+T reopens. */
function closeAsTheTabDoes(session: Session, tabId: string): Session {
	const tab = session.aiTabs.find((candidate) => candidate.id === tabId)!;
	const unifiedIndex = session.unifiedTabOrder.findIndex((ref) => ref.id === tabId);
	return addAiTabToUnifiedHistory(closeTab(session, tabId, false)!.session, tab, unifiedIndex);
}

async function reopenStrip(mode: AgentMode): Promise<string[]> {
	const closed = closeAsTheTabDoes(seed(mode), 't2');
	useSessionStore.setState({ sessions: [closed], activeSessionId: closed.id });
	if (mode !== 'hosted') {
		const reopened = reopenUnifiedClosedTab(closed)!.session;
		useSessionStore.setState({ sessions: [reopened] });
		return strip(reopened).map(byConversation);
	}
	hydrateHost(TABS);
	// The host's update lands first and draws the reopened tab at the end; the reopen moves it.
	act$.mockImplementation(async () => {
		useSessionStore.setState({
			sessions: [projectHostedSession(current(), { agent: hostAgent(TABS) })],
		});
		return { ok: true, result: { kind: 'reopen-tab', tabId: 't2' } };
	});
	await act(async () => {
		await reopenHostedClosedEntry(closed, closed.unifiedClosedTabHistory![0]);
	});
	return strip(current()).map(byConversation);
}

/** A local reopen mints a new id for the same conversation: name the slot by its session. */
function byConversation(id: string): string {
	const tab = useSessionStore
		.getState()
		.sessions[0]?.aiTabs.find((candidate) => candidate.id === id);
	return tab?.agentSessionId === 's-t2' || id === 't2' ? 't2' : id;
}

describe('the tab strip, in every mode', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSettingsStore.setState({ federationHostedAgents: true });
		act$.mockReset();
		maestro.federation = { act: act$ };
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it.each(['after-current', 'end'] as const)(
		'puts a new tab where a local new tab goes (%s)',
		async (placement) => {
			useSettingsStore.setState({ newTabPlacement: placement });
			const strips = [];
			for (const mode of AGENT_MODES) strips.push(await newTabStrip(mode));
			const expected =
				placement === 'after-current'
					? ['t1', 'NEW', 't2', 't3', 'term']
					: ['t1', 't2', 't3', 'term', 'NEW'];
			expect(strips).toEqual([expected, expected, expected]);
		}
	);

	it('reopens a closed tab in its old slot', async () => {
		const strips = [];
		for (const mode of AGENT_MODES) strips.push(await reopenStrip(mode));
		const expected = ['t1', 't2', 't3', 'term'];
		expect(strips).toEqual([expected, expected, expected]);
	});

	it('keeps the order the user dragged through the host sync', () => {
		const strips = AGENT_MODES.map((mode) => {
			const dragged = moveUnifiedTabToTarget(seed(mode), 't3', 't1');
			return strip(
				mode === 'hosted' ? projectHostedSession(dragged, { agent: hostAgent(TABS) }) : dragged
			);
		});
		expect(strips[0]).toEqual(['t3', 't1', 't2', 'term']);
		expect(strips).toEqual([strips[0], strips[0], strips[0]]);
	});
});
