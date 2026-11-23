/**
 * Tests for `services/hostedAgentSync.ts`: every hosted agent's Left Bar record follows its host,
 * the tab on screen is read lazily, and a record that already matches is left alone.
 */

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHostedAgentSync, syncHostedAgents } from '../../../renderer/services/hostedAgentSync';
import { usePeerMirrorStore } from '../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import {
	createMirroredPeer,
	replacePeerAgents,
} from '../../../shared/maestro-lib/client/peer-mirror';
import { resetStores } from '../../helpers';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

const maestro = window.maestro as unknown as Record<string, unknown>;
const transcript = vi.fn();

function hydrateHost(state: 'idle' | 'busy' = 'busy') {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'box', remoteId: 'r1', name: 'Box' }),
		[
			{
				id: 'h1',
				name: 'Docs',
				toolType: 'claude-code',
				activeTabId: 't1',
				aiTabs: [{ id: 't1', name: 'Main', agentSessionId: 's1', state }],
			},
		],
		[],
		1
	);
	usePeerMirrorStore.getState().hydrate([{ ...peer, connection: 'connected' }]);
}

const row = () =>
	createMockSession({
		id: 'row',
		liftedTo: { peer: 'box', agentId: 'h1', at: 1 },
		activeTabId: 't1',
		aiTabs: [createMockAITab({ id: 't1', logs: [] })],
		state: 'idle',
	});

const flush = () => act(async () => undefined);

describe('hostedAgentSync', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		useSettingsStore.setState({ federationHostedAgents: true });
		transcript.mockReset();
		transcript.mockResolvedValue([{ id: 'e1', timestamp: 1, source: 'ai', text: 'from the host' }]);
		maestro.federation = { transcript };
	});

	afterEach(() => {
		delete maestro.federation;
	});

	it('folds the host tab into the record and reads the tab on screen', async () => {
		useSessionStore.setState({ sessions: [row()], activeSessionId: 'row' });
		hydrateHost('busy');
		syncHostedAgents();
		const synced = useSessionStore.getState().sessions[0];
		expect(synced.aiTabs[0]).toMatchObject({ name: 'Main', state: 'busy' });
		expect(synced.state).toBe('busy');
		expect(transcript).toHaveBeenCalledWith('box', 'h1', 't1', expect.any(Object));
		await flush();
		syncHostedAgents();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].logs.map((e) => e.text)).toEqual([
			'from the host',
		]);
	});

	it('does not read a tab nobody looks at', () => {
		useSessionStore.setState({ sessions: [row()], activeSessionId: 'someone-else' });
		hydrateHost();
		syncHostedAgents();
		expect(transcript).not.toHaveBeenCalled();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].state).toBe('busy');
	});

	it('leaves local agents and a record that already matches untouched', () => {
		const localAgent = createMockSession({ id: 'local' });
		useSessionStore.setState({ sessions: [row(), localAgent], activeSessionId: 'local' });
		hydrateHost('idle');
		syncHostedAgents();
		const once = useSessionStore.getState().sessions;
		syncHostedAgents();
		expect(useSessionStore.getState().sessions).toBe(once);
		expect(once[1]).toBe(localAgent);
	});

	it('follows the mirror once started, and stops following when stopped', async () => {
		useSessionStore.setState({ sessions: [row()], activeSessionId: 'other' });
		const stop = startHostedAgentSync();
		act(() => hydrateHost('busy'));
		await flush();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].state).toBe('busy');
		stop();
		act(() => hydrateHost('idle'));
		await flush();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].state).toBe('busy');
	});

	it('with hosted agents off, folds nothing in and releases each record once', () => {
		useSessionStore.setState({ sessions: [row()], activeSessionId: 'row' });
		hydrateHost('busy');
		syncHostedAgents();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].state).toBe('busy');

		useSettingsStore.setState({ federationHostedAgents: false });
		syncHostedAgents();
		const released = useSessionStore.getState().sessions[0];
		expect(released.aiTabs[0].state).toBe('idle');
		expect(released.state).toBe('idle');
		expect(transcript).toHaveBeenCalledTimes(1);

		// A local SSH turn that starts afterwards is never idled by a later pass.
		useSessionStore.setState({
			sessions: [{ ...released, state: 'busy', busySource: 'ai' }],
		});
		syncHostedAgents();
		expect(useSessionStore.getState().sessions[0].state).toBe('busy');

		// Back on: the host is folded in again.
		useSettingsStore.setState({ federationHostedAgents: true });
		syncHostedAgents();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].state).toBe('busy');
	});
});
