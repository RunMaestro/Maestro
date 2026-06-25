/**
 * Pianola workspace tabs - the two pinned, non-closable views in Pianola's
 * workspace: its Dashboard (agent status board) and its Chat. Rendered only for
 * the Pianola agent, in place of the normal tab bar, since Pianola is a manager
 * surface rather than a coding workspace with file/terminal/browser tabs.
 */

import React from 'react';
import { LayoutDashboard, MessageSquare } from 'lucide-react';
import type { Theme } from '../../types';

interface PianolaWorkspaceTabsProps {
	theme: Theme;
	activeView: 'chat' | 'dashboard';
	onSelect: (view: 'chat' | 'dashboard') => void;
	/** Count of agents needing input, badged on the Dashboard tab (0 = no badge). */
	needsInputCount: number;
}

function Tab({
	theme,
	active,
	icon,
	label,
	badge,
	onClick,
}: {
	theme: Theme;
	active: boolean;
	icon: React.ReactNode;
	label: string;
	badge?: number;
	onClick: () => void;
}): React.ReactElement {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors"
			style={{
				color: active ? theme.colors.textMain : theme.colors.textDim,
				borderBottom: `2px solid ${active ? theme.colors.accent : 'transparent'}`,
				fontWeight: active ? 600 : 400,
			}}
		>
			{icon}
			<span>{label}</span>
			{badge !== undefined && badge > 0 && (
				<span
					className="ml-0.5 px-1.5 rounded-full text-xs font-bold"
					style={{ backgroundColor: theme.colors.warning, color: theme.colors.accentForeground }}
				>
					{badge}
				</span>
			)}
		</button>
	);
}

export function PianolaWorkspaceTabs({
	theme,
	activeView,
	onSelect,
	needsInputCount,
}: PianolaWorkspaceTabsProps): React.ReactElement {
	return (
		<div
			className="flex items-center gap-1 px-2 shrink-0 border-b"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
		>
			<Tab
				theme={theme}
				active={activeView === 'dashboard'}
				icon={<LayoutDashboard className="w-4 h-4" />}
				label="Dashboard"
				badge={needsInputCount}
				onClick={() => onSelect('dashboard')}
			/>
			<Tab
				theme={theme}
				active={activeView === 'chat'}
				icon={<MessageSquare className="w-4 h-4" />}
				label="Chat"
				onClick={() => onSelect('chat')}
			/>
		</div>
	);
}
