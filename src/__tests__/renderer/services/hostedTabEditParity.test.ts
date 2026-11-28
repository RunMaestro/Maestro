/**
 * L36: a tab's new name (the auto-name) or star is one write of the agent's record in every mode.
 * In the running app a hosted tab's auto-name was drawn three times, `name -> null -> name`: the
 * host sync drew the host's older name until the host's update carried the new one, a blink and
 * two extra commits of the whole window per turn. The edit is now drawn until the host reports it,
 * refuses it, or `HOST_TAB_EDIT_ECHO_MS` after the host took it.
 */

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHostedAgentSync } from '../../../renderer/services/hostedAgentSync';
import {
	HOST_TAB_EDIT_ECHO_MS,
	pruneHostedTabBooks,
	renameHostedTab,
	renameHostedTabSettled,
	starHostedTab,
} from '../../../renderer/services/hostedTurns';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { updateAiTab, useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import type { AITabRecord, AgentRecord } from '../../../shared/maestro-lib/store/records';
import { AGENT_MODES, createModeSession, resetStores } from '../../helpers';
import { createMockAITab } from '../../helpers/mockTab';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(),
}));

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();

const hostAgent = (tab: AITabRecord): AgentRecord => ({
	id: 'h1',
	name: 'Docs',
	toolType: 'claude-code',
	activeTabId: 't1',
	aiTabs: [{ agentSessionId: 's1', state: 'idle', ...tab }],
});

function hydrateHost(tab: AITabRecord = { id: 't1', name: 'Main' }) {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[hostAgent(tab)],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

/** The host's update after it took the edit. */
const hostReports = (tab: AITabRecord) =>
	usePeerMirrorStore
		.getState()
		.applyPush({ peerId: 'box', event: { type: 'agent.updated', agent: hostAgent(tab) } });

const flush = () => act(async () => undefined);
const tabOf = () => useSessionStore.getState().sessions[0].aiTabs[0];

describe('a tab edited here is drawn once in every mode (L36)', () => {
	let stop: () => void = () => {};
	let names: Array<string | null | undefined>;
	let stars: Array<boolean | undefined>;
	let writes: number;
	let unsubscribe: () => void = () => {};

	async function setUp(mode: (typeof AGENT_MODES)[number]) {
		hydrateHost();
		useSessionStore.setState({
			sessions: [
				createModeSession(mode, {
					id: 'row',
					activeTabId: 't1',
					aiTabs: [createMockAITab({ id: 't1', name: 'Main', logs: [] })],
					state: 'idle',
				}),
			],
			activeSessionId: 'row',
		});
		stop = startHostedAgentSync();
		await flush();
		writes = 0;
		names = [];
		stars = [];
		unsubscribe = useSessionStore.subscribe((state, prev) => {
			if (state.sessions === prev.sessions) return;
			writes++;
			names.push(state.sessions[0].aiTabs[0].name);
			stars.push(state.sessions[0].aiTabs[0].starred);
		});
	}

	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		pruneHostedTabBooks([]);
		useSettingsStore.setState({ federationHostedAgents: true });
		act$.mockReset();
		act$.mockResolvedValue({ ok: true, result: { kind: 'rename-tab', tabId: 't1' } });
		maestro.federation = { act: act$, transcript: vi.fn().mockResolvedValue([]) };
	});

	afterEach(() => {
		unsubscribe();
		stop();
		pruneHostedTabBooks([]);
		vi.useRealTimers();
		delete maestro.federation;
	});

	it.each(AGENT_MODES)('%s: the auto-name is one write, never drawn back', async (mode) => {
		await setUp(mode);
		// What `requestTabAutoName()` does with a generated name.
		updateAiTab('row', 't1', (tab) => ({ ...tab, name: 'Named' }));
		renameHostedTab(useSessionStore.getState().sessions[0], 't1', 'Named');
		await flush();
		hostReports({ id: 't1', name: 'Named' });
		await flush();
		expect(names).toEqual(['Named']);
		expect(writes).toBe(1);
		expect(tabOf().name).toBe('Named');
	});

	it.each(AGENT_MODES)('%s: a star is one write, never drawn back', async (mode) => {
		await setUp(mode);
		updateAiTab('row', 't1', (tab) => ({ ...tab, starred: true }));
		starHostedTab(useSessionStore.getState().sessions[0], 't1', true);
		await flush();
		hostReports({ id: 't1', name: 'Main', starred: true });
		await flush();
		expect(stars).toEqual([true]);
		expect(writes).toBe(1);
	});

	it("draws the host's name again once it refuses the rename", async () => {
		await setUp('hosted');
		act$.mockResolvedValue({ ok: false, error: 'The tab is gone.' });
		updateAiTab('row', 't1', (tab) => ({ ...tab, name: 'Named' }));
		renameHostedTab(useSessionStore.getState().sessions[0], 't1', 'Named');
		await flush();
		await flush();
		expect(tabOf().name).toBe('Main');
	});

	it("draws the host's name again when it took the rename but never reports it", async () => {
		vi.useFakeTimers();
		await setUp('hosted');
		updateAiTab('row', 't1', (tab) => ({ ...tab, name: 'Named' }));
		renameHostedTab(useSessionStore.getState().sessions[0], 't1', 'Named');
		await flush();
		expect(tabOf().name).toBe('Named');
		await act(async () => {
			await vi.advanceTimersByTimeAsync(HOST_TAB_EDIT_ECHO_MS + 1);
		});
		expect(tabOf().name).toBe('Main');
	});

	it('keeps a star toggled back before the host reports either change (Greptile and CodeRabbit on #2179)', async () => {
		await setUp('hosted');
		const answers: Array<(value: unknown) => void> = [];
		act$.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
		const session = useSessionStore.getState().sessions[0];
		updateAiTab('row', 't1', (tab) => ({ ...tab, starred: true }));
		starHostedTab(session, 't1', true);
		updateAiTab('row', 't1', (tab) => ({ ...tab, starred: false }));
		starHostedTab(session, 't1', false);
		await flush();
		// The host's report of the first star lands before the second change reaches it.
		hostReports({ id: 't1', name: 'Main', starred: true });
		await flush();
		for (const answer of answers) answer({ ok: true, result: { kind: 'star-tab', tabId: 't1' } });
		await flush();
		hostReports({ id: 't1', name: 'Main', starred: false });
		await flush();
		expect(stars).toEqual([true, false]);
		expect(tabOf().starred).toBe(false);
	});

	it('keeps a rename when an earlier rename to the same name ends its wait (CodeRabbit on #2179)', async () => {
		vi.useFakeTimers();
		await setUp('hosted');
		const rename = async (name: string) => {
			updateAiTab('row', 't1', (tab) => ({ ...tab, name }));
			renameHostedTab(useSessionStore.getState().sessions[0], 't1', name);
			await flush();
		};
		const wait = (ms: number) =>
			act(async () => {
				await vi.advanceTimersByTimeAsync(ms);
			});
		await rename('A');
		await wait(HOST_TAB_EDIT_ECHO_MS / 2);
		await rename('B');
		await wait(HOST_TAB_EDIT_ECHO_MS / 4);
		await rename('A');
		// The first rename's wait ends; the third is still on its way.
		await wait(HOST_TAB_EDIT_ECHO_MS / 4 + 1);
		expect(tabOf().name).toBe('A');
		expect(names).not.toContain('Main');
	});

	it('draws a name saved in Rename Tab over an auto-name still waiting for its report (Greptile on #2179)', async () => {
		await setUp('hosted');
		updateAiTab('row', 't1', (tab) => ({ ...tab, name: 'Auto' }));
		renameHostedTab(useSessionStore.getState().sessions[0], 't1', 'Auto');
		await flush();
		// What the Rename Tab modal does: the host first, then the name here.
		const saved = await renameHostedTabSettled(
			useSessionStore.getState().sessions[0],
			't1',
			'Mine'
		);
		expect(saved).toEqual({ saved: true });
		updateAiTab('row', 't1', (tab) => ({ ...tab, name: 'Mine' }));
		await flush();
		hostReports({ id: 't1', name: 'Mine' });
		await flush();
		expect(tabOf().name).toBe('Mine');
		expect(names).toEqual(['Auto', 'Mine']);
	});

	it('keeps a later edit when an earlier one settles', async () => {
		vi.useFakeTimers();
		await setUp('hosted');
		updateAiTab('row', 't1', (tab) => ({ ...tab, name: 'First' }));
		renameHostedTab(useSessionStore.getState().sessions[0], 't1', 'First');
		await act(async () => {
			await vi.advanceTimersByTimeAsync(HOST_TAB_EDIT_ECHO_MS / 2);
		});
		updateAiTab('row', 't1', (tab) => ({ ...tab, name: 'Second' }));
		renameHostedTab(useSessionStore.getState().sessions[0], 't1', 'Second');
		// The first rename's wait ends: the second is still on its way and stays drawn.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(HOST_TAB_EDIT_ECHO_MS / 2 + 1);
		});
		expect(tabOf().name).toBe('Second');
		hostReports({ id: 't1', name: 'Second' });
		await flush();
		expect(tabOf().name).toBe('Second');
	});
});
