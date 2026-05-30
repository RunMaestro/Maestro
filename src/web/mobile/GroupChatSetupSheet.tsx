/**
 * GroupChatSetupSheet component for Maestro mobile web interface
 *
 * Bottom sheet modal for starting a new group chat.
 * Allows selecting a topic and choosing participants from available agents.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import type { Session } from '../hooks/useSessions';

export interface GroupChatSetupSheetProps {
	sessions: Session[];
	onStart: (topic: string, participantIds: string[]) => void;
	onClose: () => void;
}

export function GroupChatSetupSheet({ sessions, onStart, onClose }: GroupChatSetupSheetProps) {
	const colors = useThemeColors();
	const [topic, setTopic] = useState('');
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [isVisible, setIsVisible] = useState(false);
	const topicInputRef = useRef<HTMLInputElement>(null);

	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsVisible(false);
		setTimeout(() => onClose(), 300);
	}, [onClose]);

	// Animate in on mount
	useEffect(() => {
		requestAnimationFrame(() => setIsVisible(true));
	}, []);

	// Close on escape key
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				handleClose();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [handleClose]);

	const handleBackdropTap = useCallback(
		(e: React.MouseEvent) => {
			if (e.target === e.currentTarget) {
				handleClose();
			}
		},
		[handleClose]
	);

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
		handleClose();
	}, [canStart, topic, selectedIds, onStart, handleClose]);

	return (
		<div
			onClick={handleBackdropTap}
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				backgroundColor: `rgba(0, 0, 0, ${isVisible ? 0.5 : 0})`,
				zIndex: 220,
				display: 'flex',
				alignItems: 'flex-end',
				transition: 'background-color 0.3s ease-out',
			}}
		>
			{/* Sheet */}
			<div
				style={{
					width: '100%',
					maxHeight: '85vh',
					backgroundColor: colors.bgMain,
					borderTopLeftRadius: '16px',
					borderTopRightRadius: '16px',
					display: 'flex',
					flexDirection: 'column',
					transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
					transition: 'transform 0.3s ease-out',
					paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
				}}
			>
				{/* Drag handle */}
				<div
					style={{
						display: 'flex',
						justifyContent: 'center',
						padding: '10px 0 4px',
						flexShrink: 0,
					}}
				>
					<div
						style={{
							width: '36px',
							height: '4px',
							borderRadius: '2px',
							backgroundColor: `${colors.textDim}40`,
						}}
					/>
				</div>

				{/* Header */}
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						padding: '8px 16px 12px',
						flexShrink: 0,
					}}
				>
					<h2
						style={{
							fontSize: '18px',
							fontWeight: 600,
							margin: 0,
							color: colors.textMain,
						}}
					>
						Start Group Chat
					</h2>
					<button
						onClick={handleClose}
						style={{
							width: '44px',
							height: '44px',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							borderRadius: '8px',
							backgroundColor: colors.bgSidebar,
							border: `1px solid ${colors.border}`,
							color: colors.textMain,
							cursor: 'pointer',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
						}}
						aria-label="Close setup sheet"
					>
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>

				{/* Scrollable content */}
				<div
					style={{
						flex: 1,
						overflowY: 'auto',
						overflowX: 'hidden',
						padding: '0 16px',
					}}
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
							ref={topicInputRef}
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
					<div style={{ marginBottom: '20px' }}>
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
				</div>

				{/* Start button */}
				<div
					style={{
						padding: '12px 16px 0',
						flexShrink: 0,
					}}
				>
					<button
						onClick={handleStart}
						disabled={!canStart}
						style={{
							width: '100%',
							padding: '14px 20px',
							borderRadius: '12px',
							backgroundColor: canStart ? colors.accent : `${colors.accent}40`,
							border: 'none',
							color: 'white',
							fontSize: '16px',
							fontWeight: 600,
							cursor: canStart ? 'pointer' : 'not-allowed',
							opacity: canStart ? 1 : 0.5,
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
							minHeight: '50px',
							transition: 'all 0.15s ease',
						}}
						aria-label="Start Group Chat"
					>
						Start Group Chat
					</button>
				</div>
			</div>
		</div>
	);
}

export default GroupChatSetupSheet;
