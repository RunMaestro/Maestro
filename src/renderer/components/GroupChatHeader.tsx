/**
 * GroupChatHeader.tsx
 *
 * Header bar for the Group Chat view. Carries the team/moderator view switch,
 * the participant count, cost, and the rename and info actions. The chat name
 * itself is shown in the info overlay rather than here - see the comment on the
 * left zone below.
 */

import { Info, Edit2, Columns, DollarSign, StopCircle } from 'lucide-react';
import type { Theme, Shortcut, GroupChatState } from '../types';
import type { GroupChatViewMode } from '../../shared/groupChatModeratorView';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { SegmentedControl } from './ui/SegmentedControl';
import { useSettingsStore } from '../stores/settingsStore';

interface GroupChatHeaderProps {
	theme: Theme;
	name: string;
	participantCount: number;
	/** True when the room is showing only the user <-> moderator conversation. */
	moderatorOnly: boolean;
	/** Flip between the team view and the moderator-only view. */
	onToggleModeratorOnly: () => void;
	/** Total accumulated cost from all participants (including moderator) */
	totalCost?: number;
	/** True if one or more participants don't have cost data (makes total incomplete) */
	costIncomplete?: boolean;
	state: GroupChatState;
	onStopAll: () => void;
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
	moderatorOnly,
	onToggleModeratorOnly,
	totalCost,
	costIncomplete,
	state,
	onStopAll,
	onRename,
	onShowInfo,
	rightPanelOpen,
	onToggleRightPanel,
	shortcuts,
}: GroupChatHeaderProps): JSX.Element {
	// Same Display setting that governs the main header's cost pill.
	const showSessionCostPill = useSettingsStore((s) => s.showSessionCostPill);

	// `group-chat-header-container` drives the yield ladder in index.css: the
	// participant count goes first, then the view switch shortens its labels.
	// `-busy` shifts those rungs wider while Stop All occupies the row.
	return (
		<div
			className={`group-chat-header-container flex items-center justify-between px-6 h-16 border-b shrink-0 ${state !== 'idle' ? 'group-chat-header-busy' : ''}`}
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			}}
		>
			{/*
			  The chat name is deliberately NOT printed in this row. Every other
			  control here is fixed-width, so the name was the only thing that
			  could yield, and on a phone it yielded down to "G..." - which costs
			  the same space as the full name and says less. It now lives in the
			  info overlay's title, in this button's tooltip, and in the rename
			  dialog this button opens. `flex-1` keeps the cluster hard right.
			*/}
			<div className="flex items-center flex-1 min-w-0">
				<button
					onClick={onRename}
					className="p-1 rounded hover:opacity-80 shrink-0"
					style={{ color: theme.colors.textDim }}
					title={`Rename "${name}"`}
					aria-label={`Rename group chat "${name}"`}
				>
					<Edit2 className="w-4 h-4" />
				</button>
			</div>

			{/*
			  One right-hand cluster that never shrinks. The switch used to sit in
			  a centered third zone between two `flex-1` sides, which reserved half
			  the free space just to keep it centered.
			*/}
			<div className="flex items-center gap-2 shrink-0">
				<SegmentedControl<GroupChatViewMode>
					value={moderatorOnly ? 'moderator' : 'team'}
					onChange={(next) => {
						if ((next === 'moderator') !== moderatorOnly) onToggleModeratorOnly();
					}}
					options={[
						{
							value: 'team',
							label: 'Team Chat',
							shortLabel: 'Team',
							title:
								'Show every message and history entry, including agent delegations and replies',
						},
						{
							value: 'moderator',
							label: 'Moderator Only',
							shortLabel: 'Moderator',
							title:
								'Show only your conversation with the moderator, hiding the agent back-and-forth',
						},
					]}
					theme={theme}
					ariaLabel="Group chat view"
					testId="group-chat-view-mode"
				/>
				{/* Stop All button - only shown when active */}
				{state !== 'idle' && (
					<button
						onClick={onStopAll}
						className="flex items-center gap-1 text-xs px-2 py-0.5 rounded hover:opacity-80 transition-opacity cursor-pointer whitespace-nowrap shrink-0"
						style={{
							backgroundColor: `${theme.colors.error}20`,
							color: theme.colors.error,
							border: `1px solid ${theme.colors.error}40`,
						}}
						title="Stop all moderator and participant activity"
					>
						<StopCircle className="w-3.5 h-3.5" />
						Stop All
					</button>
				)}
				<span
					className="group-chat-header-participants text-xs px-2 py-0.5 rounded-full whitespace-nowrap shrink-0"
					style={{
						backgroundColor: theme.colors.border,
						color: theme.colors.textDim,
					}}
				>
					{participantCount} participant{participantCount !== 1 ? 's' : ''}
				</span>
				{/* Total cost pill - only show when enabled and there's a cost */}
				{showSessionCostPill && totalCost !== undefined && totalCost > 0 && (
					<span
						className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full whitespace-nowrap shrink-0"
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
					className="p-2 rounded hover:opacity-80 shrink-0"
					style={{ color: theme.colors.textDim }}
					title="Info"
				>
					<Info className="w-5 h-5" />
				</button>
				{!rightPanelOpen && (
					<button
						onClick={onToggleRightPanel}
						className="p-2 rounded hover:bg-white/5 shrink-0"
						title={`Show right panel (${formatShortcutKeys(shortcuts.toggleRightPanel.keys)})`}
					>
						<Columns className="w-4 h-4" />
					</button>
				)}
			</div>
		</div>
	);
}
