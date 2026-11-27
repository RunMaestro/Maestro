/**
 * Tests for `services/tabStar.ts`: every control that stars a tab (the tab strip's star, the toggle
 * shortcut, `maestro-cli tab star`) writes the tab and the provider session the same way in every
 * mode, and a hosted agent's host gets the star too, so the next sync does not unstar the tab. A tab
 * with no conversation yet is refused with one reason in every mode (ninth live pass, L40).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTabStarred } from '../../../renderer/services/tabStar';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import { resetStores } from '../../helpers';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();
const providerStar = () =>
	(window.maestro.claude.updateSessionStarred as ReturnType<typeof vi.fn>).mock.calls;

/** The host of the hosted mode (`agentModeFields('hosted')` points at peer 'box', agent 'h1'). */
function hydrateHost() {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[{ id: 'h1', name: 'Docs', toolType: 'claude-code', aiTabs: [{ id: 't1' }] }],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

function seed(mode: AgentMode, agentSessionId: string | null = 'sess-1') {
	const session = createModeSession(mode, {
		id: 'row',
		projectRoot: '/proj',
		activeTabId: 't1',
		aiTabs: [createMockAITab({ id: 't1', agentSessionId, starred: false })],
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	return session;
}

const tab = () => useSessionStore.getState().sessions[0].aiTabs[0];
const hostCalls = () => act$.mock.calls.map((call) => call[2]);

describe('tabStar', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSettingsStore.setState({ federationHostedAgents: true });
		act$.mockReset();
		act$.mockResolvedValue({ ok: true, result: { kind: 'star-tab', tabId: 't1' } });
		maestro.federation = { act: act$ };
		(window.maestro.claude.updateSessionStarred as ReturnType<typeof vi.fn>).mockClear();
		hydrateHost();
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it('stars the tab the same way in every mode, and only a hosted agent tells its host (mode parity)', () => {
		// Sixth live pass: `maestro-cli tab star` and the toggle shortcut starred a hosted tab here
		// only, and the next sync drew it unstarred again; the tab strip's star already told the host.
		const outcomes = AGENT_MODES.map((mode) => {
			act$.mockClear();
			(window.maestro.claude.updateSessionStarred as ReturnType<typeof vi.fn>).mockClear();
			seed(mode);
			const result = setTabStarred('row', 't1', true);
			return { result, starred: tab().starred, provider: providerStar(), host: hostCalls() };
		});
		expect(outcomes.map(({ result, starred }) => [result, starred])).toEqual([
			[{ success: true }, true],
			[{ success: true }, true],
			[{ success: true }, true],
		]);
		for (const { provider } of outcomes) expect(provider).toEqual([['/proj', 'sess-1', true]]);
		expect(outcomes[0].host).toEqual([]);
		expect(outcomes[1].host).toEqual([]);
		expect(outcomes[2].host).toEqual([{ kind: 'star-tab', tabId: 't1', starred: true }]);
	});

	it('unstars a hosted tab on its host too', () => {
		seed('hosted');
		setTabStarred('row', 't1', true);
		setTabStarred('row', 't1', false);
		expect(tab().starred).toBe(false);
		expect(hostCalls()).toEqual([
			{ kind: 'star-tab', tabId: 't1', starred: true },
			{ kind: 'star-tab', tabId: 't1', starred: false },
		]);
	});

	it('refuses to star a tab with no conversation yet with one reason in every mode, and writes nothing (mode parity, L40)', () => {
		// Eighth live pass: `maestro-cli tab star` on a sessionless hosted tab answered "Starred"
		// and changed nothing, while a local tab answered "Tab not found". The tab strip offers no
		// star for such a tab; every other path now refuses it the same way.
		const outcomes = AGENT_MODES.map((mode) => {
			act$.mockClear();
			(window.maestro.claude.updateSessionStarred as ReturnType<typeof vi.fn>).mockClear();
			seed(mode, null);
			const result = setTabStarred('row', 't1', true);
			return { result, starred: tab().starred, provider: providerStar(), host: hostCalls() };
		});
		for (const outcome of outcomes) {
			expect(outcome).toEqual({
				result: {
					success: false,
					error: 'This tab has no conversation yet, so it cannot be starred',
				},
				starred: false,
				provider: [],
				host: [],
			});
		}
	});

	it.each(AGENT_MODES)('%s: unstarring a tab with no conversation yet is allowed', (mode) => {
		seed(mode, null);
		expect(setTabStarred('row', 't1', false)).toEqual({ success: true });
		expect(tab().starred).toBe(false);
	});

	it('leaves a tab that is not there alone and tells no host', () => {
		seed('hosted');
		expect(setTabStarred('row', 'missing', true)).toEqual({
			success: false,
			error: 'Tab not found: missing',
		});
		expect(tab().starred).toBe(false);
		expect(act$).not.toHaveBeenCalled();
		expect(providerStar()).toEqual([]);
	});
});
