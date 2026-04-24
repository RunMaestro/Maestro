/**
 * ContextManagementSheet component for Maestro mobile web interface
 *
 * Uses `ResponsiveModal` so it renders as a bottom sheet on phones and a
 * centered dialog at tablet+. Supports context management operations:
 * merge, transfer, and summarize agent contexts. The "Execute" primary
 * action lives in the modal footer.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { ResponsiveModal, Button } from '../components';
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
	isOpen: boolean;
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
	isOpen,
	sessions,
	currentSessionId,
	onClose,
	sendRequest,
}: ContextManagementSheetProps) {
	const colors = useThemeColors();
	const [selectedOp, setSelectedOp] = useState<ContextOperation>(null);
	const [sourceId, setSourceId] = useState<string>(currentSessionId);
	const [targetId, setTargetId] = useState<string>('');
	const [executionState, setExecutionState] = useState<ExecutionState>('idle');
	const [progress, setProgress] = useState(0);
	const [resultMessage, setResultMessage] = useState('');
	const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout>>();

	// Guard close paths (X, Escape, backdrop, auto-close) during execution so the
	// operation can't be abandoned mid-flight. Matches the legacy sheet behaviour
	// where the close button was disabled and Escape / backdrop were no-ops while
	// `executionState === 'executing'`.
	const handleClose = useCallback(() => {
		if (executionState === 'executing') return;
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onClose();
	}, [onClose, executionState]);

	// Cleanup timers on unmount
	useEffect(() => {
		return () => {
			if (autoCloseTimerRef.current) {
				clearTimeout(autoCloseTimerRef.current);
			}
		};
	}, []);

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
				autoCloseTimerRef.current = setTimeout(() => onClose(), 2000);
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
	}, [canExecute, selectedOp, sourceId, targetId, currentSessionId, sendRequest, onClose]);

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
		<ResponsiveModal
			isOpen={isOpen}
			onClose={handleClose}
			title="Context Management"
			zIndex={220}
			footer={
				<Button
					variant="primary"
					fullWidth
					size="lg"
					onClick={handleExecute}
					disabled={!canExecute}
					aria-label={`Execute ${selectedOp || 'operation'}`}
				>
					{isExecuting
						? 'Executing...'
						: selectedOp
							? `Execute ${selectedOp.charAt(0).toUpperCase() + selectedOp.slice(1)}`
							: 'Select an Operation'}
				</Button>
			}
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
		</ResponsiveModal>
	);
}

export default ContextManagementSheet;
