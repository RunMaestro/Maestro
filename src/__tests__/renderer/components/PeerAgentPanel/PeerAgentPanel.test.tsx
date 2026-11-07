/**
 * Tests for PeerAgentPanel, the Main Window for a mirrored Federation agent (read-only): the lazy
 * transcript read, its loading and error states, the read-only TabBar and TerminalOutput it
 * composes, the disconnected banner, and the absence of any composer.
 *
 * `TabBar` and `TerminalOutput` are stood in for by stubs that record their props: their own
 * suites cover rendering, and what matters here is that the mirror hands them read-only views.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tabBarProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const terminalProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('../../../../renderer/components/TabBar', () => ({
	TabBar: (props: Record<string, unknown>) => {
		tabBarProps.current = props;
		return <div data-testid="tab-bar-stub" />;
	},
}));
vi.mock('../../../../renderer/components/TerminalOutput', () => ({
	TerminalOutput: (props: Record<string, unknown>) => {
		terminalProps.current = props;
		return <div data-testid="terminal-output-stub" />;
	},
}));
vi.mock('../../../../renderer/services/peerMirror', () => ({
	readMirrorTranscript: vi.fn(async () => undefined),
	reconnectPeer: vi.fn(async () => undefined),
	copyPeerAgentRef: vi.fn(async () => undefined),
}));

import { PeerAgentPanel } from '../../../../renderer/components/PeerAgentPanel';
import {
	copyPeerAgentRef,
	readMirrorTranscript,
	reconnectPeer,
} from '../../../../renderer/services/peerMirror';
import { usePeerMirrorStore } from '../../../../renderer/stores/peerMirrorStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import {
	createMirroredPeer,
	replacePeerAgents,
	type MirroredPeer,
	type PeerMirrorConnection,
} from '../../../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../../../shared/maestro-lib/store/records';
import type { LogEntryRecord } from '../../../../shared/maestro-lib/store/transcript';
import { resetStores } from '../../../helpers';
import { mockTheme } from '../../../helpers/mockTheme';

const agent = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
	id: 'a1',
	name: 'Builder',
	toolType: 'claude-code',
	aiTabs: [
		{ id: 't1', name: 'First' },
		{ id: 't2', name: 'Second' },
	],
	...overrides,
});

function peerWith(
	agents: AgentRecord[],
	connection: PeerMirrorConnection = 'connected',
	error?: string
): MirroredPeer {
	const { peer } = replacePeerAgents(
		createMirroredPeer({ peerId: 'build', remoteId: 'r-build', name: 'Build Box' }),
		agents,
		[],
		1
	);
	return { ...peer, connection, ...(error ? { error } : {}) };
}

const ENTRIES = [
	{ id: 'e1', timestamp: 1, source: 'user', text: 'hello' },
	{ id: 'e2', timestamp: 2, source: 'ai', text: 'hi there' },
] as LogEntryRecord[];

function show(peer: MirroredPeer = peerWith([agent()])) {
	const store = usePeerMirrorStore.getState();
	store.hydrate([peer]);
	store.selectMirroredAgent('build', 'a1');
}

const renderPanel = () => render(<PeerAgentPanel theme={mockTheme} setLightboxImage={vi.fn()} />);

/** Land a transcript read the way `readMirrorTranscript` would. */
function landRead(tabId: string, entries: LogEntryRecord[] = ENTRIES) {
	act(() => {
		const store = usePeerMirrorStore.getState();
		const version = store.beginTranscriptRead('build', 'a1', tabId);
		usePeerMirrorStore.getState().finishTranscriptRead('build', 'a1', tabId, entries, version);
	});
}

describe('PeerAgentPanel', () => {
	beforeEach(() => {
		resetStores(usePeerMirrorStore, useSessionStore);
		tabBarProps.current = null;
		terminalProps.current = null;
		vi.mocked(readMirrorTranscript).mockClear();
		vi.mocked(reconnectPeer).mockClear();
		vi.mocked(copyPeerAgentRef).mockClear();
	});

	it('renders nothing with no mirror selected', () => {
		usePeerMirrorStore.getState().hydrate([peerWith([agent()])]);
		const { container } = renderPanel();
		expect(container).toBeEmptyDOMElement();
	});

	it('reads the shown tab lazily and shows a skeleton until it lands', () => {
		show();
		renderPanel();
		expect(readMirrorTranscript).toHaveBeenCalledTimes(1);
		expect(readMirrorTranscript).toHaveBeenCalledWith('build', 'a1', 't1');
		expect(screen.getByTestId('peer-agent-panel-loading')).toBeInTheDocument();
		expect(screen.queryByTestId('terminal-output-stub')).not.toBeInTheDocument();
	});

	it('hands TerminalOutput a read-only view of the transcript, never a Session', () => {
		show();
		renderPanel();
		landRead('t1');
		expect(screen.getByTestId('terminal-output-stub')).toBeInTheDocument();
		expect(terminalProps.current?.readOnly).toBe(true);
		const view = terminalProps.current?.session as {
			id: string;
			projectRoot?: string;
			aiTabs: Array<{ id: string; logs: Array<{ id: string }> }>;
		};
		expect(view.projectRoot).toBeUndefined();
		const shown = view.aiTabs.find((tab) => tab.id === 't1');
		expect(shown?.logs.map((log) => log.id)).toEqual(['e1', 'e2']);
		// No second read once the tab is loaded and not stale.
		expect(readMirrorTranscript).toHaveBeenCalledTimes(1);
		expect(useSessionStore.getState().sessions).toEqual([]);
	});

	it('shows a read-only TabBar and switches tabs in peerMirrorStore only', () => {
		show();
		renderPanel();
		expect(tabBarProps.current?.readOnly).toBe(true);
		expect(tabBarProps.current?.activeTabId).toBe('t1');
		const select = tabBarProps.current?.onTabSelect as (tabId: string) => void;
		act(() => select('t2'));
		expect(usePeerMirrorStore.getState().activeTabIds).toEqual({ build: { a1: 't2' } });
		expect(readMirrorTranscript).toHaveBeenLastCalledWith('build', 'a1', 't2');
		// The required close and new-tab callbacks are inert.
		(tabBarProps.current?.onTabClose as (id: string) => void)('t1');
		(tabBarProps.current?.onNewTab as () => void)();
		expect(usePeerMirrorStore.getState().peers.build.agents[0].aiTabs).toHaveLength(2);
	});

	it('reads again when the host marks the shown tab stale', () => {
		show();
		renderPanel();
		landRead('t1');
		expect(readMirrorTranscript).toHaveBeenCalledTimes(1);
		act(() =>
			usePeerMirrorStore
				.getState()
				.applyPush({ peerId: 'build', event: { type: 'tab.stale', agentId: 'a1', tabId: 't1' } })
		);
		expect(readMirrorTranscript).toHaveBeenCalledTimes(2);
	});

	it('shows a failed read with Retry, and does not poll a host that is down', () => {
		show();
		renderPanel();
		act(() => {
			usePeerMirrorStore.getState().beginTranscriptRead('build', 'a1', 't1');
			usePeerMirrorStore.getState().failTranscriptRead('build', 'a1', 't1', 'Host is not running');
		});
		expect(screen.getByTestId('peer-agent-panel-read-error')).toHaveTextContent(
			'Host is not running'
		);
		expect(readMirrorTranscript).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByText('Retry'));
		expect(readMirrorTranscript).toHaveBeenCalledTimes(2);
	});

	it('keeps the last known state of a disconnected peer, with a Reconnect banner', () => {
		show(peerWith([agent()], 'lost', 'socket closed'));
		renderPanel();
		const banner = screen.getByTestId('peer-agent-panel-disconnected');
		expect(banner).toHaveTextContent('Disconnected from Build Box');
		expect(banner).toHaveTextContent('socket closed');
		fireEvent.click(screen.getByText('Reconnect'));
		expect(reconnectPeer).toHaveBeenCalledWith('build');
	});

	it('marks the agent as a peer, copies its address, and has no composer', () => {
		show();
		const { container } = renderPanel();
		expect(screen.getByTestId('peer-agent-panel-badge')).toBeInTheDocument();
		expect(screen.getByText('build:a1')).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText('Copy build:a1'));
		expect(copyPeerAgentRef).toHaveBeenCalledWith('build', 'a1');
		expect(screen.getByTestId('peer-agent-panel-readonly-footer')).toHaveTextContent('Read-only');
		expect(container.querySelector('textarea')).toBeNull();
	});

	it('says so when the agent has no open tab, and reads nothing', () => {
		show(peerWith([agent({ aiTabs: [] })]));
		renderPanel();
		expect(screen.getByText('This agent has no open tabs on Build Box.')).toBeInTheDocument();
		expect(readMirrorTranscript).not.toHaveBeenCalled();
		expect(tabBarProps.current).toBeNull();
	});

	it('goes away when the mirrored agent is removed on the host', () => {
		show();
		const { container } = renderPanel();
		act(() =>
			usePeerMirrorStore
				.getState()
				.applyPush({ peerId: 'build', event: { type: 'agent.removed', agentId: 'a1' } })
		);
		expect(container).toBeEmptyDOMElement();
	});
});
