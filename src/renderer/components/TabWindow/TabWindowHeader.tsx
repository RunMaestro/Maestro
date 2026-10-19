/**
 * TabWindowHeader - the slim header of a tab window (Tab Windows, TW-2, TW-3).
 *
 * The agent's status dot and name, and a Dock button that returns the active
 * tab to its owner window (TW-11, the first way out). It is also the window's
 * drag strip: with the hidden-inset title bar there is no other place to grab
 * the window, so the header carries `-webkit-app-region: drag` and leaves room
 * for the macOS traffic lights, the same way the app window's title strip does.
 */

import { PictureInPicture2 } from 'lucide-react';
import type React from 'react';
import type { Session, Theme } from '../../types';
import { useAgentStatusIndicator } from '../SessionItem';
import { AgentStatusDot } from '../ui/AgentStatusDot';
import { HeaderActionButton } from '../ui/HeaderActionButton';
import { useSettingsStore } from '../../stores/settingsStore';
import { useBatchStore } from '../../stores/batchStore';
import { isMacOSPlatform } from '../../utils/platformUtils';

/** Clearance for the macOS traffic lights of a hidden-inset title bar. */
const TRAFFIC_LIGHT_INSET_PX = 80;

export interface TabWindowHeaderProps {
	theme: Theme;
	/** The agent, or null before its state reaches this window (phase 5). */
	session: Session | null;
	/** Dock the active tab. Absent while the window shows no tab. */
	onDock?: () => void;
}

export function TabWindowHeader({ theme, session, onDock }: TabWindowHeaderProps) {
	const useNativeTitleBar = useSettingsStore((s) => s.useNativeTitleBar);
	// With a native title bar the OS draws the drag strip and the buttons.
	const isDragStrip = !useNativeTitleBar;

	return (
		<div
			className="chrome-sheen h-10 border-b flex items-center gap-2 pr-3 shrink-0 relative z-20 select-none"
			style={
				{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgSidebar,
					paddingLeft: isDragStrip && isMacOSPlatform() ? TRAFFIC_LIGHT_INSET_PX : 12,
					WebkitAppRegion: isDragStrip ? 'drag' : undefined,
				} as React.CSSProperties
			}
			data-testid="tab-window-header"
		>
			<div className="flex items-center gap-2 text-sm font-medium min-w-0 overflow-hidden">
				{session && <TabWindowAgentStatus theme={theme} session={session} />}
				<span
					className="truncate"
					style={{ color: theme.colors.textMain }}
					data-testid="tab-window-agent-name"
				>
					{session?.name ?? ''}
				</span>
			</div>
			<div className="flex-1" />
			{onDock && (
				// Buttons inside a drag strip must opt out, or the click drags the window.
				<span style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
					<HeaderActionButton
						theme={theme}
						variant="ghost"
						onClick={onDock}
						icon={<PictureInPicture2 />}
						title="Dock this tab back into the main window"
						testId="tab-window-dock"
					>
						Dock
					</HeaderActionButton>
				</span>
			)}
		</div>
	);
}

/**
 * The Left Bar's status dot for this agent, with the same inputs the Left Bar
 * feeds it. A separate component so its store hooks run only once the session
 * exists. The stores are this window's own; phase 5 decides which of them the
 * owner mirrors here.
 */
function TabWindowAgentStatus({ theme, session }: { theme: Theme; session: Session }) {
	// Same rule as `selectActiveBatchSessionIds`, read for one agent.
	const isInBatch = useBatchStore((s) => {
		const run = s.batchRunStates[session.id];
		return !!run?.isRunning && !run.errorPaused;
	});
	const status = useAgentStatusIndicator(session, theme, isInBatch);
	return (
		<AgentStatusDot
			theme={theme}
			color={status.color}
			animate={status.animate}
			hollow={status.hollow}
			title={status.label}
			className="shrink-0"
		/>
	);
}
