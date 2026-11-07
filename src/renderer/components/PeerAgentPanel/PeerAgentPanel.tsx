/**
 * PeerAgentPanel - the Main Window for a Federation peer's mirrored agent (read-only).
 *
 * Shown by AppShell instead of MainPanel and RightPanel while `peerMirrorStore.activeMirror` is
 * set. It composes the components a local agent renders through, from a view object, never a
 * `Session`: `TabBar` (read-only: select only) and `TerminalOutput` (read-only: no pins, no save,
 * no local history paging), which draws each entry through `LogItem`. There is no composer:
 * nothing here can send, close, rename, or otherwise act, so no local-only code path ever receives
 * a mirrored agent.
 *
 * A tab's transcript is read lazily from the host when it is shown, and again when the host marks
 * it stale; a turn in flight shows as a live tail after it. A disconnected peer keeps its last
 * known state on screen, with a banner and a Reconnect button.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, RefreshCw, Radio } from 'lucide-react';
import type { Theme } from '../../types';
import { liveTurnKey } from '../../../shared/maestro-lib/client/live-turn';
import { mirrorKey } from '../../../shared/maestro-lib/client/peer-mirror';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { useSurfaceTypography } from '../../hooks/ui/useSurfaceTypography';
import { copyPeerAgentRef, readMirrorTranscript, reconnectPeer } from '../../services/peerMirror';
import {
	buildMirrorViewSession,
	isPeerDisconnected,
	mirroredAgentState,
	mirrorTabEntries,
	mirrorTabs,
	peerConnectionDotState,
	peerConnectionLabel,
	resolveMirrorTabId,
} from '../../utils/peerMirrorView';
import { getStatusColor } from '../../utils/theme';
import { TabBar } from '../TabBar';
import { TerminalOutput } from '../TerminalOutput';
import type { TerminalOutputProps } from '../TerminalOutput/types';
import { MiniBadge } from '../ui/MiniBadge';
import { SkeletonBox } from '../ui/SkeletonBox';

export interface PeerAgentPanelProps {
	theme: Theme;
	/** The app's image lightbox opener (the same one MainPanel gets). */
	setLightboxImage: TerminalOutputProps['setLightboxImage'];
}

const noop = () => {};

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
	const tabId = agent ? resolveMirrorTabId(agent, preferredTabId) : undefined;
	const slotKey = agent && tabId ? liveTurnKey(agent.id, tabId) : undefined;
	const slot = usePeerMirrorStore((s) =>
		selection && slotKey ? s.transcripts[selection.peerId]?.[slotKey] : undefined
	);
	const liveTurn = peer && slotKey ? peer.liveTurns[slotKey] : undefined;
	const disconnected = peer ? isPeerDisconnected(peer) : false;

	const chat = useSurfaceTypography('chat');
	const maxOutputLines = useSettingsStore((s) => s.maxOutputLines);
	const chatRawTextMode = useSettingsStore((s) => s.chatRawTextMode);
	const userMessageAlignment = useSettingsStore((s) => s.userMessageAlignment);
	const activeFocus = useUIStore((s) => s.activeFocus);

	// Find-bar state is the view's own: Cmd+F is a local shortcut and stays blocked here, so the
	// bar only ever opens from a future control of this panel.
	const [outputSearchOpen, setOutputSearchOpen] = useState(false);
	const [outputSearchQuery, setOutputSearchQuery] = useState('');
	const [outputSearchRegex, setOutputSearchRegex] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const logsEndRef = useRef<HTMLDivElement>(null);

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
				? buildMirrorViewSession({ peerId: selection.peerId, agent, tabId, entries })
				: null,
		[selection, agent, tabId, entries]
	);
	const tabs = useMemo(() => (agent ? mirrorTabs(agent) : []), [agent]);

	const handleTabSelect = useCallback(
		(nextTabId: string) => {
			if (!selection) return;
			usePeerMirrorStore.getState().selectMirrorTab(selection.peerId, selection.agentId, nextTabId);
		},
		[selection]
	);
	const handleRetry = useCallback(() => {
		if (selection && tabId) void readMirrorTranscript(selection.peerId, selection.agentId, tabId);
	}, [selection, tabId]);

	if (!selection || !peer || !agent) return null;

	const ref = mirrorKey(peer.peerId, agent.id);
	const showSkeleton = !slot?.loaded && !slot?.error && entries.length === 0;
	const showReadError = !!slot?.error && !slot.loaded;

	return (
		<div
			className="flex-1 flex flex-col min-w-0 relative"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="peer-agent-panel"
		>
			{/* Header: who this is, where it lives, and that it is a mirror. */}
			<div
				className="flex items-center gap-2 px-4 py-2 border-b shrink-0 select-none"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			>
				<span
					className={`w-2.5 h-2.5 rounded-full shrink-0 ${
						mirroredAgentState(agent) === 'busy' ? 'animate-pulse' : ''
					}`}
					style={{
						backgroundColor: getStatusColor(mirroredAgentState(agent), theme),
						opacity: disconnected ? 0.4 : 1,
					}}
				/>
				<span className="font-bold truncate" style={{ color: theme.colors.textMain }}>
					{agent.name}
				</span>
				<MiniBadge
					label="Peer"
					theme={theme}
					title={`Runs on ${peer.name}`}
					testId="peer-agent-panel-badge"
				/>
				<span className="text-xs truncate" style={{ color: theme.colors.textDim }}>
					{peer.name} · {getAgentDisplayName(agent.toolType)}
				</span>
				<span
					className={`w-2 h-2 rounded-full shrink-0 ${
						peerConnectionDotState(peer.connection) === 'connecting' ? 'animate-pulse' : ''
					}`}
					style={{
						backgroundColor: getStatusColor(peerConnectionDotState(peer.connection), theme),
					}}
					title={peerConnectionLabel(peer)}
				/>
				<span className="flex-1" />
				<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
					Read-only mirror of <code className="select-text">{ref}</code>
				</span>
				<button
					type="button"
					onClick={() => void copyPeerAgentRef(peer.peerId, agent.id)}
					className="p-1 rounded hover:bg-white/10 transition-colors shrink-0"
					title={`Copy ${ref}`}
					aria-label={`Copy ${ref}`}
				>
					<Copy className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
				</button>
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
				</div>
			)}

			{tabs.length > 0 && tabId && (
				<TabBar
					tabs={tabs}
					activeTabId={tabId}
					theme={theme}
					onTabSelect={handleTabSelect}
					onTabClose={noop}
					onNewTab={noop}
					readOnly
				/>
			)}

			<div className="flex-1 min-h-0 flex flex-col relative">
				{!tabId ? (
					<div
						className="flex-1 flex items-center justify-center text-sm"
						style={{ color: theme.colors.textDim }}
					>
						This agent has no open tabs on {peer.name}.
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
						/>
					)
				)}
			</div>

			{/* Where the composer would be: say why there is none. */}
			<div
				className="flex items-center gap-2 px-4 py-2 border-t text-xs shrink-0 select-none"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				data-testid="peer-agent-panel-readonly-footer"
			>
				<Radio className="w-3.5 h-3.5 shrink-0" />
				<span>
					Read-only. This agent runs on {peer.name}; sending to it from here is not available yet.
				</span>
			</div>
		</div>
	);
}
