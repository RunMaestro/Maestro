/**
 * PeerHistoryColumn - the History of a Federation peer's mirrored agent, beside its transcript.
 *
 * It takes the Right Bar's place while a mirror is shown: same width setting, same toggle
 * (`toggleRightPanel`), and Cmd+Shift+H opens it. The panel inside is the local agent's
 * `HistoryPanel`, reading from the host through `mirrorHistorySource()`: the host's entries and
 * the shared History of the agent's project, each labeled with the machine it came from. It is
 * read-only: the host owns the entries.
 */

import { useMemo } from 'react';
import { PanelRightClose } from 'lucide-react';
import type { Theme } from '../../types';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import { mirrorKey } from '../../../shared/maestro-lib/client/peer-mirror';
import { HistoryPanel, type HistoryPanelAgent } from '../HistoryPanel';
import { mirrorHistorySource } from '../History/historySource';
import { useResizablePanel } from '../../hooks/ui/useResizablePanel';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';

export interface PeerHistoryColumnProps {
	theme: Theme;
	peerId: string;
	peerName: string;
	agent: AgentRecord;
}

export function PeerHistoryColumn({ theme, peerId, peerName, agent }: PeerHistoryColumnProps) {
	const width = useSettingsStore((s) => s.rightPanelWidth);
	const setWidth = useSettingsStore((s) => s.setRightPanelWidth);
	const toggleKeys = useSettingsStore((s) => s.shortcuts.toggleRightPanel?.keys);
	const { panelRef, onResizeStart, transitionClass } = useResizablePanel({
		width,
		minWidth: 200,
		maxWidth: 600,
		settingsKey: 'rightPanelWidth',
		setWidth,
		side: 'right',
	});

	const source = useMemo(() => mirrorHistorySource(peerId, agent.id), [peerId, agent.id]);
	// A view of the host's agent, never a `Session`: its key is the mirror key no local store holds.
	const view = useMemo<HistoryPanelAgent>(
		() => ({
			id: mirrorKey(peerId, agent.id),
			cwd: agent.cwd ?? '',
			projectRoot: agent.projectRoot ?? agent.cwd ?? '',
			toolType: agent.toolType as HistoryPanelAgent['toolType'],
		}),
		[peerId, agent.id, agent.cwd, agent.projectRoot, agent.toolType]
	);

	return (
		<div
			ref={panelRef}
			className={`relative border-l flex flex-col shrink-0 ${transitionClass}`}
			style={{
				width: `${width}px`,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			}}
			data-testid="peer-history-column"
		>
			<div
				className="resize-handle absolute top-0 left-0 w-3 h-full cursor-col-resize border-l-4 border-transparent hover:border-blue-500 transition-colors z-20"
				onPointerDown={onResizeStart}
			/>
			<div
				className="flex items-center border-b h-16 shrink-0 select-none"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex-1 min-w-0 px-4">
					<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
						History
					</div>
					<div className="text-xs truncate" style={{ color: theme.colors.textDim }}>
						On {peerName}, with the project's shared History
					</div>
				</div>
				<button
					type="button"
					onClick={() => useUIStore.getState().setRightPanelOpen(false)}
					className="flex items-center justify-center p-2 rounded hover:bg-white/5 transition-colors w-12 shrink-0"
					title={`Collapse Panel${toggleKeys ? ` (${formatShortcutKeys(toggleKeys)})` : ''}`}
					aria-label="Collapse History"
				>
					<PanelRightClose className="w-4 h-4 opacity-50" />
				</button>
			</div>
			<div className="flex-1 min-h-0 p-3">
				<HistoryPanel session={view} source={source} theme={theme} />
			</div>
		</div>
	);
}
