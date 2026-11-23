/**
 * PeerAgentPanel - the Main Window for a Federation peer's mirrored agent.
 *
 * Shown by AppShell instead of MainPanel and RightPanel while `peerMirrorStore.activeMirror` is
 * set. It composes the components a local agent renders through, from a view object, never a
 * `Session`: `TabBar` (select only), `TerminalOutput` (no pins, no save, no local history paging),
 * which draws each entry through `LogItem`, and `PeerAgentComposer`.
 *
 * It must look like a local agent's Main Window: the only mark that the agent lives elsewhere is
 * the Hosted badge in the header (its hover card says what hosted means and how the host
 * connection stands). The header's right side carries the same Memory Viewer and Agent Sessions
 * buttons, reading the host's files over the agent's SSH remote.
 *
 * Input (FED-SSH-06) goes to the host through `services/peerMirror.ts` and the main-process mirror
 * service, never through a local handler: send and Stop from the composer, and new tab, close,
 * rename, and star from the tab strip's own controls (the + button and each tab's hover menu).
 * The strip offers only the actions the host serves: merge, send to agent, and the rest stay off.
 *
 * A tab's transcript is read lazily from the host when it is shown, and again when the host marks
 * it stale; a turn in flight shows as a live tail after it. The messages waiting in the host's
 * queue for the tab show as the same queued cards a local agent draws: remove and Hold / Resume
 * act on the HOST's queue. A disconnected peer keeps its last known state on
 * screen, with a banner and a Reconnect button. While the Right Bar toggle is on, the agent's
 * History sits beside it (`PeerHistoryColumn`): the host's entries and the shared History of its
 * project, read-only.
 *
 * One strip, every conversation: after the host's tabs come the tabs the agent's own Left Bar
 * record keeps on this machine from before it moved (`hostedLocalTabs()`). Each tab carries a pill
 * that says where it lives. A local tab shows its transcript read only, from this machine's copy;
 * it takes no input, because a send there would resume the provider session the host now owns.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brain, List, Play, RefreshCw } from 'lucide-react';
import type { Session, Theme } from '../../types';
import { liveTurnKey } from '../../../shared/maestro-lib/client/live-turn';
import { mirrorKey } from '../../../shared/maestro-lib/client/peer-mirror';
import { getAgentCapabilities } from '../../../shared/maestro-lib/providers/capabilities';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { useSessionStore } from '../../stores/sessionStore';
import { findLiftedAgent } from '../../../shared/maestro-lib/agents/lift-pointer';
import { getModalActions, selectModalOpen, useModalStore } from '../../stores/modalStore';
import { notifyToast } from '../../stores/notificationStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { useSurfaceTypography } from '../../hooks/ui/useSurfaceTypography';
import {
	closeMirrorTab,
	openMirrorTab,
	readMirrorTranscript,
	reconnectPeer,
	removeMirrorQueuedItem,
	renameMirrorTab,
	setMirrorQueuedItemPaused,
	starMirrorTab,
} from '../../services/peerMirror';
import { startPeerHost } from '../../services/agentLift';
import {
	buildMirrorViewSession,
	hostedLocalTabs,
	isPeerDisconnected,
	mirrorTabEntries,
	mirrorTabs,
	resolveMirrorTabId,
} from '../../utils/peerMirrorView';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { TabBar } from '../TabBar';
import { TerminalOutput } from '../TerminalOutput';
import type { TerminalOutputProps } from '../TerminalOutput/types';
import { FederationBadge } from '../SessionList/FederationBadge';
import { AgentSessionsBrowser } from '../AgentSessionsBrowser';
import { MemoryViewer } from '../MemoryViewer';
import { SkeletonBox } from '../ui/SkeletonBox';
import { RenameTabModal } from '../RenameTabModal';
import { PeerAgentComposer } from './PeerAgentComposer';
import { PeerHistoryColumn } from './PeerHistoryColumn';

export interface PeerAgentPanelProps {
	theme: Theme;
	/** The app's image lightbox opener (the same one MainPanel gets). */
	setLightboxImage: TerminalOutputProps['setLightboxImage'];
}

/** The view a kept local tab renders through: this machine's copy, read only, no queue. */
function localTabViewSession(local: Session, tabId: string): TerminalOutputProps['session'] {
	return {
		id: local.id,
		activeTabId: tabId,
		aiTabs: local.aiTabs,
		inputMode: 'ai',
		toolType: local.toolType,
		cwd: local.cwd,
		executionQueue: [],
		deferredContent: local.deferredContent,
		sessionSshRemoteConfig: local.sessionSshRemoteConfig,
	};
}

export function PeerAgentPanel({ theme, setLightboxImage }: PeerAgentPanelProps) {
	const selection = usePeerMirrorStore((s) => s.activeMirror);
	const peer = usePeerMirrorStore((s) => (selection ? s.peers[selection.peerId] : undefined));
	const preferredTabId = usePeerMirrorStore((s) =>
		selection ? s.activeTabIds[selection.peerId]?.[selection.agentId] : undefined
	);
	const agent = useMemo(
		() => peer?.agents.find((candidate) => candidate.id === selection?.agentId),
		[peer, selection?.agentId]
	);
	// The agent's own Left Bar record, and the conversations it kept here from before it moved.
	const local = useSessionStore((s) =>
		selection ? findLiftedAgent(s.sessions, selection.peerId, selection.agentId) : undefined
	);
	const localTabs = useMemo(() => hostedLocalTabs(local), [local]);
	const localTabId = localTabs.find((tab) => tab.id === preferredTabId)?.id;
	// The host tab shown, or none while a kept local tab is.
	const tabId = agent && !localTabId ? resolveMirrorTabId(agent, preferredTabId) : undefined;
	const slotKey = agent && tabId ? liveTurnKey(agent.id, tabId) : undefined;
	const slot = usePeerMirrorStore((s) =>
		selection && slotKey ? s.transcripts[selection.peerId]?.[slotKey] : undefined
	);
	const liveTurn = peer && slotKey ? peer.liveTurns[slotKey] : undefined;
	const queue = peer && selection ? peer.queues[selection.agentId] : undefined;
	const disconnected = peer ? isPeerDisconnected(peer) : false;

	const chat = useSurfaceTypography('chat');
	const maxOutputLines = useSettingsStore((s) => s.maxOutputLines);
	const chatRawTextMode = useSettingsStore((s) => s.chatRawTextMode);
	const userMessageAlignment = useSettingsStore((s) => s.userMessageAlignment);
	const activeFocus = useUIStore((s) => s.activeFocus);
	const historyOpen = useUIStore((s) => s.rightPanelOpen);
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const agentSessionsOpen = useModalStore(selectModalOpen('agentSessions'));
	const memoryViewerOpen = useModalStore(selectModalOpen('memoryViewer'));

	// Find-bar state is the view's own: Cmd+F is a local shortcut and stays blocked here, so the
	// bar only ever opens from a future control of this panel.
	const [outputSearchOpen, setOutputSearchOpen] = useState(false);
	const [outputSearchQuery, setOutputSearchQuery] = useState('');
	const [outputSearchRegex, setOutputSearchRegex] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const logsEndRef = useRef<HTMLDivElement>(null);
	/** The tab whose rename dialog is open. */
	const [renamingTabId, setRenamingTabId] = useState<string | null>(null);

	// Read the shown tab when it has never been read, or the host marked it stale. A failed read
	// waits for the Retry button or the next stale mark, so a peer that is down is not polled.
	const needsRead =
		!!selection &&
		!!tabId &&
		!slot?.loading &&
		(!slot || slot.stale || (!slot.loaded && !slot.error));
	useEffect(() => {
		if (!needsRead || !selection || !tabId) return;
		void readMirrorTranscript(selection.peerId, selection.agentId, tabId);
	}, [needsRead, selection, tabId]);

	const entries = useMemo(
		() => mirrorTabEntries(slot?.entries ?? [], liveTurn, slot?.carryover),
		[slot?.entries, slot?.carryover, liveTurn]
	);
	const viewSession = useMemo(
		() =>
			selection && agent && tabId
				? buildMirrorViewSession({ peerId: selection.peerId, agent, tabId, entries, queue })
				: null,
		[selection, agent, tabId, entries, queue]
	);
	const hostTabs = useMemo(() => (agent ? mirrorTabs(agent) : []), [agent]);
	const tabs = useMemo(() => [...hostTabs, ...localTabs], [hostTabs, localTabs]);
	const tabLocations = useMemo(() => {
		if (localTabs.length === 0 || !peer) return undefined;
		const locations: Record<string, { label: string; title: string }> = {};
		const host = { label: peer.name, title: `Lives on ${peer.name}, which runs this agent` };
		const here = {
			label: 'Local',
			title: 'Kept on this machine from before the agent moved. Read only.',
		};
		for (const tab of hostTabs) locations[tab.id] = host;
		for (const tab of localTabs) locations[tab.id] = here;
		return locations;
	}, [hostTabs, localTabs, peer]);
	const shownTabId = localTabId ?? tabId;
	const localView = useMemo(
		() => (local && localTabId ? localTabViewSession(local, localTabId) : null),
		[local, localTabId]
	);

	const handleTabSelect = useCallback(
		(nextTabId: string) => {
			if (!selection) return;
			usePeerMirrorStore.getState().selectMirrorTab(selection.peerId, selection.agentId, nextTabId);
		},
		[selection]
	);
	// The queue actions the host serves: remove, and Hold / Resume. Edit, merge, reorder, Force
	// Send, and steer stay off: the queued cards draw only the controls they get a handler for.
	// They stay wired while the peer is disconnected: the cards always draw Remove, and the
	// action then fails with a toast that says so, rather than closing its confirm silently.
	const handleRemoveQueuedItem = useCallback(
		(itemId: string) => {
			if (selection) void removeMirrorQueuedItem(selection.peerId, selection.agentId, itemId);
		},
		[selection]
	);
	const handleTogglePauseQueuedItem = useCallback(
		(itemId: string) => {
			if (!selection) return;
			const waiting = queue?.find((item) => item.itemId === itemId);
			if (!waiting) return;
			void setMirrorQueuedItemPaused(selection.peerId, selection.agentId, itemId, !waiting.paused);
		},
		[selection, queue]
	);
	const handleRetry = useCallback(() => {
		if (selection && tabId) void readMirrorTranscript(selection.peerId, selection.agentId, tabId);
	}, [selection, tabId]);

	// The strip's own controls, answered on the host. A tab this machine kept from before the move
	// is a read-only copy: it has nothing on the host to rename, star, or close.
	const isHostTab = useCallback((id: string) => hostTabs.some((tab) => tab.id === id), [hostTabs]);
	const handleNewTab = useCallback(() => {
		if (selection) void openMirrorTab(selection.peerId, selection.agentId);
	}, [selection]);
	const handleTabClose = useCallback(
		(closingTabId: string) => {
			if (!selection) return;
			if (!isHostTab(closingTabId)) {
				notifyToast({
					color: 'yellow',
					title: 'Tab not closed',
					message:
						'This conversation is the copy kept from before the agent moved. It stays read only.',
				});
				return;
			}
			void closeMirrorTab(selection.peerId, selection.agentId, closingTabId);
		},
		[selection, isHostTab]
	);
	const handleRequestRename = useCallback(
		(renameTabId: string) => {
			if (isHostTab(renameTabId)) setRenamingTabId(renameTabId);
		},
		[isHostTab]
	);
	const handleTabStar = useCallback(
		(starTabId: string, starred: boolean) => {
			if (selection && isHostTab(starTabId)) {
				void starMirrorTab(selection.peerId, selection.agentId, starTabId, starred);
			}
		},
		[selection, isHostTab]
	);
	// Agent Sessions: a past conversation opens in the host tab that holds it. The host cannot yet
	// resume a provider session into a new tab, so one no tab holds is a notice.
	const handleResumeSession = useCallback(
		(agentSessionId: string) => {
			if (!selection) return;
			const holder = agent?.aiTabs?.find((tab) => tab.agentSessionId === agentSessionId);
			getModalActions().setAgentSessionsOpen(false);
			if (holder) {
				usePeerMirrorStore
					.getState()
					.selectMirrorTab(selection.peerId, selection.agentId, holder.id);
				return;
			}
			notifyToast({
				color: 'yellow',
				title: 'Not resumed',
				message: `No open tab on ${peer?.name ?? 'the host'} holds that conversation, and the host cannot resume one into a new tab yet.`,
			});
		},
		[selection, agent, peer?.name]
	);
	const handleNewSession = useCallback(() => {
		getModalActions().setAgentSessionsOpen(false);
		handleNewTab();
	}, [handleNewTab]);

	const tabRecord = useMemo(
		() => (agent && tabId ? agent.aiTabs?.find((tab) => tab.id === tabId) : undefined),
		[agent, tabId]
	);
	const renamingTab = useMemo(
		() =>
			agent && renamingTabId ? agent.aiTabs?.find((tab) => tab.id === renamingTabId) : undefined,
		[agent, renamingTabId]
	);

	if (!selection || !peer || !agent) return null;

	const ref = mirrorKey(peer.peerId, agent.id);
	const provider = getAgentCapabilities(agent.toolType);
	// The viewers read the agent's own Left Bar record: its cwd and its SSH remote, the host.
	const canBrowseSessions = !!local && provider.supportsSessionStorage === true;
	const canViewMemory = !!local && provider.supportsProjectMemory === true;
	const showSkeleton = !slot?.loaded && !slot?.error && entries.length === 0;
	const showReadError = !!slot?.error && !slot.loaded;

	// The Agent Sessions browser and the Memory Viewer take the Main Window over, as they do for a
	// local agent.
	if (agentSessionsOpen && canBrowseSessions) {
		return (
			<div
				className="flex-1 flex flex-col min-w-0 relative"
				style={{ backgroundColor: theme.colors.bgMain }}
			>
				<AgentSessionsBrowser
					theme={theme}
					activeSession={local}
					activeAgentSessionId={null}
					onClose={() => getModalActions().setAgentSessionsOpen(false)}
					onResumeSession={handleResumeSession}
					onNewSession={handleNewSession}
				/>
			</div>
		);
	}
	if (memoryViewerOpen && canViewMemory) {
		return (
			<div
				className="flex-1 flex flex-col min-w-0 relative"
				style={{ backgroundColor: theme.colors.bgMain }}
			>
				<MemoryViewer
					theme={theme}
					activeSession={local}
					onClose={() => getModalActions().setMemoryViewerOpen(false)}
				/>
			</div>
		);
	}

	return (
		<div
			className="flex-1 flex min-w-0 relative"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="peer-agent-panel"
		>
			<div className="flex-1 flex flex-col min-w-0">
				{/* Header: the same shape as a local agent's. The Hosted badge is the only difference. */}
				<div
					className="chrome-sheen header-container h-16 border-b flex items-center justify-between gap-4 px-6 shrink-0 relative z-20 select-none"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
					data-testid="peer-agent-panel-header"
				>
					<div className="flex items-center gap-2 text-sm font-medium min-w-0 overflow-hidden">
						<span className="header-session-name truncate" style={{ color: theme.colors.textMain }}>
							{agent.name}
						</span>
						<FederationBadge
							theme={theme}
							mode={{
								kind: 'hosted',
								peerName: peer.name,
								connection: peer.connection,
								...(peer.error ? { error: peer.error } : {}),
							}}
						/>
					</div>
					<div className="flex items-center gap-2 shrink-0">
						{canViewMemory && (
							<button
								type="button"
								onClick={() => getModalActions().setMemoryViewerOpen(true)}
								aria-label="Memory Viewer"
								className="header-secondary-btn p-2 rounded hover:bg-white/5"
								title={`Memory Viewer (${formatShortcutKeys(shortcuts.openMemoryViewer?.keys ?? ['Meta', 'Shift', 'm'])})`}
							>
								<Brain className="w-4 h-4" style={{ color: theme.colors.textDim }} />
							</button>
						)}
						{canBrowseSessions && (
							<button
								type="button"
								onClick={() => getModalActions().setAgentSessionsOpen(true)}
								aria-label="Agent Sessions"
								className="header-secondary-btn p-2 rounded hover:bg-white/5"
								title={`Agent Sessions (${formatShortcutKeys(shortcuts.agentSessions?.keys ?? ['Meta', 'Shift', 'l'])})`}
							>
								<List className="w-4 h-4" style={{ color: theme.colors.textDim }} />
							</button>
						)}
					</div>
				</div>

				{disconnected && (
					<div
						className="flex items-center gap-2 px-4 py-2 text-xs shrink-0"
						style={{
							backgroundColor: `${theme.colors.error}18`,
							color: theme.colors.textMain,
							borderBottom: `1px solid ${theme.colors.border}`,
						}}
						data-testid="peer-agent-panel-disconnected"
					>
						<span className="flex-1 min-w-0 select-text">
							Disconnected from {peer.name}. Showing the last known state.
							{peer.error ? ` ${peer.error}` : ''}
						</span>
						<button
							type="button"
							onClick={() => void reconnectPeer(peer.peerId)}
							className="flex items-center gap-1 px-2 py-0.5 rounded border shrink-0 hover:opacity-80"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							<RefreshCw className="w-3 h-3" />
							Reconnect
						</button>
						<button
							type="button"
							onClick={() => void startPeerHost(peer.remoteId, peer.name)}
							className="flex items-center gap-1 px-2 py-0.5 rounded border shrink-0 hover:opacity-80"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							title="Install or upgrade maestro-cli on the remote if needed, then start its host (maestro-cli remote-host install --start)"
							data-testid="peer-agent-panel-start-host"
						>
							<Play className="w-3 h-3" />
							Start Host
						</button>
					</div>
				)}

				{tabs.length > 0 && shownTabId && (
					<TabBar
						tabs={tabs}
						activeTabId={shownTabId}
						theme={theme}
						onTabSelect={handleTabSelect}
						onTabClose={handleTabClose}
						onNewTab={handleNewTab}
						onRequestRename={handleRequestRename}
						onTabStar={handleTabStar}
						tabLocations={tabLocations}
					/>
				)}

				<div className="flex-1 min-h-0 flex flex-col relative">
					{localView ? (
						<TerminalOutput
							key={`${local?.id}-${localTabId}`}
							session={localView}
							readOnly
							theme={theme}
							fontFamily={chat.fontFamily}
							activeFocus={activeFocus}
							outputSearchOpen={outputSearchOpen}
							outputSearchQuery={outputSearchQuery}
							outputSearchRegex={outputSearchRegex}
							setOutputSearchOpen={setOutputSearchOpen}
							setOutputSearchQuery={setOutputSearchQuery}
							setOutputSearchRegex={setOutputSearchRegex}
							setActiveFocus={useUIStore.getState().setActiveFocus}
							setLightboxImage={setLightboxImage}
							inputRef={inputRef}
							logsEndRef={logsEndRef}
							maxOutputLines={maxOutputLines}
							markdownEditMode={chatRawTextMode}
							setMarkdownEditMode={useSettingsStore.getState().setChatRawTextMode}
							userMessageAlignment={userMessageAlignment}
						/>
					) : !tabId ? (
						<div
							className="flex-1 flex flex-col items-center justify-center gap-2 text-sm"
							style={{ color: theme.colors.textDim }}
						>
							This agent has no open tabs on {peer.name}.
							<button
								type="button"
								onClick={handleNewTab}
								className="flex items-center gap-1 px-2 py-0.5 rounded border text-xs hover:opacity-80"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							>
								New Tab
							</button>
						</div>
					) : showReadError ? (
						<div
							className="flex-1 flex flex-col items-center justify-center gap-2 text-sm px-6 text-center"
							style={{ color: theme.colors.textDim }}
							data-testid="peer-agent-panel-read-error"
						>
							<span className="select-text">{slot?.error}</span>
							<button
								type="button"
								onClick={handleRetry}
								className="flex items-center gap-1 px-2 py-0.5 rounded border text-xs hover:opacity-80"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							>
								<RefreshCw className="w-3 h-3" />
								Retry
							</button>
						</div>
					) : showSkeleton ? (
						<div className="flex-1 flex flex-col gap-3 p-6" data-testid="peer-agent-panel-loading">
							<SkeletonBox theme={theme} className="h-4 w-2/3" />
							<SkeletonBox theme={theme} className="h-4 w-1/2" />
							<SkeletonBox theme={theme} className="h-4 w-3/4" />
						</div>
					) : (
						viewSession && (
							<TerminalOutput
								key={`${ref}-${tabId}`}
								session={viewSession}
								readOnly
								theme={theme}
								fontFamily={chat.fontFamily}
								activeFocus={activeFocus}
								outputSearchOpen={outputSearchOpen}
								outputSearchQuery={outputSearchQuery}
								outputSearchRegex={outputSearchRegex}
								setOutputSearchOpen={setOutputSearchOpen}
								setOutputSearchQuery={setOutputSearchQuery}
								setOutputSearchRegex={setOutputSearchRegex}
								setActiveFocus={useUIStore.getState().setActiveFocus}
								setLightboxImage={setLightboxImage}
								inputRef={inputRef}
								logsEndRef={logsEndRef}
								maxOutputLines={maxOutputLines}
								markdownEditMode={chatRawTextMode}
								setMarkdownEditMode={useSettingsStore.getState().setChatRawTextMode}
								userMessageAlignment={userMessageAlignment}
								onRemoveQueuedItem={handleRemoveQueuedItem}
								onTogglePauseQueuedItem={handleTogglePauseQueuedItem}
							/>
						)
					)}
				</div>

				{localView && (
					<div
						className="px-4 py-3 text-xs border-t shrink-0 select-none"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
						data-testid="peer-agent-local-tab-notice"
					>
						This conversation is the copy this machine kept from before the agent moved to{' '}
						{peer.name}. It is read only: continue in a tab on {peer.name}.
					</div>
				)}

				{tabRecord && (
					<PeerAgentComposer
						theme={theme}
						peerId={peer.peerId}
						peerName={peer.name}
						agentId={agent.id}
						agentName={agent.name}
						agent={agent}
						tab={tabRecord}
						onOpenLightbox={setLightboxImage}
					/>
				)}

				{renamingTab && (
					<RenameTabModal
						theme={theme}
						initialName={renamingTab.name ?? ''}
						agentSessionId={renamingTab.agentSessionId}
						onClose={() => setRenamingTabId(null)}
						onRename={(name) => void renameMirrorTab(peer.peerId, agent.id, renamingTab.id, name)}
						title={`Rename Tab on ${peer.name}`}
					/>
				)}
			</div>
			{historyOpen && (
				<PeerHistoryColumn theme={theme} peerId={peer.peerId} peerName={peer.name} agent={agent} />
			)}
		</div>
	);
}
