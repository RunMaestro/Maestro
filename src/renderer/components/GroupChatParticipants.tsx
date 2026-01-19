/**
 * GroupChatParticipants.tsx
 *
 * Right panel component that displays all participants in a group chat.
 * Shows moderator card at top, then participant cards sorted alphabetically.
 * This panel replaces the RightPanel when a group chat is active.
 */

import { useMemo, useCallback } from 'react';
import { PanelRightClose } from 'lucide-react';
import type { Theme, GroupChatParticipant, SessionState, Shortcut } from '../types';
import { ParticipantCard } from './ParticipantCard';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { buildParticipantColorMap } from '../utils/participantColors';

interface GroupChatParticipantsProps {
	theme: Theme;
	participants: GroupChatParticipant[];
	participantStates: Map<string, SessionState>;
	isOpen: boolean;
	onToggle: () => void;
	width: number;
	setWidthState: (width: number) => void;
	shortcuts: Record<string, Shortcut>;
	/** Group chat ID */
	groupChatId: string;
	/** Moderator agent ID (e.g., 'claude-code') */
	moderatorAgentId: string;
	/** Moderator internal session ID (for routing) */
	moderatorSessionId: string;
	/** Moderator agent session ID (Claude Code session UUID for display) */
	moderatorAgentSessionId?: string;
	/** Moderator state for status indicator */
	moderatorState: SessionState;
	/** Moderator usage stats (context, cost, tokens) */
	moderatorUsage?: { contextUsage: number; totalCost: number; tokenCount: number } | null;
}

export function GroupChatParticipants({
	theme,
	participants,
	participantStates,
	isOpen,
	onToggle,
	width,
	setWidthState,
	shortcuts,
	groupChatId,
	moderatorAgentId,
	moderatorSessionId,
	moderatorAgentSessionId,
	moderatorState,
	moderatorUsage,
}: GroupChatParticipantsProps): JSX.Element | null {
	// Generate consistent colors for all participants (including "Moderator" for the moderator card)
	const participantColors = useMemo(() => {
		return buildParticipantColorMap(['Moderator', ...participants.map((p) => p.name)], theme);
	}, [participants, theme]);

	// Create a synthetic moderator participant for display
	// The moderator works in batch mode (spawns per-message), so the agentSessionId
	// is set after the first message is processed and Claude Code reports its session UUID
	const moderatorParticipant: GroupChatParticipant = useMemo(
		() => ({
			name: 'Moderator',
			agentId: moderatorAgentId,
			sessionId: moderatorSessionId,
			// Use the real Claude Code agent session ID for display (set after first message)
			agentSessionId: moderatorAgentSessionId,
			addedAt: Date.now(),
			contextUsage: moderatorUsage?.contextUsage,
			tokenCount: moderatorUsage?.tokenCount,
			totalCost: moderatorUsage?.totalCost,
		}),
		[moderatorAgentId, moderatorSessionId, moderatorAgentSessionId, moderatorUsage]
	);

	// Sort participants alphabetically by name
	const sortedParticipants = useMemo(() => {
		return [...participants].sort((a, b) => a.name.localeCompare(b.name));
	}, [participants]);

	// Handle context reset for a participant
	const handleContextReset = useCallback(
		async (participantName: string) => {
			try {
				await window.maestro.groupChat.resetParticipantContext(groupChatId, participantName);
			} catch (error) {
				console.error(`Failed to reset context for ${participantName}:`, error);
			}
		},
		[groupChatId]
	);

	if (!isOpen) return null;

	return (
		<div
			className="relative border-l flex flex-col transition-all duration-300"
			style={{
				width: `${width}px`,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			}}
		>
			{/* Resize Handle */}
			<div
				className="absolute top-0 left-0 w-1 h-full cursor-col-resize hover:bg-blue-500 transition-colors z-20"
				onMouseDown={(e) => {
					e.preventDefault();
					const startX = e.clientX;
					const startWidth = width;
					let currentWidth = startWidth;

					const handleMouseMove = (moveEvent: MouseEvent) => {
						const delta = startX - moveEvent.clientX; // Reversed for right panel
						currentWidth = Math.max(200, Math.min(600, startWidth + delta));
						setWidthState(currentWidth);
					};

					const handleMouseUp = () => {
						window.maestro.settings.set('rightPanelWidth', currentWidth);
						document.removeEventListener('mousemove', handleMouseMove);
						document.removeEventListener('mouseup', handleMouseUp);
					};

					document.addEventListener('mousemove', handleMouseMove);
					document.addEventListener('mouseup', handleMouseUp);
				}}
			/>
			{/* Header with collapse button - h-16 matches GroupChatHeader height */}
			<div
				className="px-4 h-16 border-b flex items-center justify-between shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<h2 className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
					Participants
				</h2>
				<button
					onClick={onToggle}
					className="flex items-center justify-center p-2 rounded hover:bg-white/5 transition-colors"
					title={`Collapse Participants (${formatShortcutKeys(shortcuts.toggleRightPanel.keys)})`}
				>
					<PanelRightClose className="w-4 h-4 opacity-50" />
				</button>
			</div>

			<div className="flex-1 overflow-y-auto p-3 space-y-3">
				{/* Moderator card always at top - no reset for moderator */}
				<ParticipantCard
					key="moderator"
					theme={theme}
					participant={moderatorParticipant}
					state={moderatorState}
					color={participantColors['Moderator']}
				/>

				{/* Separator between moderator and participants */}
				{sortedParticipants.length > 0 && (
					<div className="border-t my-2" style={{ borderColor: theme.colors.border }} />
				)}

				{/* Participants sorted alphabetically */}
				{sortedParticipants.length === 0 ? (
					<div className="text-sm text-center py-4" style={{ color: theme.colors.textDim }}>
						No participants yet.
						<br />
						Ask the moderator to add agents.
					</div>
				) : (
					sortedParticipants.map((participant) => (
						<ParticipantCard
							key={participant.sessionId}
							theme={theme}
							participant={participant}
							state={participantStates.get(participant.sessionId) || 'idle'}
							color={participantColors[participant.name]}
							groupChatId={groupChatId}
							onContextReset={handleContextReset}
						/>
					))
				)}
			</div>
		</div>
	);
}
