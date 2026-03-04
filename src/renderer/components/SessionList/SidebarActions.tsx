import { memo } from 'react';
import { PanelLeftClose, PanelLeftOpen, Bot, Wand2 } from 'lucide-react';
import type { Theme, Shortcut } from '../../types';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';

interface SidebarActionsProps {
	theme: Theme;
	leftSidebarOpen: boolean;
	hasNoSessions: boolean;
	shortcuts: Record<string, Shortcut>;
	addNewSession: () => void;
	openWizard?: () => void;
	setLeftSidebarOpen: (open: boolean) => void;
}

export const SidebarActions = memo(function SidebarActions({
	theme,
	leftSidebarOpen,
	hasNoSessions,
	shortcuts,
	addNewSession,
	openWizard,
	setLeftSidebarOpen,
}: SidebarActionsProps) {
	return (
		<div
			className="p-2 border-t flex gap-2 items-center"
			style={{ borderColor: theme.colors.border }}
		>
			<button
				type="button"
				disabled={hasNoSessions && leftSidebarOpen}
				onClick={() => setLeftSidebarOpen(!leftSidebarOpen)}
				className={`flex items-center justify-center p-2 rounded transition-colors w-8 h-8 shrink-0 ${hasNoSessions && leftSidebarOpen ? 'opacity-20 cursor-not-allowed' : 'hover:bg-white/5'}`}
				title={
					hasNoSessions && leftSidebarOpen
						? 'Add an agent first to collapse sidebar'
						: `${leftSidebarOpen ? 'Collapse' : 'Expand'} Sidebar (${formatShortcutKeys(shortcuts.toggleSidebar.keys)})`
				}
			>
				{leftSidebarOpen ? (
					<PanelLeftClose className="w-4 h-4 opacity-50" />
				) : (
					<PanelLeftOpen className="w-4 h-4 opacity-50" />
				)}
			</button>

			{leftSidebarOpen && (
				<button
					type="button"
					onClick={addNewSession}
					className="flex-1 flex items-center justify-center gap-2 py-2 rounded text-xs font-bold transition-colors hover:opacity-90"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
				>
					<Bot className="w-3 h-3" /> New Agent
				</button>
			)}

			{leftSidebarOpen && openWizard && (
				<button
					type="button"
					onClick={openWizard}
					className="flex-1 flex items-center justify-center gap-2 py-2 rounded text-xs font-bold transition-colors hover:opacity-90"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
					title="Get started with AI wizard"
				>
					<Wand2 className="w-3 h-3" /> Wizard
				</button>
			)}
		</div>
	);
});
