/**
 * Tests for PeerMirrorSection, the Left Bar's Federation peer groups: one group per mirrored peer
 * with its connection dot, its agents with a peer marker, selection that stays out of
 * `sessionStore`, collapse, and the two-item right-click menu.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../renderer/services/peerMirror', () => ({
	copyPeerAgentRef: vi.fn(async () => undefined),
	reconnectPeer: vi.fn(async () => undefined),
}));

import { PeerMirrorSection } from '../../../../renderer/components/SessionList/PeerMirrorSection';
import { copyPeerAgentRef, reconnectPeer } from '../../../../renderer/services/peerMirror';
import { usePeerMirrorStore } from '../../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { getStatusColor } from '../../../../renderer/utils/theme';
import {
	createMirroredPeer,
	replacePeerAgents,
	type MirroredPeer,
	type PeerMirrorConnection,
} from '../../../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../../../shared/maestro-lib/store/records';
import { createMockSession, resetStores } from '../../../helpers';
import { mockTheme } from '../../../helpers/mockTheme';

const agent = (id: string, overrides: Partial<AgentRecord> = {}): AgentRecord => ({
	id,
	name: `Agent ${id}`,
	toolType: 'claude-code',
	aiTabs: [{ id: 't1' }],
	...overrides,
});

function peerWith(
	peerId: string,
	agents: AgentRecord[],
	connection: PeerMirrorConnection = 'connected',
	error?: string
): MirroredPeer {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId, remoteId: `r-${peerId}`, name: `Peer ${peerId}` }),
		agents,
		[],
		1
	);
	return { ...peer, connection, ...(error ? { error } : {}) };
}

const renderSection = () => render(<PeerMirrorSection theme={mockTheme} />);
const groups = () => screen.queryAllByTestId('peer-mirror-group');
const rgb = (color: string) => {
	const probe = document.createElement('span');
	probe.style.backgroundColor = color;
	return probe.style.backgroundColor;
};

describe('PeerMirrorSection', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore, useSettingsStore);
		vi.mocked(copyPeerAgentRef).mockClear();
		vi.mocked(reconnectPeer).mockClear();
	});

	it('renders nothing while the mirror is off', () => {
		const { container } = renderSection();
		expect(container).toBeEmptyDOMElement();
	});

	it('renders nothing while on with no mirrored peer', () => {
		usePeerMirrorStore.getState().hydrate([]);
		const { container } = renderSection();
		expect(container).toBeEmptyDOMElement();
	});

	it('draws one group per peer, in stored order, with its agents and a peer marker', () => {
		usePeerMirrorStore
			.getState()
			.hydrate([peerWith('build', [agent('a1'), agent('a2')]), peerWith('gpu', [agent('b1')])]);
		renderSection();
		expect(groups().map((g) => g.getAttribute('data-peer-id'))).toEqual(['build', 'gpu']);
		const build = within(groups()[0]);
		expect(build.getByText('Peer build')).toBeInTheDocument();
		const rows = build.getAllByTestId('peer-mirror-agent-row');
		expect(rows.map((row) => row.getAttribute('title'))).toEqual(['build:a1', 'build:a2']);
		expect(within(rows[0]).getByText('Agent a1')).toBeInTheDocument();
		expect(within(rows[0]).getByText(/peer/i)).toBeInTheDocument();
	});

	it('shows the member count only when the Left Bar setting is on', () => {
		usePeerMirrorStore.getState().hydrate([peerWith('build', [agent('a1'), agent('a2')])]);
		useSettingsStore.setState({ showLeftPanelGroupMemberCount: false });
		const { unmount } = renderSection();
		expect(screen.queryByText('(2)')).not.toBeInTheDocument();
		unmount();
		useSettingsStore.setState({ showLeftPanelGroupMemberCount: true });
		renderSection();
		expect(screen.getByText('(2)')).toBeInTheDocument();
	});

	it.each([
		['connected', 'idle'],
		['connecting', 'connecting'],
		['reconnecting', 'connecting'],
		['lost', 'error'],
		['host-down', 'error'],
	] as const)('colors a %s peer dot like a %s agent', (connection, state) => {
		usePeerMirrorStore.getState().hydrate([peerWith('build', [agent('a1')], connection)]);
		renderSection();
		const dot = screen.getByTestId('peer-mirror-connection-dot');
		expect(dot).toHaveAttribute('data-connection', connection);
		expect(dot.style.backgroundColor).toBe(rgb(getStatusColor(state, mockTheme)));
	});

	it('dims the last known agents of a disconnected peer and says why in the tooltip', () => {
		usePeerMirrorStore
			.getState()
			.hydrate([peerWith('build', [agent('a1')], 'lost', 'socket closed')]);
		renderSection();
		const row = screen.getByTestId('peer-mirror-agent-row');
		expect(row.style.opacity).toBe('0.55');
		const header = within(groups()[0]).getAllByRole('button')[0];
		expect(header).toHaveAttribute('title', 'Disconnected: socket closed');
	});

	it('says so when a connected host has no agents, and shows the error of one that is down', () => {
		usePeerMirrorStore
			.getState()
			.hydrate([
				peerWith('empty', []),
				peerWith('down', [], 'host-down', 'Run maestro-cli remote-host start down'),
			]);
		renderSection();
		expect(screen.getByText('No agents on this host')).toBeInTheDocument();
		expect(screen.getByText('Run maestro-cli remote-host start down')).toBeInTheDocument();
	});

	it('selects a mirrored agent in peerMirrorStore and leaves sessionStore alone', () => {
		const local = createMockSession({ id: 'local-1' });
		useSessionStore.setState({ sessions: [local], activeSessionId: 'local-1' });
		usePeerMirrorStore.getState().hydrate([peerWith('build', [agent('a1'), agent('a2')])]);
		renderSection();
		fireEvent.click(screen.getAllByTestId('peer-mirror-agent-row')[1]);

		expect(usePeerMirrorStore.getState().activeMirror).toMatchObject({
			key: 'build:a2',
			peerId: 'build',
			agentId: 'a2',
		});
		const rows = screen.getAllByTestId('peer-mirror-agent-row');
		expect(rows[1]).toHaveAttribute('aria-current', 'true');
		expect(rows[0]).not.toHaveAttribute('aria-current');

		const sessions = useSessionStore.getState();
		expect(sessions.sessions).toEqual([local]);
		expect(sessions.activeSessionId).toBe('local-1');
		expect(sessions.sessions.some((s) => s.id.includes('build'))).toBe(false);
	});

	it('collapses and expands a peer group from its header', () => {
		usePeerMirrorStore.getState().hydrate([peerWith('build', [agent('a1')])]);
		renderSection();
		const header = within(groups()[0]).getAllByRole('button')[0];
		expect(header).toHaveAttribute('aria-expanded', 'true');
		fireEvent.click(header);
		expect(usePeerMirrorStore.getState().collapsedPeerIds).toEqual({ build: true });
		expect(screen.queryByTestId('peer-mirror-agent-row')).not.toBeInTheDocument();
		fireEvent.click(within(groups()[0]).getAllByRole('button')[0]);
		expect(screen.getByTestId('peer-mirror-agent-row')).toBeInTheDocument();
	});

	it('opens the mirror menu on an agent: Copy peer:agent and Reconnect, nothing local', () => {
		usePeerMirrorStore.getState().hydrate([peerWith('build', [agent('a1')])]);
		renderSection();
		fireEvent.contextMenu(screen.getByTestId('peer-mirror-agent-row'), {
			clientX: 10,
			clientY: 20,
		});
		const menu = screen.getByTestId('peer-mirror-menu');
		expect(
			within(menu)
				.getAllByRole('button')
				.map((b) => b.textContent)
		).toEqual(['Copy build:a1', 'Reconnect build']);

		fireEvent.click(within(menu).getByText('Copy build:a1'));
		expect(copyPeerAgentRef).toHaveBeenCalledWith('build', 'a1');
		expect(screen.queryByTestId('peer-mirror-menu')).not.toBeInTheDocument();
	});

	it('opens a Reconnect-only menu on a peer header, and Escape closes it', () => {
		usePeerMirrorStore.getState().hydrate([peerWith('build', [agent('a1')])]);
		renderSection();
		fireEvent.contextMenu(within(groups()[0]).getAllByRole('button')[0]);
		const menu = screen.getByTestId('peer-mirror-menu');
		expect(within(menu).getAllByRole('button')).toHaveLength(1);
		fireEvent.click(within(menu).getByText('Reconnect build'));
		expect(reconnectPeer).toHaveBeenCalledWith('build');

		fireEvent.contextMenu(within(groups()[0]).getAllByRole('button')[0]);
		expect(screen.getByTestId('peer-mirror-menu')).toBeInTheDocument();
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(screen.queryByTestId('peer-mirror-menu')).not.toBeInTheDocument();
	});

	it('drops a peer from the Left Bar when the mirror resets', () => {
		usePeerMirrorStore.getState().hydrate([peerWith('build', [agent('a1')])]);
		const { container, rerender } = renderSection();
		expect(groups()).toHaveLength(1);
		usePeerMirrorStore.getState().reset();
		rerender(<PeerMirrorSection theme={mockTheme} />);
		expect(container).toBeEmptyDOMElement();
	});
});
