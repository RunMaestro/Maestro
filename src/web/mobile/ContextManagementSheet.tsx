/**
 * ContextManagementSheet component for Maestro mobile web interface
 *
 * Bottom sheet modal for context management operations:
 * merge, transfer, and summarize agent contexts.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import type { Session } from '../hooks/useSessions';

type ContextOperation = 'merge' | 'transfer' | 'summarize' | null;

interface OperationDef {
	id: ContextOperation & string;
	icon: string;
	label: string;
	description: string;
}

const OPERATIONS: OperationDef[] = [
	{
		id: 'merge',
		icon: '\u{1F500}',
		label: 'Merge',
		description: 'Combine context from two agents',
	},
	{
		id: 'transfer',
		icon: '\u{1F4E4}',
		label: 'Transfer',
		description: 'Send context to another agent',
	},
	{
		id: 'summarize',
		icon: '\u{1F4DD}',
		label: 'Summarize',
		description: "Compress current agent's context",
	},
];

type ExecutionState = 'idle' | 'executing' | 'success' | 'failure';

export interface ContextManagementSheetProps {
	sessions: Session[];
	currentSessionId: string;
	onClose: () => void;
	sendRequest: <T = unknown>(
		type: string,
		payload?: Record<string, unknown>,
		timeoutMs?: number
	) => Promise<T>;
}

export function ContextManagementSheet({
	sessions,
	currentSessionId,
	onClose,
	sendRequest,
}: ContextManagementSheetProps) {
	const colors = useThemeColors();
	const [isVisible, setIsVisible] = useState(false);
	const [selectedOp, setSelectedOp] = useState<ContextOperation>(null);
	const [sourceId, setSourceId] = useState<string>(currentSessionId);
	const [targetId, setTargetId] = useState<string>('');
	const [executionState, setExecutionState] = useState<ExecutionState>('idle');
	const [progress, setProgress] = useState(0);
	const [resultMessage, setResultMessage] = useState('');
	const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout>>();

	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsVisible(false);
		setTimeout(() => onClose(), 300);
	}, [onClose]);

	// Animate in on mount
	useEffect(() => {
		requestAnimationFrame(() => setIsVisible(true));
	}, []);

	// Close on escape key (but not during execution)
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && executionState !== 'executing') {
				handleClose();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [handleClose, executionState]);

	// Cleanup timers on unmount
	useEffect(() => {
		return () => {
			if (autoCloseTimerRef.current) {
				clearTimeout(autoCloseTimerRef.current);
			}
		};
	}, []);

	const handleBackdropTap = useCallback(
		(e: React.MouseEvent) => {
			if (e.target === e.currentTarget && executionState !== 'executing') {
				handleClose();
			}
		},
		[handleClose, executionState]
	);

	const handleSelectOperation = useCallback((op: ContextOperation) => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setSelectedOp(op);
		// Reset selections when switching
		setTargetId('');
		setExecutionState('idle');
		setResultMessage('');
	}, []);

	// Pre-select source as current session for transfer
	useEffect(() => {
		if (selectedOp === 'transfer') {
			setSourceId(currentSessionId);
		}
	}, [selectedOp, currentSessionId]);

	const otherSessions = sessions.filter((s) => s.id !== sourceId);

	const canExecute = (() => {
		if (executionState === 'executing') return false;
		if (!selectedOp) return false;
		if (selectedOp === 'summarize') return true;
		if (!targetId) return false;
		if (sourceId === targetId) return false;
		return true;
	})();

	const handleExecute = useCallback(async () => {
		if (!canExecute || !selectedOp) return;
		setExecutionState('executing');
		setProgress(0);
		triggerHaptic(HAPTIC_PATTERNS.send);

		// Simulate progress while waiting
		const progressInterval = setInterval(() => {
			setProgress((prev) => Math.min(prev + 5, 90));
		}, 500);

		try {
			let result: { success: boolean };
			const timeout = selectedOp === 'summarize' ? 60000 : 30000;

			if (selectedOp === 'merge') {
				result = await sendRequest<{ success: boolean }>(
					'merge_context',
					{
						sourceSessionId: sourceId,
						targetSessionId: targetId,
					},
					timeout
				);
			} else if (selectedOp === 'transfer') {
				result = await sendRequest<{ success: boolean }>(
					'transfer_context',
					{
						sourceSessionId: sourceId,
						targetSessionId: targetId,
					},
					timeout
				);
			} else {
				result = await sendRequest<{ success: boolean }>(
					'summarize_context',
					{
						sessionId: currentSessionId,
					},
					timeout
				);
			}

			clearInterval(progressInterval);
			setProgress(100);

			if (result.success) {
				setExecutionState('success');
				setResultMessage(
					`${selectedOp.charAt(0).toUpperCase() + selectedOp.slice(1)} completed successfully`
				);
				triggerHaptic(HAPTIC_PATTERNS.success);
				autoCloseTimerRef.current = setTimeout(() => handleClose(), 2000);
			} else {
				setExecutionState('failure');
				setResultMessage(`${selectedOp.charAt(0).toUpperCase() + selectedOp.slice(1)} failed`);
				triggerHaptic(HAPTIC_PATTERNS.error);
			}
		} catch {
			clearInterval(progressInterval);
			setExecutionState('failure');
			setProgress(0);
			setResultMessage('Operation failed — check connection');
			triggerHaptic(HAPTIC_PATTERNS.error);
		}
	}, [canExecute, selectedOp, sourceId, targetId, currentSessionId, sendRequest, handleClose]);

	const isExecuting = executionState === 'executing';

	const getSessionLabel = (session: Session) => session.name || session.id.slice(0, 8);

	const getStatusColor = (state: string) => {
		switch (state) {
			case 'idle':
				return colors.success;
			case 'busy':
				return colors.warning;
			case 'error':
				return colors.error;
			default:
				return colors.warning;
		}
	};

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
						Context Management
					</h2>
					<button
						onClick={handleClose}
						disabled={isExecuting}
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
							cursor: isExecuting ? 'not-allowed' : 'pointer',
							opacity: isExecuting ? 0.5 : 1,
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
						}}
						aria-label="Close context management"
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
					{/* Operation selector */}
					<div style={{ marginBottom: '20px' }}>
						<span
							style={{
								display: 'block',
								fontSize: '13px',
								fontWeight: 600,
								color: colors.textDim,
								textTransform: 'uppercase',
								letterSpacing: '0.5px',
								marginBottom: '10px',
							}}
						>
							Operation
						</span>
						<div
							style={{
								display: 'flex',
								flexDirection: 'column',
								gap: '8px',
							}}
						>
							{OPERATIONS.map((op) => {
								const isSelected = selectedOp === op.id;
								return (
									<button
										key={op.id}
										onClick={() => handleSelectOperation(op.id)}
										disabled={isExecuting}
										style={{
											display: 'flex',
											alignItems: 'center',
											gap: '12px',
											padding: '14px 16px',
											borderRadius: '10px',
											border: `2px solid ${isSelected ? colors.accent : colors.border}`,
											backgroundColor: isSelected ? `${colors.accent}10` : colors.bgSidebar,
											color: colors.textMain,
											width: '100%',
											textAlign: 'left',
											cursor: isExecuting ? 'not-allowed' : 'pointer',
											opacity: isExecuting ? 0.6 : 1,
											touchAction: 'manipulation',
											WebkitTapHighlightColor: 'transparent',
											outline: 'none',
											minHeight: '44px',
											transition: 'all 0.15s ease',
										}}
										aria-pressed={isSelected}
									>
										<span style={{ fontSize: '24px', flexShrink: 0 }}>{op.icon}</span>
										<div style={{ flex: 1, minWidth: 0 }}>
											<div
												style={{
													fontSize: '15px',
													fontWeight: 600,
												}}
											>
												{op.label}
											</div>
											<div
												style={{
													fontSize: '12px',
													color: colors.textDim,
													marginTop: '2px',
												}}
											>
												{op.description}
											</div>
										</div>
									</button>
								);
							})}
						</div>
					</div>

					{/* Agent selector (for merge and transfer) */}
					{selectedOp && selectedOp !== 'summarize' && (
						<div style={{ marginBottom: '20px' }}>
							{/* Source selector */}
							<div style={{ marginBottom: '16px' }}>
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
									Source
								</label>
								<div
									style={{
										display: 'flex',
										flexDirection: 'column',
										gap: '6px',
									}}
								>
									{sessions.map((session) => {
										const isSelected = sourceId === session.id;
										return (
											<button
												key={session.id}
												onClick={() => {
													if (isExecuting) return;
													triggerHaptic(HAPTIC_PATTERNS.tap);
													setSourceId(session.id);
													// Clear target if it would conflict
													if (targetId === session.id) setTargetId('');
												}}
												disabled={isExecuting}
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
													cursor: isExecuting ? 'not-allowed' : 'pointer',
													touchAction: 'manipulation',
													WebkitTapHighlightColor: 'transparent',
													outline: 'none',
													minHeight: '44px',
													transition: 'all 0.15s ease',
												}}
												aria-pressed={isSelected}
											>
												{/* Status dot */}
												<div
													style={{
														width: '8px',
														height: '8px',
														borderRadius: '50%',
														backgroundColor: getStatusColor(session.state),
														flexShrink: 0,
													}}
												/>
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
														{getSessionLabel(session)}
													</div>
												</div>
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
								</div>
							</div>

							{/* Target selector */}
							<div>
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
									Target
								</label>
								<div
									style={{
										display: 'flex',
										flexDirection: 'column',
										gap: '6px',
									}}
								>
									{otherSessions.length === 0 && (
										<div
											style={{
												textAlign: 'center',
												padding: '16px',
												color: colors.textDim,
												fontSize: '13px',
											}}
										>
											No other agents available
										</div>
									)}
									{otherSessions.map((session) => {
										const isSelected = targetId === session.id;
										return (
											<button
												key={session.id}
												onClick={() => {
													if (isExecuting) return;
													triggerHaptic(HAPTIC_PATTERNS.tap);
													setTargetId(session.id);
												}}
												disabled={isExecuting}
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
													cursor: isExecuting ? 'not-allowed' : 'pointer',
													touchAction: 'manipulation',
													WebkitTapHighlightColor: 'transparent',
													outline: 'none',
													minHeight: '44px',
													transition: 'all 0.15s ease',
												}}
												aria-pressed={isSelected}
											>
												{/* Status dot */}
												<div
													style={{
														width: '8px',
														height: '8px',
														borderRadius: '50%',
														backgroundColor: getStatusColor(session.state),
														flexShrink: 0,
													}}
												/>
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
														{getSessionLabel(session)}
													</div>
												</div>
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
								</div>
							</div>
						</div>
					)}

					{/* Summarize info */}
					{selectedOp === 'summarize' && (
						<div
							style={{
								marginBottom: '20px',
								padding: '14px 16px',
								borderRadius: '10px',
								backgroundColor: colors.bgSidebar,
								border: `1px solid ${colors.border}`,
							}}
						>
							<div
								style={{
									fontSize: '13px',
									color: colors.textDim,
									lineHeight: '1.5',
								}}
							>
								This will compress the context of the current agent
								<strong style={{ color: colors.textMain }}>
									{' '}
									{getSessionLabel(sessions.find((s) => s.id === currentSessionId) || sessions[0])}
								</strong>{' '}
								to reduce token usage while preserving key information.
							</div>
						</div>
					)}

					{/* Progress indicator */}
					{isExecuting && (
						<div style={{ marginBottom: '20px' }}>
							<div
								style={{
									fontSize: '13px',
									fontWeight: 600,
									color: colors.textDim,
									textTransform: 'uppercase',
									letterSpacing: '0.5px',
									marginBottom: '8px',
								}}
							>
								{selectedOp && selectedOp.charAt(0).toUpperCase() + selectedOp.slice(1)}ing...
							</div>
							<div
								style={{
									width: '100%',
									height: '6px',
									borderRadius: '3px',
									backgroundColor: `${colors.textDim}20`,
									overflow: 'hidden',
								}}
							>
								<div
									style={{
										width: `${progress}%`,
										height: '100%',
										borderRadius: '3px',
										backgroundColor: colors.accent,
										transition: 'width 0.3s ease',
									}}
								/>
							</div>
						</div>
					)}

					{/* Result message */}
					{resultMessage && !isExecuting && (
						<div
							style={{
								marginBottom: '20px',
								padding: '12px 16px',
								borderRadius: '10px',
								backgroundColor:
									executionState === 'success' ? `${colors.success}15` : `${colors.error}15`,
								border: `1px solid ${executionState === 'success' ? colors.success : colors.error}`,
							}}
						>
							<div
								style={{
									fontSize: '14px',
									fontWeight: 500,
									color: executionState === 'success' ? colors.success : colors.error,
								}}
							>
								{resultMessage}
							</div>
						</div>
					)}
				</div>

				{/* Execute button */}
				<div
					style={{
						padding: '12px 16px 0',
						flexShrink: 0,
					}}
				>
					<button
						onClick={handleExecute}
						disabled={!canExecute}
						style={{
							width: '100%',
							padding: '14px 20px',
							borderRadius: '12px',
							backgroundColor: canExecute ? colors.accent : `${colors.accent}40`,
							border: 'none',
							color: 'white',
							fontSize: '16px',
							fontWeight: 600,
							cursor: canExecute ? 'pointer' : 'not-allowed',
							opacity: canExecute ? 1 : 0.5,
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
							minHeight: '50px',
							transition: 'all 0.15s ease',
						}}
						aria-label={`Execute ${selectedOp || 'operation'}`}
					>
						{isExecuting
							? 'Executing...'
							: selectedOp
								? `Execute ${selectedOp.charAt(0).toUpperCase() + selectedOp.slice(1)}`
								: 'Select an Operation'}
					</button>
				</div>
			</div>
		</div>
	);
}

export default ContextManagementSheet;
