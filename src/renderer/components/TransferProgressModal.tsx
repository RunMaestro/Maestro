/**
 * TransferProgressModal - Modal showing progress during cross-agent context transfer
 *
 * Displays real-time progress through the transfer stages:
 * 1. Extracting context
 * 2. Grooming for target agent
 * 3. Creating target agent session
 * 4. Complete
 *
 * Features:
 * - Animated spinner with pulsing center
 * - Stage progression with checkmarks for completed stages
 * - Progress bar with percentage
 * - Elapsed time tracking
 * - Cancel functionality with confirmation
 * - Agent-specific messaging (source → target)
 *
 * Based on MergeProgressModal patterns, adapted for cross-agent transfer workflow.
 */

import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { X, Check, Loader2, AlertTriangle, ArrowRight, Wand2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Theme, ToolType } from '../types';
import type { GroomingProgress } from '../types/contextMerge';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { getAgentDisplayName } from '../services/contextGroomer';
import { CodeText } from './shared/CodeText';

/**
 * Progress stage definition for transfer display
 */
interface TransferStage {
	id: GroomingProgress['stage'];
	label: string;
	getActiveLabel: (targetAgent: string) => string;
}

/**
 * Stage definitions with their display labels for transfer operations.
 * Labels can be customized based on the target agent name.
 */
const TRANSFER_STAGES: TransferStage[] = [
	{
		id: 'collecting',
		label: 'Extract context',
		getActiveLabel: () => 'Extracting context...',
	},
	{
		id: 'grooming',
		label: 'Groom for target',
		getActiveLabel: (targetAgent) => `Grooming for ${targetAgent}...`,
	},
	{
		id: 'creating',
		label: 'Create session',
		getActiveLabel: (targetAgent) => `Creating ${targetAgent} session...`,
	},
	{
		id: 'complete',
		label: 'Complete',
		getActiveLabel: () => 'Complete',
	},
];

export interface TransferProgressModalProps {
	theme: Theme;
	isOpen: boolean;
	progress: GroomingProgress;
	sourceAgent: ToolType;
	targetAgent: ToolType;
	onCancel: () => void;
	/** Called when the transfer completes successfully and user clicks Done */
	onComplete?: () => void;
}

/**
 * Format milliseconds as a readable time string
 */
function formatElapsedTime(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;

	if (minutes > 0) {
		return `${minutes}m ${remainingSeconds}s`;
	}
	return `${remainingSeconds}s`;
}

/**
 * Elapsed time display component with auto-updating timer
 */
const ElapsedTimeDisplay = memo(
	({ startTime, textColor }: { startTime: number; textColor: string }) => {
		const [elapsedMs, setElapsedMs] = useState(Date.now() - startTime);

		useEffect(() => {
			const interval = setInterval(() => {
				setElapsedMs(Date.now() - startTime);
			}, 1000);
			return () => clearInterval(interval);
		}, [startTime]);

		return (
			<span className="font-mono text-xs" style={{ color: textColor }}>
				{formatElapsedTime(elapsedMs)}
			</span>
		);
	}
);

ElapsedTimeDisplay.displayName = 'ElapsedTimeDisplay';

/**
 * Animated spinner component
 */
function Spinner({ theme }: { theme: Theme }) {
	return (
		<div className="relative">
			<div
				className="w-12 h-12 rounded-full border-4 border-t-transparent animate-spin"
				style={{
					borderColor: theme.colors.border,
					borderTopColor: theme.colors.accent,
				}}
			/>
			{/* Wand icon in center */}
			<div className="absolute inset-0 flex items-center justify-center">
				<Wand2 className="w-5 h-5" style={{ color: theme.colors.accent }} />
			</div>
		</div>
	);
}

/**
 * Cancel confirmation dialog
 */
function CancelConfirmDialog({
	theme,
	onConfirm,
	onCancel,
}: {
	theme: Theme;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation('modals');
	return (
		<div
			className="absolute inset-0 flex items-center justify-center z-10"
			style={{ backgroundColor: `${theme.colors.bgMain}ee` }}
		>
			<div
				className="p-6 rounded-xl border shadow-xl max-w-sm"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
			>
				<div className="flex items-center gap-3 mb-4">
					<AlertTriangle className="w-5 h-5" style={{ color: theme.colors.warning }} />
					<h3 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
						{t('transfer_progress.cancel_transfer_title')}
					</h3>
				</div>
				<p className="text-xs mb-4" style={{ color: theme.colors.textDim }}>
					{t('transfer_progress.cancel_transfer_message')}
				</p>
				<div className="flex justify-end gap-2">
					<button
						type="button"
						onClick={onCancel}
						className="px-3 py-1.5 rounded text-xs border hover:bg-white/5 transition-colors"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						{t('transfer_progress.continue_transfer_button')}
					</button>
					<button
						type="button"
						onClick={onConfirm}
						className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
						style={{
							backgroundColor: theme.colors.error,
							color: '#fff',
						}}
					>
						{t('transfer_progress.cancel_transfer_button')}
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * Agent transfer indicator showing source → target
 */
function AgentTransferIndicator({
	theme,
	sourceAgent,
	targetAgent,
}: {
	theme: Theme;
	sourceAgent: ToolType;
	targetAgent: ToolType;
}) {
	const sourceName = getAgentDisplayName(sourceAgent);
	const targetName = getAgentDisplayName(targetAgent);

	return (
		<div className="flex items-center justify-center gap-2 mb-4">
			<CodeText
				className="text-xs font-medium px-2 py-1 rounded"
				style={{
					backgroundColor: theme.colors.bgMain,
					color: theme.colors.textDim,
				}}
			>
				{sourceName}
			</CodeText>
			<ArrowRight className="w-4 h-4" style={{ color: theme.colors.accent }} />
			<CodeText
				className="text-xs font-medium px-2 py-1 rounded"
				style={{
					backgroundColor: `${theme.colors.accent}20`,
					color: theme.colors.accent,
				}}
			>
				{targetName}
			</CodeText>
		</div>
	);
}

/**
 * TransferProgressModal Component
 *
 * Displays progress during cross-agent context transfer with:
 * - Source → Target agent indicator
 * - Stage-by-stage progress visualization
 * - Elapsed time tracking
 * - Cancellation with confirmation
 */
export function TransferProgressModal({
	theme,
	isOpen,
	progress,
	sourceAgent,
	targetAgent,
	onCancel,
	onComplete,
}: TransferProgressModalProps) {
	const { t } = useTranslation('modals');
	const { t: tA } = useTranslation('accessibility');
	// Track start time for elapsed time display
	const [startTime] = useState(() => Date.now());

	// Cancel confirmation state
	const [showCancelConfirm, setShowCancelConfirm] = useState(false);

	// Layer stack registration
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();
	const onCancelRef = useRef(onCancel);
	const onCompleteRef = useRef(onComplete);

	// Get target agent display name for stage labels
	const targetAgentName = useMemo(() => getAgentDisplayName(targetAgent), [targetAgent]);

	// Keep refs up to date
	useEffect(() => {
		onCancelRef.current = onCancel;
		onCompleteRef.current = onComplete;
	});

	// Handle escape key - show confirmation or close if complete
	const handleEscape = useCallback(() => {
		if (progress.stage === 'complete') {
			if (onCompleteRef.current) {
				onCompleteRef.current();
			} else {
				onCancelRef.current();
			}
		} else {
			setShowCancelConfirm(true);
		}
	}, [progress.stage]);

	// Register layer on mount
	useEffect(() => {
		if (!isOpen) return;

		layerIdRef.current = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.TRANSFER_PROGRESS,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Transfer Progress',
			onEscape: handleEscape,
		});

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [isOpen, registerLayer, unregisterLayer, handleEscape]);

	// Update handler when callbacks change
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, handleEscape);
		}
	}, [updateLayerHandler, handleEscape]);

	// Get the current stage index
	const currentStageIndex = useMemo(() => {
		return TRANSFER_STAGES.findIndex((s) => s.id === progress.stage);
	}, [progress.stage]);

	// Handle cancel confirmation
	const handleConfirmCancel = useCallback(() => {
		setShowCancelConfirm(false);
		onCancel();
	}, [onCancel]);

	const handleDismissCancel = useCallback(() => {
		setShowCancelConfirm(false);
	}, []);

	// Handle primary button click
	const handlePrimaryClick = useCallback(() => {
		if (progress.stage === 'complete') {
			if (onComplete) {
				onComplete();
			} else {
				onCancel();
			}
		} else {
			setShowCancelConfirm(true);
		}
	}, [progress.stage, onCancel, onComplete]);

	if (!isOpen) return null;

	const isComplete = progress.stage === 'complete';

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999]"
			role="dialog"
			aria-modal="true"
			aria-label={tA('modal.transfer_progress')}
			tabIndex={-1}
		>
			<div
				className="w-[450px] rounded-xl shadow-2xl border outline-none relative overflow-hidden"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Cancel Confirmation Overlay */}
				{showCancelConfirm && (
					<CancelConfirmDialog
						theme={theme}
						onConfirm={handleConfirmCancel}
						onCancel={handleDismissCancel}
					/>
				)}

				{/* Header */}
				<div
					className="p-4 border-b flex items-center justify-between"
					style={{ borderColor: theme.colors.border }}
				>
					<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
						{isComplete
							? t('transfer_progress.complete_title')
							: t('transfer_progress.transferring_title')}
					</h2>
					{isComplete && (
						<button
							type="button"
							onClick={() => onComplete?.() || onCancel()}
							className="p-1 rounded hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							aria-label={tA('modal.close')}
						>
							<X className="w-4 h-4" />
						</button>
					)}
				</div>

				{/* Content */}
				<div className="p-6">
					{/* Agent Transfer Indicator */}
					<AgentTransferIndicator
						theme={theme}
						sourceAgent={sourceAgent}
						targetAgent={targetAgent}
					/>

					{/* Spinner or Success Icon */}
					<div className="flex justify-center mb-6">
						{isComplete ? (
							<div
								className="w-12 h-12 rounded-full flex items-center justify-center"
								style={{ backgroundColor: `${theme.colors.success}20` }}
							>
								<Check className="w-6 h-6" style={{ color: theme.colors.success }} />
							</div>
						) : (
							<Spinner theme={theme} />
						)}
					</div>

					{/* Current Status Message */}
					<div className="text-center mb-6">
						<p className="text-sm font-medium mb-1" style={{ color: theme.colors.textMain }}>
							{progress.message ||
								TRANSFER_STAGES[currentStageIndex]?.getActiveLabel(targetAgentName) ||
								'Processing...'}
						</p>
						{!isComplete && (
							<div
								className="flex items-center justify-center gap-2 text-xs"
								style={{ color: theme.colors.textDim }}
							>
								<span>{t('transfer_progress.elapsed_label')}:</span>
								<ElapsedTimeDisplay startTime={startTime} textColor={theme.colors.textMain} />
							</div>
						)}
					</div>

					{/* Progress Bar */}
					<div className="mb-6">
						<div className="flex justify-between text-xs mb-1">
							<span style={{ color: theme.colors.textDim }}>
								{t('transfer_progress.progress_label')}
							</span>
							<span style={{ color: theme.colors.textMain }}>{progress.progress}%</span>
						</div>
						<div
							className="h-2 rounded-full overflow-hidden"
							style={{ backgroundColor: theme.colors.bgMain }}
						>
							<div
								className="h-full rounded-full transition-all duration-300 ease-out"
								style={{
									width: `${progress.progress}%`,
									backgroundColor: isComplete ? theme.colors.success : theme.colors.accent,
								}}
							/>
						</div>
					</div>

					{/* Stage Progress */}
					<div className="space-y-2">
						{TRANSFER_STAGES.map((stage, index) => {
							const isActive = index === currentStageIndex;
							const isCompleted = index < currentStageIndex;

							return (
								<div key={stage.id} className="flex items-center gap-3">
									{/* Stage Indicator */}
									<div className="w-6 h-6 flex items-center justify-center shrink-0">
										{isCompleted ? (
											<div
												className="w-5 h-5 rounded-full flex items-center justify-center"
												style={{ backgroundColor: theme.colors.success }}
											>
												<Check className="w-3 h-3" style={{ color: '#fff' }} />
											</div>
										) : isActive ? (
											<Loader2
												className="w-5 h-5 animate-spin"
												style={{ color: theme.colors.accent }}
											/>
										) : (
											<div
												className="w-5 h-5 rounded-full border-2"
												style={{ borderColor: theme.colors.border }}
											/>
										)}
									</div>

									{/* Stage Label */}
									<span
										className="text-xs"
										style={{
											color: isActive
												? theme.colors.textMain
												: isCompleted
													? theme.colors.success
													: theme.colors.textDim,
											fontWeight: isActive ? 500 : 400,
										}}
									>
										{isActive ? stage.getActiveLabel(targetAgentName) : stage.label}
									</span>
								</div>
							);
						})}
					</div>
				</div>

				{/* Footer */}
				<div className="p-4 border-t flex justify-end" style={{ borderColor: theme.colors.border }}>
					<button
						type="button"
						onClick={handlePrimaryClick}
						className="px-4 py-2 rounded text-sm border transition-colors"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							backgroundColor: isComplete ? theme.colors.accent : 'transparent',
							...(isComplete && {
								borderColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}),
						}}
					>
						{isComplete ? t('transfer_progress.done_button') : t('transfer_progress.cancel_button')}
					</button>
				</div>
			</div>

			{/* Animation styles */}
			<style>{`
        @keyframes bounce-dot {
          0%, 100% {
            transform: translateY(0);
          }
          50% {
            transform: translateY(-6px);
          }
        }
      `}</style>
		</div>
	);
}

export default TransferProgressModal;
