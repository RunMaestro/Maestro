/**
 * PeerMirrorSection - the Left Bar's Federation peers: one collapsible group per peer the desktop
 * mirrors, with its agents under it (FED-SSH-05, read-only).
 *
 * Built from `peerMirrorStore`, never from `sessionStore` groups, so the local Left Bar machinery
 * (categories, ordering, virtual grouping, window filtering, jump slots, cycling) never sees a
 * mirrored agent. Rows are deliberately NOT `SessionItem`: that row wires rename, drag to group,
 * bookmark, the agent context menu, and batch and retry state, all local-only. The shared pieces
 * are the status dot colors (`getStatusColor`) and the `MiniBadge`. A row's right-click opens a
 * two-item menu (Copy `peer:agent`, Reconnect peer); `SessionContextMenu` is never mounted for one.
 *
 * Renders nothing while the Federation Encore Feature is off or no peer is mirrored.
 */

import { memo, useCallback, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Network, RefreshCw } from 'lucide-react';
import { mirrorKey, type MirroredPeer } from '../../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import type { Theme } from '../../types';
import { useClickOutside, useContextMenuPosition } from '../../hooks/ui';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { copyPeerAgentRef, reconnectPeer } from '../../services/peerMirror';
import { elevatedSurfaceStyle } from '../../utils/elevatedSurface';
import {
	isPeerDisconnected,
	mirroredAgentState,
	peerConnectionDotState,
	peerConnectionLabel,
} from '../../utils/peerMirrorView';
import { getStatusColor } from '../../utils/theme';
import { MiniBadge } from '../ui/MiniBadge';

interface MenuTarget {
	x: number;
	y: number;
	peerId: string;
	agentId?: string;
}

function PeerMenu({
	target,
	theme,
	onDismiss,
}: {
	target: MenuTarget;
	theme: Theme;
	onDismiss: () => void;
}) {
	const menuRef = useRef<HTMLDivElement>(null);
	useClickOutside(menuRef, onDismiss);
	useEventListener(
		'keydown',
		(event) => {
			if ((event as KeyboardEvent).key === 'Escape') onDismiss();
		},
		{ target: typeof document !== 'undefined' ? document : null }
	);
	const { left, top, maxHeight, ready } = useContextMenuPosition(menuRef, target.x, target.y);
	const { peerId, agentId } = target;
	const itemClass =
		'w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2';
	return (
		<div
			ref={menuRef}
			className="fixed z-50 py-1 rounded-md whitespace-nowrap select-none"
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
				...elevatedSurfaceStyle(theme),
				minWidth: '10rem',
				maxHeight,
				overflowY: 'auto',
			}}
			data-testid="peer-mirror-menu"
		>
			{agentId && (
				<button
					type="button"
					className={itemClass}
					style={{ color: theme.colors.textMain }}
					onClick={() => {
						void copyPeerAgentRef(peerId, agentId);
						onDismiss();
					}}
				>
					<Copy className="w-3.5 h-3.5" />
					Copy {mirrorKey(peerId, agentId)}
				</button>
			)}
			<button
				type="button"
				className={itemClass}
				style={{ color: theme.colors.textMain }}
				onClick={() => {
					void reconnectPeer(peerId);
					onDismiss();
				}}
			>
				<RefreshCw className="w-3.5 h-3.5" />
				Reconnect {peerId}
			</button>
		</div>
	);
}

const MirroredAgentRow = memo(function MirroredAgentRow({
	peerId,
	agent,
	theme,
	isActive,
	dimmed,
	onOpenMenu,
}: {
	peerId: string;
	agent: AgentRecord;
	theme: Theme;
	isActive: boolean;
	dimmed: boolean;
	onOpenMenu: (target: MenuTarget) => void;
}) {
	const state = mirroredAgentState(agent);
	return (
		<button
			type="button"
			className="w-full flex items-center gap-2 px-3 py-1.5 text-left row-hover"
			style={{
				backgroundColor: isActive ? `${theme.colors.accent}20` : undefined,
				opacity: dimmed ? 0.55 : 1,
			}}
			onClick={() => usePeerMirrorStore.getState().selectMirroredAgent(peerId, agent.id)}
			onContextMenu={(event) => {
				event.preventDefault();
				onOpenMenu({ x: event.clientX, y: event.clientY, peerId, agentId: agent.id });
			}}
			title={mirrorKey(peerId, agent.id)}
			data-testid="peer-mirror-agent-row"
			aria-current={isActive ? 'true' : undefined}
		>
			<span
				className={`w-2 h-2 rounded-full shrink-0 ${state === 'busy' || state === 'connecting' ? 'animate-pulse' : ''}`}
				style={{ backgroundColor: getStatusColor(state, theme) }}
			/>
			<span className="flex-1 min-w-0">
				<span className="block text-sm truncate" style={{ color: theme.colors.textMain }}>
					{agent.name}
				</span>
				<span className="block text-2xs truncate" style={{ color: theme.colors.textDim }}>
					{getAgentDisplayName(agent.toolType)}
				</span>
			</span>
			<MiniBadge label="Peer" theme={theme} title={`Runs on ${peerId}`} />
		</button>
	);
});

function PeerGroup({
	peer,
	theme,
	collapsed,
	activeAgentId,
	showCount,
	onOpenMenu,
}: {
	peer: MirroredPeer;
	theme: Theme;
	collapsed: boolean;
	activeAgentId: string | null;
	showCount: boolean;
	onOpenMenu: (target: MenuTarget) => void;
}) {
	const dotState = peerConnectionDotState(peer.connection);
	const dimmed = isPeerDisconnected(peer);
	return (
		<div className="mb-1" data-testid="peer-mirror-group" data-peer-id={peer.peerId}>
			<button
				type="button"
				className="w-full px-3 py-1.5 flex items-center gap-2 cursor-pointer row-hover"
				onClick={() => usePeerMirrorStore.getState().togglePeerCollapsed(peer.peerId)}
				onContextMenu={(event) => {
					event.preventDefault();
					onOpenMenu({ x: event.clientX, y: event.clientY, peerId: peer.peerId });
				}}
				aria-expanded={!collapsed}
				title={peerConnectionLabel(peer)}
			>
				<span
					className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider flex-1 min-w-0"
					style={{ color: theme.colors.textDim }}
				>
					{collapsed ? (
						<ChevronRight className="w-3 h-3 shrink-0" />
					) : (
						<ChevronDown className="w-3 h-3 shrink-0" />
					)}
					<Network className="w-3.5 h-3.5 shrink-0" />
					<span className="truncate">{peer.name}</span>
					{showCount && <span className="opacity-60">({peer.agents.length})</span>}
				</span>
				<span
					className={`w-2 h-2 rounded-full shrink-0 ${dotState === 'connecting' ? 'animate-pulse' : ''}`}
					style={{ backgroundColor: getStatusColor(dotState, theme) }}
					data-testid="peer-mirror-connection-dot"
					data-connection={peer.connection}
				/>
			</button>
			{!collapsed && (
				<div className="flex flex-col border-l ml-4" style={{ borderColor: theme.colors.border }}>
					{peer.agents.length === 0 ? (
						<div className="px-3 py-1.5 text-xs italic" style={{ color: theme.colors.textDim }}>
							{peer.connection === 'connected'
								? 'No agents on this host'
								: peerConnectionLabel(peer)}
						</div>
					) : (
						peer.agents.map((agent) => (
							<MirroredAgentRow
								key={agent.id}
								peerId={peer.peerId}
								agent={agent}
								theme={theme}
								isActive={activeAgentId === agent.id}
								dimmed={dimmed}
								onOpenMenu={onOpenMenu}
							/>
						))
					)}
				</div>
			)}
		</div>
	);
}

export function PeerMirrorSection({ theme }: { theme: Theme }) {
	const enabled = usePeerMirrorStore((s) => s.enabled);
	const order = usePeerMirrorStore((s) => s.order);
	const peers = usePeerMirrorStore((s) => s.peers);
	const collapsedPeerIds = usePeerMirrorStore((s) => s.collapsedPeerIds);
	const activeMirror = usePeerMirrorStore((s) => s.activeMirror);
	const showCount = useSettingsStore((s) => s.showLeftPanelGroupMemberCount);
	const [menu, setMenu] = useState<MenuTarget | null>(null);
	const closeMenu = useCallback(() => setMenu(null), []);

	if (!enabled || order.length === 0) return null;

	return (
		<div className="mt-2" data-testid="peer-mirror-section">
			{order.map((peerId) => {
				const peer = peers[peerId];
				if (!peer) return null;
				return (
					<PeerGroup
						key={peerId}
						peer={peer}
						theme={theme}
						collapsed={!!collapsedPeerIds[peerId]}
						activeAgentId={activeMirror?.peerId === peerId ? activeMirror.agentId : null}
						showCount={showCount}
						onOpenMenu={setMenu}
					/>
				);
			})}
			{menu && <PeerMenu target={menu} theme={theme} onDismiss={closeMenu} />}
		</div>
	);
}
