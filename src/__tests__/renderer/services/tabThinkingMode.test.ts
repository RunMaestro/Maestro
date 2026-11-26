/**
 * Tests for `services/tabThinkingMode.ts`: every control that changes a tab's thinking mode (the
 * composer's Thinking pill, its shortcut, the command palette, the prompt composer, the phone
 * sheet) writes the tab the same way in every mode, and a hosted agent's host gets the mode too,
 * so a sticky hosted tab keeps its thinking after the turn as a local one does.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	cycleTabThinkingMode,
	setTabThinkingMode,
} from '../../../renderer/services/tabThinkingMode';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useQuickActionsHandlers } from '../../../renderer/hooks/modal/useQuickActionsHandlers';
import { usePromptComposerHandlers } from '../../../renderer/hooks/modal/usePromptComposerHandlers';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import type { ThinkingMode } from '../../../shared/types';
import { resetStores } from '../../helpers';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

const maestro = window.maestro as unknown as Record<string, unknown>;
const act$ = vi.fn();

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

function seed(mode: AgentMode, showThinking: ThinkingMode = 'off') {
	const session = createModeSession(mode, {
		id: 'row',
		inputMode: 'ai',
		activeTabId: 't1',
		aiTabs: [
			createMockAITab({
				id: 't1',
				showThinking,
				logs: [
					{ id: 'l1', timestamp: 1, source: 'user', text: 'hi' },
					{ id: 'l2', timestamp: 2, source: 'thinking', text: 'reasoning' },
				],
			}),
		],
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	return session;
}

const tab = () => useSessionStore.getState().sessions[0].aiTabs[0];
const hostCalls = () => act$.mock.calls.map((call) => call[2]);

describe('tabThinkingMode', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSettingsStore.setState({ federationHostedAgents: true });
		act$.mockReset();
		act$.mockResolvedValue({ ok: true, result: { kind: 'update-tab', tabId: 't1' } });
		maestro.federation = { act: act$ };
		hydrateHost();
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it('sets a mode by name and drops stored reasoning when it goes off', () => {
		seed('local', 'on');
		setTabThinkingMode('row', 't1', 'sticky');
		expect(tab().showThinking).toBe('sticky');
		expect(tab().logs.map((log) => log.source)).toEqual(['user', 'thinking']);

		setTabThinkingMode('row', 't1', 'off');
		expect(tab().showThinking).toBe('off');
		expect(tab().logs.map((log) => log.source)).toEqual(['user']);
	});

	it('cycles off, on, sticky, off', () => {
		seed('local');
		const seen = [1, 2, 3].map(() => {
			cycleTabThinkingMode('row', 't1');
			return tab().showThinking;
		});
		expect(seen).toEqual(['on', 'sticky', 'off']);
	});

	it('leaves a tab that is not there alone and tells no host', () => {
		seed('hosted');
		setTabThinkingMode('row', 'gone', 'sticky');
		cycleTabThinkingMode('row', 'gone');
		cycleTabThinkingMode('nobody', 't1');
		expect(tab().showThinking).toBe('off');
		expect(act$).not.toHaveBeenCalled();
	});

	it('cycles the tab the same way in every mode, and only a hosted agent tells its host (mode parity)', () => {
		// docs/parity/agent-ux-parity.md: the Thinking pill, Cmd+Shift+K, the command palette and
		// the prompt composer each cycled the tab here only, so a hosted tab showed 'sticky' while
		// its host ran the turn with thinking off and dropped the reasoning at the end.
		const outcomes = AGENT_MODES.map((mode) => {
			act$.mockClear();
			seed(mode);
			cycleTabThinkingMode('row', 't1');
			cycleTabThinkingMode('row', 't1');
			return { mode, thinking: tab().showThinking, host: hostCalls() };
		});
		expect(outcomes.map(({ thinking }) => thinking)).toEqual(['sticky', 'sticky', 'sticky']);
		expect(outcomes[0].host).toEqual([]);
		expect(outcomes[1].host).toEqual([]);
		expect(outcomes[2].host).toEqual([
			{ kind: 'update-tab', tabId: 't1', patch: { thinking: 'on' } },
			{ kind: 'update-tab', tabId: 't1', patch: { thinking: 'sticky' } },
		]);
	});

	it('the command palette and the prompt composer toggles reach a hosted agent host', () => {
		seed('hosted');
		const quick = renderHook(() => useQuickActionsHandlers({} as never)).result.current;
		quick.handleQuickActionsToggleTabShowThinking();
		const composer = renderHook(() => usePromptComposerHandlers({} as never)).result.current;
		composer.handlePromptToggleTabShowThinking();

		expect(tab().showThinking).toBe('sticky');
		expect(hostCalls()).toEqual([
			{ kind: 'update-tab', tabId: 't1', patch: { thinking: 'on' } },
			{ kind: 'update-tab', tabId: 't1', patch: { thinking: 'sticky' } },
		]);
	});
});
