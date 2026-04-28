/**
 * GroupChatSetupSheet component for Maestro mobile web interface
 *
 * Uses `ResponsiveModal` so it renders as a bottom sheet on phones and a
 * centered dialog at tablet+. The "Start Group Chat" primary action lives in
 * the modal footer — always visible above the scrolling participant list and
 * thumb-reachable on mobile.
 */

import { useState, useCallback } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { ResponsiveModal, Button } from '../components';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import type { Session } from '../hooks/useSessions';

export interface GroupChatSetupSheetProps {
	isOpen: boolean;
	sessions: Session[];
	onStart: (topic: string, participantIds: string[]) => void;
	onClose: () => void;
}

export function GroupChatSetupSheet({
	isOpen,
	sessions,
	onStart,
	onClose,
}: GroupChatSetupSheetProps) {
	const colors = useThemeColors();
	const [topic, setTopic] = useState('');
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

	const toggleParticipant = useCallback((sessionId: string) => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(sessionId)) {
				next.delete(sessionId);
			} else {
				next.add(sessionId);
			}
			return next;
		});
	}, []);

	const canStart = topic.trim().length > 0 && selectedIds.size >= 2;

	const handleStart = useCallback(() => {
		if (!canStart) return;
		triggerHaptic(HAPTIC_PATTERNS.send);
		onStart(topic.trim(), Array.from(selectedIds));
		onClose();
	}, [canStart, topic, selectedIds, onStart, onClose]);

	return (
		<ResponsiveModal
			isOpen={isOpen}
			onClose={onClose}
			title="Start Group Chat"
			zIndex={220}
			footer={
				<Button
					variant="primary"
					fullWidth
					size="lg"
					onClick={handleStart}
					disabled={!canStart}
					aria-label="Start Group Chat"
				>
					Start Group Chat
				</Button>
			}
		>
			{/* Topic input */}
			<div style={{ marginBottom: '20px' }}>
				<label
					style={{
						display: 'block',
						fontSize: '13px',
						fontWeight: 600,
						color: colors.textDim,
						textTransform: 'uppercase',
						letterSpacing: '0.5px',
						marginBottom: '8px',
					}}
				>
					Topic
				</label>
				<input
					type="text"
					value={topic}
					onChange={(e) => setTopic(e.target.value)}
					placeholder="What should the agents discuss?"
					style={{
						width: '100%',
						padding: '12px 14px',
						borderRadius: '10px',
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.bgSidebar,
						color: colors.textMain,
						fontSize: '14px',
						outline: 'none',
						WebkitAppearance: 'none',
						boxSizing: 'border-box',
						minHeight: '44px',
					}}
					onFocus={(e) => {
						(e.target as HTMLInputElement).style.borderColor = colors.accent;
					}}
					onBlur={(e) => {
						(e.target as HTMLInputElement).style.borderColor = colors.border;
					}}
				/>
			</div>

			{/* Participant selector */}
			<div>
				<label
					style={{
						display: 'block',
						fontSize: '13px',
						fontWeight: 600,
						color: colors.textDim,
						textTransform: 'uppercase',
						letterSpacing: '0.5px',
						marginBottom: '4px',
					}}
				>
					Participants
				</label>
				<span
					style={{
						display: 'block',
						fontSize: '12px',
						color: selectedIds.size < 2 ? colors.warning : colors.textDim,
						marginBottom: '10px',
					}}
				>
					{selectedIds.size} agent{selectedIds.size !== 1 ? 's' : ''} selected
					{selectedIds.size < 2 && ' — select at least 2'}
				</span>
				<div
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: '6px',
					}}
				>
					{sessions.map((session) => {
						const isSelected = selectedIds.has(session.id);
						return (
							<button
								key={session.id}
								onClick={() => toggleParticipant(session.id)}
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: '10px',
									padding: '12px 14px',
									borderRadius: '10px',
									border: `1px solid ${isSelected ? colors.accent : colors.border}`,
									backgroundColor: isSelected ? `${colors.accent}10` : colors.bgSidebar,
									color: colors.textMain,
									width: '100%',
									textAlign: 'left',
									cursor: 'pointer',
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
									outline: 'none',
									minHeight: '44px',
									transition: 'all 0.15s ease',
								}}
								aria-pressed={isSelected}
							>
								{/* Checkbox indicator */}
								<div
									style={{
										width: '20px',
										height: '20px',
										borderRadius: '4px',
										border: `2px solid ${isSelected ? colors.accent : colors.textDim}`,
										backgroundColor: isSelected ? colors.accent : 'transparent',
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'center',
										flexShrink: 0,
										transition: 'all 0.15s ease',
									}}
								>
									{isSelected && (
										<svg
											width="12"
											height="12"
											viewBox="0 0 24 24"
											fill="none"
											stroke="white"
											strokeWidth="3"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<polyline points="20 6 9 17 4 12" />
										</svg>
									)}
								</div>

								{/* Agent info */}
								<div style={{ flex: 1, minWidth: 0 }}>
									<div
										style={{
											fontSize: '14px',
											fontWeight: 500,
											whiteSpace: 'nowrap',
											overflow: 'hidden',
											textOverflow: 'ellipsis',
										}}
									>
										{session.name}
									</div>
								</div>

								{/* Agent type badge */}
								<span
									style={{
										fontSize: '11px',
										fontWeight: 500,
										padding: '2px 8px',
										borderRadius: '6px',
										backgroundColor: `${colors.textDim}15`,
										color: colors.textDim,
										flexShrink: 0,
									}}
								>
									{session.toolType}
								</span>
							</button>
						);
					})}

					{sessions.length === 0 && (
						<div
							style={{
								textAlign: 'center',
								padding: '20px',
								color: colors.textDim,
								fontSize: '13px',
							}}
						>
							No agents available
						</div>
					)}
				</div>
			</div>
		</ResponsiveModal>
	);
}

export default GroupChatSetupSheet;
