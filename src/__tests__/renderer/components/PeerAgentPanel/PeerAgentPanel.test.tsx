/**
 * Tests for PeerAgentPanel, the Main Window for a hosted (Federation) agent: the lazy transcript
 * read, its loading and error states, the header (Hosted badge, Memory Viewer and Agent Sessions),
 * the TabBar whose own controls (new tab, close, rename, star) act on the host, the read-only
 * TerminalOutput, the disconnected banner, and the composer (FED-SSH-06). Host actions go through
 * `services/peerMirror` and never touch `sessionStore`.
 *
 * `TabBar`, `TerminalOutput`, the composer, and the two viewers are stood in for by stubs that
 * record their props: their own suites cover rendering.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tabBarProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const terminalProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const historyPanelProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const composerProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const sessionsBrowserProps = vi.hoisted(() => ({
	current: null as Record<string, unknown> | null,
}));
const memoryViewerProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

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
vi.mock('../../../../renderer/components/PeerAgentPanel/PeerAgentComposer', () => ({
	PeerAgentComposer: (props: Record<string, unknown>) => {
		composerProps.current = props;
		return <div data-testid="peer-agent-composer" />;
	},
}));
vi.mock('../../../../renderer/components/AgentSessionsBrowser', () => ({
	AgentSessionsBrowser: (props: Record<string, unknown>) => {
		sessionsBrowserProps.current = props;
		return <div data-testid="agent-sessions-stub" />;
	},
}));
vi.mock('../../../../renderer/components/MemoryViewer', () => ({
	MemoryViewer: (props: Record<string, unknown>) => {
		memoryViewerProps.current = props;
		return <div data-testid="memory-viewer-stub" />;
	},
}));
vi.mock('../../../../renderer/services/agentLift', () => ({
	startPeerHost: vi.fn(async () => true),
}));
// The History panel has its own suite; here it records what the mirror's column hands it.
vi.mock('../../../../renderer/components/HistoryPanel', () => ({
	HistoryPanel: (props: Record<string, unknown>) => {
		historyPanelProps.current = props;
		return <div data-testid="history-panel-stub" />;
	},
}));
vi.mock('../../../../renderer/services/peerMirror', () => ({
	readMirrorTranscript: vi.fn(async () => undefined),
	reconnectPeer: vi.fn(async () => undefined),
	openMirrorTab: vi.fn(async () => undefined),
	closeMirrorTab: vi.fn(async () => undefined),
	renameMirrorTab: vi.fn(async () => undefined),
	starMirrorTab: vi.fn(async () => undefined),
	sendToMirroredTab: vi.fn(async () => true),
	interruptMirroredAgent: vi.fn(async () => undefined),
	removeMirrorQueuedItem: vi.fn(async () => undefined),
	setMirrorQueuedItemPaused: vi.fn(async () => undefined),
	openMirroredAgentByKey: vi.fn(() => false),
}));

import { PeerAgentPanel } from '../../../../renderer/components/PeerAgentPanel';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import {
	closeMirrorTab,
	openMirrorTab,
	readMirrorTranscript,
	reconnectPeer,
	removeMirrorQueuedItem,
	renameMirrorTab,
	setMirrorQueuedItemPaused,
	starMirrorTab,
} from '../../../../renderer/services/peerMirror';
import { startPeerHost } from '../../../../renderer/services/agentLift';
import { usePeerMirrorStore } from '../../../../renderer/stores/peerMirrorStore';
import { useModalStore } from '../../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../../renderer/stores/uiStore';
import type { HistorySource } from '../../../../renderer/components/History/historySource';
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

const renderPanel = () =>
	render(<PeerAgentPanel theme={mockTheme} setLightboxImage={vi.fn()} />, {
		wrapper: LayerStackProvider,
	});

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
		resetStores(usePeerMirrorStore, useSessionStore, useUIStore, useModalStore);
		tabBarProps.current = null;
		composerProps.current = null;
		sessionsBrowserProps.current = null;
		memoryViewerProps.current = null;
		terminalProps.current = null;
		historyPanelProps.current = null;
		vi.mocked(readMirrorTranscript).mockClear();
		vi.mocked(reconnectPeer).mockClear();
		vi.mocked(closeMirrorTab).mockClear();
		vi.mocked(startPeerHost).mockClear();
		vi.mocked(openMirrorTab).mockClear();
		vi.mocked(renameMirrorTab).mockClear();
		vi.mocked(starMirrorTab).mockClear();
		vi.mocked(removeMirrorQueuedItem).mockClear();
		vi.mocked(setMirrorQueuedItemPaused).mockClear();
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

	it('draws the host queue as queued cards whose remove and Hold / Resume act on the host', () => {
		const waiting = (itemId: string, paused: boolean) => ({
			itemId,
			tabId: 't1',
			queuedAt: 5,
			kind: 'message' as const,
			text: `waiting ${itemId}`,
			paused,
		});
		show({ ...peerWith([agent()]), queues: { a1: [waiting('q1', false), waiting('q2', true)] } });
		renderPanel();
		landRead('t1');
		const view = terminalProps.current?.session as {
			executionQueue: Array<{ id: string; paused?: boolean }>;
		};
		expect(view.executionQueue.map((item) => item.id)).toEqual(['q1', 'q2']);
		(terminalProps.current?.onRemoveQueuedItem as (id: string) => void)('q1');
		expect(removeMirrorQueuedItem).toHaveBeenCalledWith('build', 'a1', 'q1');
		const togglePause = terminalProps.current?.onTogglePauseQueuedItem as (id: string) => void;
		togglePause('q1');
		expect(setMirrorQueuedItemPaused).toHaveBeenLastCalledWith('build', 'a1', 'q1', true);
		togglePause('q2');
		expect(setMirrorQueuedItemPaused).toHaveBeenLastCalledWith('build', 'a1', 'q2', false);
		// A message that no longer waits is not acted on.
		togglePause('gone');
		expect(setMirrorQueuedItemPaused).toHaveBeenCalledTimes(2);
		expect(useSessionStore.getState().sessions).toEqual([]);
	});

	it('keeps the queue actions wired while the peer is disconnected, so a refusal is visible', () => {
		// The queued cards always draw Remove. Without a handler its confirm would close and do
		// nothing; with one, the action fails with the "not connected" toast.
		show(peerWith([agent()], 'lost', 'socket closed'));
		renderPanel();
		landRead('t1');
		expect(terminalProps.current).not.toBeNull();
		expect(terminalProps.current?.onRemoveQueuedItem).toBeTypeOf('function');
		expect(terminalProps.current?.onTogglePauseQueuedItem).toBeTypeOf('function');
	});

	it('draws the strip with its own controls and switches tabs in peerMirrorStore only', () => {
		show();
		renderPanel();
		expect(tabBarProps.current?.readOnly).toBeUndefined();
		expect(tabBarProps.current?.activeTabId).toBe('t1');
		const select = tabBarProps.current?.onTabSelect as (tabId: string) => void;
		act(() => select('t2'));
		expect(usePeerMirrorStore.getState().activeTabIds).toEqual({ build: { a1: 't2' } });
		expect(readMirrorTranscript).toHaveBeenLastCalledWith('build', 'a1', 't2');
		expect(useSessionStore.getState().sessions).toEqual([]);
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
		fireEvent.click(screen.getByTestId('peer-agent-panel-start-host'));
		expect(startPeerHost).toHaveBeenCalledWith('r-build', 'Build Box');
	});

	it("draws a local agent's header: the name and the Hosted badge, no address or settings", () => {
		show();
		renderPanel();
		const header = screen.getByTestId('peer-agent-panel-header');
		expect(header).toHaveTextContent('Builder');
		expect(screen.getByTestId('federation-badge-hosted')).toHaveTextContent('Hosted');
		expect(screen.queryByText(/Mirror of/)).not.toBeInTheDocument();
		expect(screen.queryByText('build:a1')).not.toBeInTheDocument();
		expect(screen.queryByLabelText(/Copy/)).not.toBeInTheDocument();
		expect(screen.queryByLabelText(/Edit agent settings/)).not.toBeInTheDocument();
		// No Left Bar row points at it, so there is no cwd or SSH remote for the viewers to read.
		expect(screen.queryByLabelText('Memory Viewer')).not.toBeInTheDocument();
		expect(screen.queryByLabelText('Agent Sessions')).not.toBeInTheDocument();
		expect(composerProps.current).toMatchObject({ peerId: 'build', agentId: 'a1' });
		expect((composerProps.current?.tab as { id: string }).id).toBe('t1');
		expect(composerProps.current?.onOpenLightbox).toBeTypeOf('function');
	});

	it("opens a new tab, closes, stars, and renames through the strip's own controls, on the host", () => {
		show(
			peerWith([
				agent({
					aiTabs: [
						{ id: 't1', name: 'First', starred: false },
						{ id: 't2', name: 'Second' },
					],
				}),
			])
		);
		renderPanel();
		act(() => (tabBarProps.current?.onNewTab as () => void)());
		expect(openMirrorTab).toHaveBeenCalledWith('build', 'a1');
		act(() => (tabBarProps.current?.onTabClose as (id: string) => void)('t2'));
		expect(closeMirrorTab).toHaveBeenCalledWith('build', 'a1', 't2');
		act(() =>
			(tabBarProps.current?.onTabStar as (id: string, starred: boolean) => void)('t1', true)
		);
		expect(starMirrorTab).toHaveBeenCalledWith('build', 'a1', 't1', true);

		act(() => (tabBarProps.current?.onRequestRename as (id: string) => void)('t1'));
		const input = screen.getByDisplayValue('First');
		fireEvent.change(input, { target: { value: 'Renamed' } });
		fireEvent.click(screen.getByText('Rename'));
		expect(renameMirrorTab).toHaveBeenCalledWith('build', 'a1', 't1', 'Renamed');
		// The host's update renames the tab; nothing local changed.
		expect(usePeerMirrorStore.getState().peers.build.agents[0].aiTabs?.[0].name).toBe('First');
		expect(useSessionStore.getState().sessions).toEqual([]);
	});

	it('says so when the agent has no open tab, and reads nothing', () => {
		show(peerWith([agent({ aiTabs: [] })]));
		renderPanel();
		expect(screen.getByText('This agent has no open tabs on Build Box.')).toBeInTheDocument();
		expect(readMirrorTranscript).not.toHaveBeenCalled();
		expect(tabBarProps.current).toBeNull();
		// No tab to send to, but a new one can still be opened on the host.
		expect(screen.queryByTestId('peer-agent-composer')).not.toBeInTheDocument();
		fireEvent.click(screen.getByText('New Tab'));
		expect(openMirrorTab).toHaveBeenCalledWith('build', 'a1');
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

	describe('History column', () => {
		it('sits beside the transcript while the Right Bar toggle is on, and goes with it', () => {
			useUIStore.getState().setRightPanelOpen(true);
			show();
			renderPanel();
			expect(screen.getByTestId('peer-history-column')).toBeInTheDocument();
			expect(
				screen.getByText("On Build Box, with the project's shared History")
			).toBeInTheDocument();

			act(() => useUIStore.getState().setRightPanelOpen(false));
			expect(screen.queryByTestId('peer-history-column')).not.toBeInTheDocument();
			expect(screen.getByTestId('peer-agent-panel')).toBeInTheDocument();
		});

		it('is not drawn while the toggle is off', () => {
			useUIStore.getState().setRightPanelOpen(false);
			show();
			renderPanel();
			expect(screen.queryByTestId('peer-history-column')).not.toBeInTheDocument();
			expect(historyPanelProps.current).toBeNull();
		});

		it('collapses from its own control', () => {
			useUIStore.getState().setRightPanelOpen(true);
			show();
			renderPanel();
			fireEvent.click(screen.getByLabelText('Collapse History'));
			expect(useUIStore.getState().rightPanelOpen).toBe(false);
			expect(screen.queryByTestId('peer-history-column')).not.toBeInTheDocument();
		});

		it('hands the History panel a view keyed by the mirror and a read-only host source', async () => {
			useUIStore.getState().setRightPanelOpen(true);
			show(peerWith([agent({ cwd: '/srv/app', projectRoot: '/srv' })]));
			renderPanel();

			expect(historyPanelProps.current?.session).toEqual({
				id: 'build:a1',
				cwd: '/srv/app',
				projectRoot: '/srv',
				toolType: 'claude-code',
			});
			const source = historyPanelProps.current?.source as HistorySource;
			expect(source.remove).toBeUndefined();
			expect(source.update).toBeUndefined();

			const historyPage = vi.fn(async () => ({ entries: [], hasMore: false, total: 0 }));
			const win = window as unknown as { maestro: Record<string, unknown> };
			const original = win.maestro.federation;
			win.maestro.federation = { historyPage };
			try {
				await source.getPage({
					lookbackHours: null,
					types: ['USER'],
					hostKey: null,
					groupCue: false,
					pagination: { offset: 0, limit: 20 },
				});
				expect(historyPage).toHaveBeenCalledWith('build', 'a1', {
					lookbackHours: null,
					types: ['USER'],
					hostKey: null,
					pagination: { offset: 0, limit: 20 },
				});
			} finally {
				win.maestro.federation = original;
			}
			// Nothing about the History column reaches the local agent store.
			expect(useSessionStore.getState().sessions).toEqual([]);
		});
	});

	describe('one strip with the tabs this machine kept', () => {
		const keptLogs = [{ id: 'k1', timestamp: 1, source: 'user', text: 'before the move' }];
		function withLocalRow() {
			useSessionStore.setState({
				sessions: [
					{
						id: 'row-1',
						name: 'Builder',
						toolType: 'claude-code',
						cwd: '/srv/builder',
						liftedTo: { peer: 'build', agentId: 'a1', at: 1 },
						aiTabs: [
							{ id: 'blank', agentSessionId: null, logs: [] },
							{ id: 'kept', agentSessionId: 'sess-old', name: 'Old work', logs: keptLogs },
						],
					},
				] as never,
			});
		}

		it("lists the host's tabs, then the kept local ones, each with where it lives", () => {
			withLocalRow();
			show();
			renderPanel();
			const props = tabBarProps.current as {
				tabs: { id: string }[];
				tabLocations: Record<string, { label: string }>;
			};
			expect(props.tabs.map((tab) => tab.id)).toEqual(['t1', 't2', 'kept']);
			expect(props.tabLocations.t1.label).toBe('Build Box');
			expect(props.tabLocations.kept.label).toBe('Local');
		});

		it('shows a kept tab read only from the local copy, with no composer and no host read', () => {
			withLocalRow();
			show();
			usePeerMirrorStore.getState().selectMirrorTab('build', 'a1', 'kept');
			vi.mocked(readMirrorTranscript).mockClear();
			renderPanel();
			const session = (terminalProps.current as { session: { id: string; activeTabId: string } })
				.session;
			expect(session).toMatchObject({ id: 'row-1', activeTabId: 'kept' });
			expect((terminalProps.current as { readOnly: boolean }).readOnly).toBe(true);
			expect(screen.getByTestId('peer-agent-local-tab-notice')).toHaveTextContent(
				'continue in a tab on Build Box'
			);
			expect(readMirrorTranscript).not.toHaveBeenCalled();
			expect((tabBarProps.current as { activeTabId: string }).activeTabId).toBe('kept');
		});

		it('leaves a kept tab alone when the strip asks to close, rename, or star it', () => {
			withLocalRow();
			show();
			renderPanel();
			act(() => (tabBarProps.current?.onTabClose as (id: string) => void)('kept'));
			act(() => (tabBarProps.current?.onRequestRename as (id: string) => void)('kept'));
			act(() =>
				(tabBarProps.current?.onTabStar as (id: string, starred: boolean) => void)('kept', true)
			);
			expect(closeMirrorTab).not.toHaveBeenCalled();
			expect(starMirrorTab).not.toHaveBeenCalled();
			expect(screen.queryByDisplayValue('Old work')).not.toBeInTheDocument();
		});

		it('offers the Memory Viewer and Agent Sessions on the Left Bar row, as a local agent does', () => {
			withLocalRow();
			show();
			renderPanel();
			fireEvent.click(screen.getByLabelText('Memory Viewer'));
			expect(screen.getByTestId('memory-viewer-stub')).toBeInTheDocument();
			expect((memoryViewerProps.current?.activeSession as { id: string }).id).toBe('row-1');
			act(() => (memoryViewerProps.current?.onClose as () => void)());
			fireEvent.click(screen.getByLabelText('Agent Sessions'));
			expect(screen.getByTestId('agent-sessions-stub')).toBeInTheDocument();
			expect((sessionsBrowserProps.current?.activeSession as { id: string }).id).toBe('row-1');
		});

		it('resumes a past conversation into the host tab that holds it', () => {
			withLocalRow();
			show(
				peerWith([
					agent({
						aiTabs: [
							{ id: 't1', name: 'First' },
							{ id: 't2', name: 'Second', agentSessionId: 'sess-2' },
						],
					}),
				])
			);
			renderPanel();
			fireEvent.click(screen.getByLabelText('Agent Sessions'));
			act(() => (sessionsBrowserProps.current?.onResumeSession as (id: string) => void)('sess-2'));
			expect(usePeerMirrorStore.getState().activeTabIds).toEqual({ build: { a1: 't2' } });
			expect(screen.queryByTestId('agent-sessions-stub')).not.toBeInTheDocument();
		});

		it('draws no location pills while the agent kept nothing here', () => {
			show();
			renderPanel();
			expect((tabBarProps.current as { tabLocations?: unknown }).tabLocations).toBeUndefined();
		});
	});
});
