/**
 * FirstRunCelebration.tsx
 *
 * Celebratory modal that appears when the user completes their first Auto Run.
 * Features confetti animation, run duration display, encouraging messaging,
 * and next steps guidance.
 *
 * Special "Standing Ovation" variation appears if the first Auto Run exceeds 15 minutes.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import {
	PartyPopper,
	Rocket,
	Clock,
	Star,
	Trophy,
	FileText,
	ArrowRight,
	Sparkles,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import type { Theme } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

// 15 minutes in milliseconds - threshold for "Standing Ovation" variation
const STANDING_OVATION_THRESHOLD_MS = 15 * 60 * 1000;

// Confetti colors - celebratory palette (defined outside component to avoid recreating on each render)
const CONFETTI_COLORS = [
	'#FFD700', // Gold
	'#FF6B6B', // Red
	'#4ECDC4', // Teal
	'#45B7D1', // Blue
	'#FFA726', // Orange
	'#BA68C8', // Purple
	'#F48FB1', // Pink
	'#FFEAA7', // Yellow
];

interface FirstRunCelebrationProps {
	theme: Theme;
	/** Duration of the first Auto Run in milliseconds */
	elapsedTimeMs: number;
	/** Number of tasks completed */
	completedTasks: number;
	/** Total number of tasks */
	totalTasks: number;
	/** Callback when modal is dismissed */
	onClose: () => void;
	/** Callback to open leaderboard registration */
	onOpenLeaderboardRegistration?: () => void;
	/** Whether the user is already registered for the leaderboard */
	isLeaderboardRegistered?: boolean;
	/** Whether confetti animations are disabled by user preference */
	disableConfetti?: boolean;
}

/**
 * Format milliseconds into a human-readable duration string
 */
function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (hours > 0) {
		const remainingMinutes = minutes % 60;
		if (remainingMinutes > 0) {
			return `${hours} hour${hours > 1 ? 's' : ''} ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}`;
		}
		return `${hours} hour${hours > 1 ? 's' : ''}`;
	}

	if (minutes > 0) {
		const remainingSeconds = seconds % 60;
		if (remainingSeconds > 0) {
			return `${minutes} minute${minutes > 1 ? 's' : ''} ${remainingSeconds} second${remainingSeconds > 1 ? 's' : ''}`;
		}
		return `${minutes} minute${minutes > 1 ? 's' : ''}`;
	}

	return `${seconds} second${seconds > 1 ? 's' : ''}`;
}

/**
 * FirstRunCelebration - Modal celebrating the user's first Auto Run completion
 */
export function FirstRunCelebration({
	theme,
	elapsedTimeMs,
	completedTasks,
	totalTasks,
	onClose,
	onOpenLeaderboardRegistration,
	isLeaderboardRegistered,
	disableConfetti = false,
}: FirstRunCelebrationProps): JSX.Element {
	const containerRef = useRef<HTMLDivElement>(null);
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	const [isClosing, setIsClosing] = useState(false);

	// Determine if this qualifies for "Standing Ovation" variation
	const isStandingOvation = elapsedTimeMs >= STANDING_OVATION_THRESHOLD_MS;

	// Colors
	const goldColor = '#FFD700';
	const purpleAccent = theme.colors.accent;

	// Z-index layering: backdrop (99997) < confetti (99998) < modal (99999)
	const CONFETTI_Z_INDEX = 99998;

	// Fire confetti burst
	const fireConfetti = useCallback(() => {
		// Skip if disabled by user preference
		if (disableConfetti) return;

		// Check for reduced motion preference
		const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (prefersReducedMotion) return;

		const defaults = {
			particleCount: isStandingOvation ? 600 : 400,
			angle: 90,
			spread: 100,
			startVelocity: isStandingOvation ? 80 : 60,
			gravity: 0.8,
			decay: 0.9,
			drift: 1.5,
			scalar: 1.2,
			ticks: 300,
			flat: false,
			shapes: ['circle', 'star', 'square'] as ('circle' | 'star' | 'square')[],
			colors: CONFETTI_COLORS,
			zIndex: CONFETTI_Z_INDEX,
			disableForReducedMotion: true,
		};

		// Center burst
		confetti({
			...defaults,
			origin: { x: 0.5, y: 1 },
		});

		// Left burst
		confetti({
			...defaults,
			particleCount: defaults.particleCount / 2,
			origin: { x: 0.1, y: 1 },
		});

		// Right burst
		confetti({
			...defaults,
			particleCount: defaults.particleCount / 2,
			origin: { x: 0.9, y: 1 },
		});

		// Extra star burst for standing ovation
		if (isStandingOvation) {
			setTimeout(() => {
				confetti({
					...defaults,
					particleCount: 100,
					shapes: ['star'] as 'star'[],
					colors: [goldColor, '#FFA500', '#FFD700'],
					origin: { x: 0.5, y: 0.3 },
					startVelocity: 40,
					spread: 360,
				});
			}, 500);
		}
	}, [isStandingOvation, goldColor, disableConfetti]);

	// Fire confetti on mount
	useEffect(() => {
		fireConfetti();
	}, []);

	// Handle close with confetti
	const handleClose = useCallback(() => {
		if (isClosing) return;
		setIsClosing(true);

		// Fire closing confetti
		fireConfetti();

		// Wait then close
		setTimeout(() => {
			onCloseRef.current();
		}, 1000);
	}, [isClosing, fireConfetti]);

	// Handle keyboard events
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === 'Escape') {
				e.preventDefault();
				handleClose();
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [handleClose]);

	// Register with layer stack
	useEffect(() => {
		const id = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.STANDING_OVATION, // Use same high priority as standing ovation
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'First Auto Run Celebration',
			onEscape: () => handleClose(),
		});
		layerIdRef.current = id;

		containerRef.current?.focus();

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [registerLayer, unregisterLayer, handleClose]);

	// Update escape handler when handleClose changes
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, handleClose);
		}
	}, [updateLayerHandler, handleClose]);

	return (
		<>
			{/* Dark backdrop */}
			<div
				className="fixed inset-0 z-[99997] animate-in fade-in duration-500"
				onClick={handleClose}
				style={{
					backgroundColor: 'rgba(0, 0, 0, 0.85)',
				}}
			/>

			{/* Confetti renders at z-index 99998 */}

			{/* Modal container */}
			<div
				ref={containerRef}
				className="fixed inset-0 flex items-center justify-center z-[99999] pointer-events-none p-4"
				role="dialog"
				aria-modal="true"
				aria-label="First Auto Run Celebration"
				tabIndex={-1}
			>
				{/* Main content card */}
				<div
					className={`relative max-w-lg w-full rounded-2xl shadow-2xl overflow-hidden transition-all duration-500 pointer-events-auto ${
						isClosing ? 'opacity-0 scale-95' : 'animate-in zoom-in-95'
					}`}
					onClick={(e) => e.stopPropagation()}
					style={{
						backgroundColor: theme.colors.bgSidebar,
						border: `2px solid ${isStandingOvation ? goldColor : purpleAccent}`,
						boxShadow: `0 0 40px ${isStandingOvation ? goldColor : purpleAccent}40`,
					}}
				>
					{/* Header with glow */}
					<div
						className="relative px-8 pt-8 pb-4 text-center"
						style={{
							background: isStandingOvation
								? `linear-gradient(180deg, ${goldColor}30 0%, transparent 100%)`
								: `linear-gradient(180deg, ${purpleAccent}20 0%, transparent 100%)`,
						}}
					>
						{/* Icon */}
						<div className="flex justify-center mb-4">
							<div
								className="relative p-4 rounded-full animate-bounce"
								style={{
									background: isStandingOvation
										? `linear-gradient(135deg, ${goldColor} 0%, #FFA500 100%)`
										: `linear-gradient(135deg, ${purpleAccent} 0%, ${theme.colors.success} 100%)`,
									boxShadow: `0 0 30px ${isStandingOvation ? goldColor : purpleAccent}60`,
								}}
							>
								{isStandingOvation ? (
									<Trophy className="w-10 h-10 text-white" />
								) : (
									<PartyPopper className="w-10 h-10 text-white" />
								)}
							</div>
						</div>

						{/* Title */}
						<h1
							className="text-3xl font-bold tracking-wide mb-2"
							style={{
								color: isStandingOvation ? goldColor : theme.colors.textMain,
								textShadow: isStandingOvation ? `0 0 20px ${goldColor}60` : undefined,
							}}
						>
							{isStandingOvation ? 'Standing Ovation!' : 'Congratulations!'}
						</h1>

						{isStandingOvation && (
							<div className="flex items-center justify-center gap-2 mb-2">
								<Star className="w-4 h-4" style={{ color: goldColor }} />
								<span className="text-sm font-medium" style={{ color: goldColor }}>
									Your AI worked autonomously for over 15 minutes!
								</span>
								<Star className="w-4 h-4" style={{ color: goldColor }} />
							</div>
						)}

						<p className="text-lg" style={{ color: theme.colors.textMain }}>
							You just completed your first Auto Run
						</p>
					</div>

					{/* Duration display */}
					<div className="px-8 pb-6">
						<div
							className="flex items-center justify-center gap-3 p-4 rounded-lg mb-6"
							style={{
								backgroundColor: theme.colors.bgActivity,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<Clock className="w-5 h-5" style={{ color: purpleAccent }} />
							<span
								className="font-mono text-lg font-bold"
								style={{ color: theme.colors.textMain }}
							>
								{formatDuration(elapsedTimeMs)}
							</span>
							<span className="text-sm" style={{ color: theme.colors.textDim }}>
								• {completedTasks} of {totalTasks} task{totalTasks !== 1 ? 's' : ''} completed
							</span>
						</div>

						{/* Encouraging message */}
						<div
							className="p-4 rounded-lg mb-6"
							style={{
								backgroundColor: `${purpleAccent}10`,
								border: `1px solid ${purpleAccent}30`,
							}}
						>
							<div className="flex items-start gap-3">
								<Sparkles
									className="w-5 h-5 mt-0.5 flex-shrink-0"
									style={{ color: purpleAccent }}
								/>
								<div>
									<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
										A properly configured Auto Run can go on for{' '}
										<span className="font-semibold" style={{ color: purpleAccent }}>
											hours if not days
										</span>
										, autonomously completing complex tasks while you focus on other things.
									</p>
								</div>
							</div>
						</div>

						{/* Next steps */}
						<div className="space-y-3">
							<h2
								className="text-sm font-semibold uppercase tracking-wide"
								style={{ color: theme.colors.textDim }}
							>
								What's Next?
							</h2>

							<div className="space-y-2">
								<div
									className="flex items-start gap-3 p-3 rounded-lg"
									style={{
										backgroundColor: theme.colors.bgActivity,
									}}
								>
									<FileText
										className="w-4 h-4 mt-0.5 flex-shrink-0"
										style={{ color: theme.colors.success }}
									/>
									<div>
										<p className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
											Explore the additional Auto Run documents
										</p>
										<p className="text-xs" style={{ color: theme.colors.textDim }}>
											We created multiple documents that build on each other
										</p>
									</div>
								</div>

								<div
									className="flex items-start gap-3 p-3 rounded-lg"
									style={{
										backgroundColor: theme.colors.bgActivity,
									}}
								>
									<Rocket
										className="w-4 h-4 mt-0.5 flex-shrink-0"
										style={{ color: purpleAccent }}
									/>
									<div>
										<p className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
											Continue building your project
										</p>
										<p className="text-xs" style={{ color: theme.colors.textDim }}>
											Select a document in the Auto Run tab to run the next phase
										</p>
									</div>
								</div>

								<div
									className="flex items-start gap-3 p-3 rounded-lg"
									style={{
										backgroundColor: theme.colors.bgActivity,
									}}
								>
									<ArrowRight
										className="w-4 h-4 mt-0.5 flex-shrink-0"
										style={{ color: theme.colors.textDim }}
									/>
									<div>
										<p className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
											Or start fresh with new ideas
										</p>
										<p className="text-xs" style={{ color: theme.colors.textDim }}>
											Use Cmd+Shift+N to open the wizard anytime
										</p>
									</div>
								</div>
							</div>
						</div>
					</div>

					{/* Button */}
					<div className="px-8 pb-8 space-y-3">
						<button
							onClick={handleClose}
							disabled={isClosing}
							className="w-full py-3 rounded-lg font-medium transition-all hover:scale-[1.02] disabled:opacity-70 disabled:cursor-not-allowed"
							style={{
								background: isStandingOvation
									? `linear-gradient(135deg, ${purpleAccent} 0%, ${goldColor} 100%)`
									: `linear-gradient(135deg, ${purpleAccent} 0%, ${theme.colors.success} 100%)`,
								color: '#FFFFFF',
								boxShadow: `0 4px 20px ${purpleAccent}40`,
							}}
						>
							{isClosing ? "🎉 Let's Go! 🎉" : 'Got It!'}
						</button>

						{/* Leaderboard Registration */}
						{onOpenLeaderboardRegistration && !isLeaderboardRegistered && (
							<button
								onClick={() => {
									handleClose();
									setTimeout(() => {
										onOpenLeaderboardRegistration();
									}, 1100); // Wait for close animation
								}}
								disabled={isClosing}
								className="w-full py-2.5 rounded-lg font-medium transition-all flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-50"
								style={{
									backgroundColor: `${goldColor}20`,
									color: goldColor,
									border: `1px solid ${goldColor}60`,
								}}
							>
								<Trophy className="w-4 h-4" />
								Join Global Leaderboard
							</button>
						)}

						<p className="text-xs text-center" style={{ color: theme.colors.textDim }}>
							Press Enter or Escape to dismiss
						</p>
					</div>
				</div>
			</div>
		</>
	);
}

export default FirstRunCelebration;
