/**
 * GroupChatHeader.tsx
 *
 * Header bar for the Group Chat view. Carries the chat name, the team/moderator
 * view switch, the participant count, cost, and the rename and info actions.
 * The name is the one thing here that yields when the row runs out of width -
 * see the comment on the left zone below.
 */

import { useRef } from 'react';
import { Info, Edit2, Columns, DollarSign, StopCircle } from 'lucide-react';
import type { Theme, Shortcut, GroupChatState } from '../types';
import type { GroupChatViewMode } from '../../shared/groupChatModeratorView';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { SegmentedControl } from './ui/SegmentedControl';
import { useSettingsStore } from '../stores/settingsStore';
import { useOptionalLabelFits } from '../hooks/ui/useOptionalLabelFits';

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

	// Whether the name still fits. Measured rather than guessed at a breakpoint,
	// because what is left for it depends on which conditional controls (Stop
	// All, the cost pill, the panel toggle) are rendered right now, and on the
	// user's font size - neither of which a px threshold can see.
	const rowRef = useRef<HTMLDivElement>(null);
	const nameFits = useOptionalLabelFits(rowRef);

	// `group-chat-header-container` drives the yield ladder in index.css: the
	// participant count goes first, then the view switch shortens its labels.
	// `-busy` shifts those rungs wider while Stop All occupies the row.
	return (
		<div
			ref={rowRef}
			className={`group-chat-header-container flex items-center justify-between gap-3 px-6 h-16 border-b shrink-0 overflow-hidden ${state !== 'idle' ? 'group-chat-header-busy' : ''}`}
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			}}
		>
			{/*
			  The name is shown IN FULL or not at all, never clipped: "Group Chat:
			  Maes..." costs the same row space as the whole name and says less,
			  and every other control here is fixed-width, so the name is the only
			  thing that can yield. `shrink-0` + the root's `overflow-hidden` are
			  what make that decidable - see useOptionalLabelFits. When it is
			  dropped the name is still on the rename button's tooltip and is the
			  info overlay's title.
			*/}
			<div className="flex items-center gap-3 shrink-0">
				{nameFits && (
					<h1
						className="text-lg font-semibold cursor-pointer hover:opacity-80 shrink-0 whitespace-nowrap"
						style={{ color: theme.colors.textMain }}
						onClick={onRename}
						onKeyDown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								onRename();
							}
						}}
						tabIndex={0}
						role="button"
						title="Click to rename"
					>
						Group Chat: {name}
					</h1>
				)}
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
