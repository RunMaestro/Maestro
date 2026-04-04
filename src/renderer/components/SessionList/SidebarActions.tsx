import { memo } from 'react';
import { PanelLeftClose, PanelLeftOpen, Bell, Bot, MessageSquarePlus } from 'lucide-react';
import type { Theme, Shortcut } from '../../types';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';

interface SidebarActionsProps {
	theme: Theme;
	leftSidebarOpen: boolean;
	hasNoSessions: boolean;
	shortcuts: Record<string, Shortcut>;
	showUnreadAgentsOnly: boolean;
	hasUnreadAgents: boolean;
	addNewSession: () => void;
	openFeedback?: () => void;
	setLeftSidebarOpen: (open: boolean) => void;
	toggleShowUnreadAgentsOnly: () => void;
}

export const SidebarActions = memo(function SidebarActions({
	theme,
	leftSidebarOpen,
	hasNoSessions,
	shortcuts,
	showUnreadAgentsOnly,
	hasUnreadAgents,
	addNewSession,
	openFeedback,
	setLeftSidebarOpen,
	toggleShowUnreadAgentsOnly,
}: SidebarActionsProps) {
	const toggleSidebarShortcutLabel = shortcuts.toggleSidebar?.keys?.length
		? ` (${formatShortcutKeys(shortcuts.toggleSidebar.keys)})`
		: '';
	const filterUnreadAgentsShortcutLabel = shortcuts.filterUnreadAgents?.keys?.length
		? ` (${formatShortcutKeys(shortcuts.filterUnreadAgents.keys)})`
		: '';

	return (
		<div
			className="p-2 border-t flex gap-2 items-center shrink-0"
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
						: `${leftSidebarOpen ? 'Collapse' : 'Expand'} Sidebar${toggleSidebarShortcutLabel}`
				}
			>
				{leftSidebarOpen ? (
					<PanelLeftClose className="w-4 h-4 opacity-50" />
				) : (
					<PanelLeftOpen className="w-4 h-4 opacity-50" />
				)}
			</button>

			{leftSidebarOpen && (
				<div
					className="flex-1 grid gap-2"
					style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}
				>
					<button
						type="button"
						onClick={addNewSession}
						className="flex items-center justify-center gap-2 py-2 rounded text-xs font-bold transition-colors hover:opacity-90 whitespace-nowrap overflow-hidden"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
					>
						<Bot className="w-3 h-3 shrink-0" /> New Agent
					</button>

					<button
						type="button"
						onClick={openFeedback}
						disabled={!openFeedback}
						className="flex items-center justify-center gap-2 py-2 rounded text-xs font-bold transition-colors hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap overflow-hidden"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
						title="Send product feedback"
					>
						<MessageSquarePlus className="w-3 h-3 shrink-0" /> Feedback
					</button>
				</div>
			)}

			{/* Unread agents filter toggle */}
			{leftSidebarOpen && (
				<button
					type="button"
					onClick={toggleShowUnreadAgentsOnly}
					className="relative flex items-center justify-center p-2 rounded transition-colors w-8 h-8 shrink-0 hover:bg-white/5"
					style={{
						color: showUnreadAgentsOnly ? theme.colors.accentForeground : undefined,
						backgroundColor: showUnreadAgentsOnly ? theme.colors.accent : undefined,
					}}
					title={
						showUnreadAgentsOnly
							? `Showing unread agents only${filterUnreadAgentsShortcutLabel}`
							: `Filter unread agents${filterUnreadAgentsShortcutLabel}`
					}
				>
					<Bell className="w-4 h-4" />
					{hasUnreadAgents && (
						<div
							className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full"
							style={{ backgroundColor: theme.colors.accent }}
						/>
					)}
				</button>
			)}
		</div>
	);
});
