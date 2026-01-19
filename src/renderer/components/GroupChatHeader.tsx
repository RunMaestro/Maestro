/**
 * GroupChatHeader.tsx
 *
 * Header bar for the Group Chat view. Displays the chat name with participant count
 * and provides actions for rename, info, and close.
 */

import { X, Info, Edit2, Columns, DollarSign } from 'lucide-react';
import type { Theme, Shortcut } from '../types';
import { formatShortcutKeys } from '../utils/shortcutFormatter';

interface GroupChatHeaderProps {
	theme: Theme;
	name: string;
	participantCount: number;
	/** Total accumulated cost from all participants (including moderator) */
	totalCost?: number;
	/** True if one or more participants don't have cost data (makes total incomplete) */
	costIncomplete?: boolean;
	onClose: () => void;
	onRename: () => void;
	onShowInfo: () => void;
	rightPanelOpen: boolean;
	onToggleRightPanel: () => void;
	shortcuts: Record<string, Shortcut>;
}

export function GroupChatHeader({
	theme,
	name,
	participantCount,
	totalCost,
	costIncomplete,
	onClose,
	onRename,
	onShowInfo,
	rightPanelOpen,
	onToggleRightPanel,
	shortcuts,
}: GroupChatHeaderProps): JSX.Element {
	return (
		<div
			className="flex items-center justify-between px-6 h-16 border-b shrink-0"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			}}
		>
			<div className="flex items-center gap-3">
				<h1
					className="text-lg font-semibold cursor-pointer hover:opacity-80"
					style={{ color: theme.colors.textMain }}
					onClick={onRename}
					title="Click to rename"
				>
					Group Chat: {name}
				</h1>
				<button
					onClick={onRename}
					className="p-1 rounded hover:opacity-80"
					style={{ color: theme.colors.textDim }}
					title="Rename"
				>
					<Edit2 className="w-4 h-4" />
				</button>
			</div>

			<div className="flex items-center gap-2">
				<span
					className="text-xs px-2 py-0.5 rounded-full"
					style={{
						backgroundColor: theme.colors.border,
						color: theme.colors.textDim,
					}}
				>
					{participantCount} participant{participantCount !== 1 ? 's' : ''}
				</span>
				{/* Total cost pill - only show when there's a cost */}
				{totalCost !== undefined && totalCost > 0 && (
					<span
						className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
						style={{
							backgroundColor: `${theme.colors.success}20`,
							color: theme.colors.success,
						}}
						title={
							costIncomplete
								? 'Total accumulated cost (incomplete: not all agents report cost data)'
								: 'Total accumulated cost'
						}
					>
						<DollarSign className="w-3 h-3" />
						{totalCost.toFixed(2)}
						{costIncomplete && '*'}
					</span>
				)}
				<button
					onClick={onShowInfo}
					className="p-2 rounded hover:opacity-80"
					style={{ color: theme.colors.textDim }}
					title="Info"
				>
					<Info className="w-5 h-5" />
				</button>
				<button
					onClick={onClose}
					className="p-2 rounded hover:opacity-80"
					style={{ color: theme.colors.textDim }}
					title="Close"
				>
					<X className="w-5 h-5" />
				</button>
				{!rightPanelOpen && (
					<button
						onClick={onToggleRightPanel}
						className="p-2 rounded hover:bg-white/5"
						title={`Show right panel (${formatShortcutKeys(shortcuts.toggleRightPanel.keys)})`}
					>
						<Columns className="w-4 h-4" />
					</button>
				)}
			</div>
		</div>
	);
}
