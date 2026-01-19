/**
 * SummarizeProgressModal - Modal showing progress during context summarization
 *
 * Displays real-time progress through the summarization stages:
 * 1. Extracting context
 * 2. Summarizing with AI
 * 3. Creating new tab
 * 4. Complete
 *
 * Features:
 * - Animated spinner with pulsing center
 * - Stage progression with checkmarks for completed stages
 * - Progress bar with percentage
 * - Elapsed time tracking
 * - Token reduction statistics
 * - Cancel functionality with confirmation
 */

import React, { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { X, Check, Loader2, AlertTriangle, TrendingDown, Wand2 } from 'lucide-react';
import type { Theme } from '../types';
import type { SummarizeProgress, SummarizeResult } from '../types/contextMerge';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

/**
 * Progress stage definition for display
 */
interface ProgressStage {
	id: SummarizeProgress['stage'];
	label: string;
	activeLabel: string;
}

/**
 * Stage definitions with their display labels
 */
const STAGES: ProgressStage[] = [
	{ id: 'extracting', label: 'Extract context', activeLabel: 'Extracting context...' },
	{ id: 'summarizing', label: 'Summarize with AI', activeLabel: 'Summarizing with AI...' },
	{ id: 'creating', label: 'Create new tab', activeLabel: 'Creating new tab...' },
	{ id: 'complete', label: 'Complete', activeLabel: 'Complete' },
];

export interface SummarizeProgressModalProps {
	theme: Theme;
	isOpen: boolean;
	progress: SummarizeProgress | null;
	result: SummarizeResult | null;
	onCancel: () => void;
	onComplete: () => void;
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
						Cancel Compaction?
					</h3>
				</div>
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
						No
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
						Yes
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * Token reduction stats display
 */
function TokenReductionStats({ result, theme }: { result: SummarizeResult; theme: Theme }) {
	return (
		<div
			className="mt-4 p-3 rounded-lg border"
			style={{
				backgroundColor: `${theme.colors.success}10`,
				borderColor: `${theme.colors.success}30`,
			}}
		>
			<div className="flex items-center gap-2 mb-2">
				<TrendingDown className="w-4 h-4" style={{ color: theme.colors.success }} />
				<span className="text-xs font-medium" style={{ color: theme.colors.success }}>
					Context Reduced by {result.reductionPercent}%
				</span>
			</div>
			<div className="grid grid-cols-2 gap-2 text-xs" style={{ color: theme.colors.textDim }}>
				<div>
					<span className="text-[10px] uppercase">Before</span>
					<div className="font-mono" style={{ color: theme.colors.textMain }}>
						~{result.originalTokens.toLocaleString()} tokens
					</div>
				</div>
				<div>
					<span className="text-[10px] uppercase">After</span>
					<div className="font-mono" style={{ color: theme.colors.textMain }}>
						~{result.compactedTokens.toLocaleString()} tokens
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * SummarizeProgressModal Component
 */
export function SummarizeProgressModal({
	theme,
	isOpen,
	progress,
	result,
	onCancel,
	onComplete,
}: SummarizeProgressModalProps) {
	// Track start time for elapsed time display
	const [startTime] = useState(() => Date.now());

	// Cancel confirmation state
	const [showCancelConfirm, setShowCancelConfirm] = useState(false);

	// Layer stack registration
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();
	const onCancelRef = useRef(onCancel);
	const onCompleteRef = useRef(onComplete);

	// Keep refs up to date
	useEffect(() => {
		onCancelRef.current = onCancel;
		onCompleteRef.current = onComplete;
	});

	// Handle escape key - show confirmation or close
	const handleEscape = useCallback(() => {
		if (progress?.stage === 'complete') {
			onCompleteRef.current();
		} else {
			setShowCancelConfirm(true);
		}
	}, [progress?.stage]);

	// Register layer on mount
	useEffect(() => {
		if (!isOpen) return;

		layerIdRef.current = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.SUMMARIZE_PROGRESS || 683, // Fallback if not defined
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Summarization Progress',
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
		if (!progress) return 0;
		return STAGES.findIndex((s) => s.id === progress.stage);
	}, [progress]);

	// Handle cancel confirmation
	const handleConfirmCancel = useCallback(() => {
		setShowCancelConfirm(false);
		onCancel();
	}, [onCancel]);

	const handleDismissCancel = useCallback(() => {
		setShowCancelConfirm(false);
	}, []);

	// Handle cancel/done button click
	const handleButtonClick = useCallback(() => {
		if (progress?.stage === 'complete') {
			onComplete();
		} else {
			setShowCancelConfirm(true);
		}
	}, [progress?.stage, onComplete]);

	if (!isOpen) return null;

	const isComplete = progress?.stage === 'complete';
	const progressValue = progress?.progress ?? 0;

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999]"
			role="dialog"
			aria-modal="true"
			aria-label="Summarization Progress"
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
						{isComplete ? 'Summarization Complete' : 'Summarizing Context...'}
					</h2>
					{isComplete && (
						<button
							type="button"
							onClick={onComplete}
							className="p-1 rounded hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
							aria-label="Close modal"
						>
							<X className="w-4 h-4" />
						</button>
					)}
				</div>

				{/* Content */}
				<div className="p-6">
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
							{progress?.message || STAGES[currentStageIndex]?.activeLabel || 'Processing...'}
						</p>
						{!isComplete && (
							<div
								className="flex items-center justify-center gap-2 text-xs"
								style={{ color: theme.colors.textDim }}
							>
								<span>Elapsed:</span>
								<ElapsedTimeDisplay startTime={startTime} textColor={theme.colors.textMain} />
							</div>
						)}
					</div>

					{/* Progress Bar */}
					<div className="mb-6">
						<div className="flex justify-between text-xs mb-1">
							<span style={{ color: theme.colors.textDim }}>Progress</span>
							<span style={{ color: theme.colors.textMain }}>{progressValue}%</span>
						</div>
						<div
							className="h-2 rounded-full overflow-hidden"
							style={{ backgroundColor: theme.colors.bgMain }}
						>
							<div
								className="h-full rounded-full transition-all duration-300 ease-out"
								style={{
									width: `${progressValue}%`,
									backgroundColor: isComplete ? theme.colors.success : theme.colors.accent,
								}}
							/>
						</div>
					</div>

					{/* Stage Progress */}
					<div className="space-y-2">
						{STAGES.map((stage, index) => {
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
										{isActive ? stage.activeLabel : stage.label}
									</span>
								</div>
							);
						})}
					</div>

					{/* Token Reduction Stats (on completion) */}
					{isComplete && result && result.success && (
						<TokenReductionStats result={result} theme={theme} />
					)}

					{/* Error message (on failure) */}
					{isComplete && result && !result.success && result.error && (
						<div
							className="mt-4 p-3 rounded-lg border"
							style={{
								backgroundColor: `${theme.colors.error}10`,
								borderColor: `${theme.colors.error}30`,
							}}
						>
							<div className="flex items-center gap-2">
								<AlertTriangle className="w-4 h-4" style={{ color: theme.colors.error }} />
								<span className="text-xs" style={{ color: theme.colors.error }}>
									{result.error}
								</span>
							</div>
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="p-4 border-t flex justify-end" style={{ borderColor: theme.colors.border }}>
					<button
						type="button"
						onClick={handleButtonClick}
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
						{isComplete ? 'Done' : 'Cancel'}
					</button>
				</div>
			</div>
		</div>
	);
}

export default SummarizeProgressModal;
