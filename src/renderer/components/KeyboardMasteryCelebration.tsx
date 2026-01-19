/**
 * KeyboardMasteryCelebration.tsx
 *
 * Celebratory modal that appears when users reach a new keyboard mastery level.
 * Features music-themed confetti animation, level-specific messaging,
 * and encouraging progression guidance.
 */

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { Keyboard, Trophy, Sparkles } from 'lucide-react';
import confetti from 'canvas-confetti';
import type { Theme, Shortcut } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { KEYBOARD_MASTERY_LEVELS } from '../constants/keyboardMastery';
import { DEFAULT_SHORTCUTS } from '../constants/shortcuts';

interface KeyboardMasteryCelebrationProps {
	theme: Theme;
	level: number; // 0-4 (Beginner, Student, Performer, Virtuoso, Maestro)
	onClose: () => void;
	shortcuts?: Record<string, Shortcut>;
	/** Whether confetti animations are disabled by user preference */
	disableConfetti?: boolean;
}

// Music-themed colors
const goldColor = '#FFD700';
const musicPurple = '#9B59B6';

// Different confetti intensities per level
const confettiIntensity: Record<number, { particleCount: number; spread: number }> = {
	0: { particleCount: 50, spread: 50 }, // Beginner
	1: { particleCount: 100, spread: 60 }, // Student
	2: { particleCount: 200, spread: 80 }, // Performer
	3: { particleCount: 300, spread: 100 }, // Virtuoso
	4: { particleCount: 500, spread: 120 }, // Maestro - big celebration!
};

// Z-index layering: backdrop (99997) < confetti (99998) < modal (99999)
const CONFETTI_Z_INDEX = 99998;

/**
 * KeyboardMasteryCelebration - Modal celebrating the user reaching a new mastery level
 */
/**
 * Format shortcut keys for display (e.g., ['Meta', '/'] -> '⌘/')
 */
function formatShortcutKeys(keys: string[], isMac: boolean): string {
	return keys
		.map((key) => {
			if (key === 'Meta') return isMac ? '⌘' : 'Ctrl';
			if (key === 'Alt') return isMac ? '⌥' : 'Alt';
			if (key === 'Shift') return '⇧';
			if (key === 'Control') return isMac ? '⌃' : 'Ctrl';
			return key;
		})
		.join('');
}

export function KeyboardMasteryCelebration({
	theme,
	level,
	onClose,
	shortcuts,
	disableConfetti = false,
}: KeyboardMasteryCelebrationProps): JSX.Element {
	const containerRef = useRef<HTMLDivElement>(null);
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Use ref for isClosing to avoid race conditions and stale closures
	const isClosingRef = useRef(false);
	const [isClosing, setIsClosing] = useState(false);

	// Track active timeouts for cleanup
	const timeoutsRef = useRef<NodeJS.Timeout[]>([]);

	// Determine level info
	const levelInfo = KEYBOARD_MASTERY_LEVELS[level] || KEYBOARD_MASTERY_LEVELS[0];
	const isMaestro = level === 4;

	// Get help shortcut for display
	const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
	const helpShortcut = useMemo(() => {
		const activeShortcuts = shortcuts || DEFAULT_SHORTCUTS;
		const helpKeys = activeShortcuts.help?.keys || ['Meta', '/'];
		return formatShortcutKeys(helpKeys, isMac);
	}, [shortcuts, isMac]);

	// Fire confetti burst - returns timeout ID for cleanup
	const fireConfetti = useCallback(() => {
		// Skip if disabled by user preference
		if (disableConfetti) return;

		// Check for reduced motion preference
		const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (prefersReducedMotion) return;

		const intensity = confettiIntensity[level] || confettiIntensity[0];

		// Musical note-inspired colors
		const colors = isMaestro
			? ['#FFD700', '#FFA500', '#9B59B6', '#E91E63', '#00BCD4'] // Gold-heavy for Maestro
			: ['#9B59B6', '#E91E63', '#00BCD4', '#4CAF50', '#FF9800']; // Purple-heavy for others

		confetti({
			particleCount: intensity.particleCount,
			spread: intensity.spread,
			origin: { x: 0.5, y: 0.6 },
			colors,
			shapes: ['circle', 'star'] as ('circle' | 'star')[],
			scalar: 1.2,
			zIndex: CONFETTI_Z_INDEX,
			disableForReducedMotion: true,
		});

		// Extra burst for Maestro - track timeout for cleanup
		if (isMaestro) {
			const burstTimeout = setTimeout(() => {
				confetti({
					particleCount: 100,
					spread: 360,
					origin: { x: 0.5, y: 0.4 },
					colors: [goldColor],
					shapes: ['star'] as 'star'[],
					scalar: 1.5,
					zIndex: CONFETTI_Z_INDEX,
					disableForReducedMotion: true,
				});
			}, 300);
			timeoutsRef.current.push(burstTimeout);
		}
	}, [level, isMaestro, disableConfetti]);

	// Fire confetti on mount with cleanup
	useEffect(() => {
		fireConfetti();
		return () => {
			// Clear all tracked timeouts on unmount
			timeoutsRef.current.forEach(clearTimeout);
			timeoutsRef.current = [];
		};
	}, []);

	// Handle close with confetti - use ref to avoid stale state
	const handleClose = useCallback(() => {
		if (isClosingRef.current) return;
		isClosingRef.current = true;
		setIsClosing(true);

		// Fire closing confetti
		fireConfetti();

		// Wait then close - track timeout for cleanup
		const closeTimeout = setTimeout(() => {
			onCloseRef.current();
		}, 800);
		timeoutsRef.current.push(closeTimeout);
	}, [fireConfetti]);

	// Stable ref for handleClose to avoid re-attaching keyboard listener
	const handleCloseRef = useRef(handleClose);
	handleCloseRef.current = handleClose;

	// Handle keyboard events - use ref to avoid stale closure
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === 'Escape') {
				e.preventDefault();
				handleCloseRef.current();
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, []); // Empty deps - handler reads from ref

	// Register with layer stack
	useEffect(() => {
		const id = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.KEYBOARD_MASTERY,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Keyboard Mastery Level Up Celebration',
			onEscape: () => handleCloseRef.current(),
		});
		layerIdRef.current = id;

		containerRef.current?.focus();

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [registerLayer, unregisterLayer]);

	// Update escape handler when handleClose changes
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, handleClose);
		}
	}, [updateLayerHandler, handleClose]);

	// Get next level info for encouragement message
	const nextLevel =
		level < KEYBOARD_MASTERY_LEVELS.length - 1 ? KEYBOARD_MASTERY_LEVELS[level + 1] : null;

	return (
		<>
			{/* Backdrop */}
			<div
				className="fixed inset-0 z-[99997] animate-in fade-in duration-300"
				onClick={handleClose}
				style={{ backgroundColor: 'rgba(0, 0, 0, 0.8)' }}
			/>

			{/* Modal */}
			<div
				ref={containerRef}
				className="fixed inset-0 flex items-center justify-center z-[99999] pointer-events-none p-4"
				role="dialog"
				aria-modal="true"
				aria-label="Keyboard Mastery Level Up"
				tabIndex={-1}
			>
				<div
					className={`relative max-w-md w-full rounded-2xl shadow-2xl overflow-hidden transition-all duration-300 pointer-events-auto ${
						isClosing ? 'opacity-0 scale-95' : 'animate-in zoom-in-95'
					}`}
					onClick={(e) => e.stopPropagation()}
					style={{
						backgroundColor: theme.colors.bgSidebar,
						border: `2px solid ${isMaestro ? goldColor : musicPurple}`,
						boxShadow: `0 0 40px ${isMaestro ? goldColor : musicPurple}40`,
					}}
				>
					{/* Header */}
					<div
						className="relative px-6 pt-6 pb-4 text-center"
						style={{
							background: `linear-gradient(180deg, ${isMaestro ? goldColor : musicPurple}20 0%, transparent 100%)`,
						}}
					>
						{/* Icon */}
						<div className="flex justify-center mb-4">
							<div
								className="relative p-4 rounded-full animate-bounce"
								style={{
									background: isMaestro
										? `linear-gradient(135deg, ${goldColor} 0%, #FFA500 100%)`
										: `linear-gradient(135deg, ${musicPurple} 0%, #E91E63 100%)`,
									boxShadow: `0 0 30px ${isMaestro ? goldColor : musicPurple}60`,
								}}
							>
								{isMaestro ? (
									<Trophy className="w-8 h-8 text-white" />
								) : (
									<Keyboard className="w-8 h-8 text-white" />
								)}
							</div>
						</div>

						{/* Title */}
						<h1
							className="text-2xl font-bold mb-1"
							style={{
								color: isMaestro ? goldColor : theme.colors.textMain,
								textShadow: isMaestro ? `0 0 20px ${goldColor}60` : undefined,
							}}
						>
							{isMaestro ? 'Keyboard Maestro!' : 'Level Up!'}
						</h1>

						<p className="text-lg" style={{ color: theme.colors.textMain }}>
							You've reached{' '}
							<span style={{ color: isMaestro ? goldColor : musicPurple, fontWeight: 600 }}>
								{isMaestro ? 'the highest level' : levelInfo.name}
							</span>
						</p>
					</div>

					{/* Content */}
					<div className="px-6 pb-6">
						{/* Level description */}
						<div
							className="flex items-center justify-center gap-2 p-3 rounded-lg mb-4"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							<Sparkles className="w-4 h-4" style={{ color: musicPurple }} />
							<span className="text-sm" style={{ color: theme.colors.textDim }}>
								{levelInfo.description}
							</span>
						</div>

						{/* Progress indicator */}
						<div className="flex items-center justify-center gap-1 mb-4">
							{KEYBOARD_MASTERY_LEVELS.map((l, i) => (
								<div
									key={l.id}
									className="w-8 h-1.5 rounded-full transition-colors"
									style={{
										backgroundColor:
											i <= level ? (i === 4 ? goldColor : musicPurple) : theme.colors.border,
									}}
								/>
							))}
						</div>

						{/* Encouragement message */}
						<p className="text-xs text-center mb-2" style={{ color: theme.colors.textDim }}>
							{isMaestro
								? "You've mastered all keyboard shortcuts!"
								: `Keep using shortcuts to reach ${nextLevel?.name || 'the next level'}!`}
						</p>

						{/* Shortcut hint */}
						<p className="text-xs text-center mb-4" style={{ color: theme.colors.textDim }}>
							Press{' '}
							<span
								className="font-mono px-1.5 py-0.5 rounded"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								{helpShortcut}
							</span>{' '}
							to see all shortcuts and your progress
						</p>

						{/* Close button */}
						<button
							onClick={handleClose}
							disabled={isClosing}
							className="w-full py-2.5 rounded-lg font-medium transition-all hover:scale-[1.02] disabled:opacity-70"
							style={{
								background: isMaestro
									? `linear-gradient(135deg, ${musicPurple} 0%, ${goldColor} 100%)`
									: `linear-gradient(135deg, ${musicPurple} 0%, #E91E63 100%)`,
								color: '#FFFFFF',
								boxShadow: `0 4px 20px ${musicPurple}40`,
							}}
						>
							{isClosing ? 'Onwards!' : 'Continue'}
						</button>

						<p className="text-xs text-center mt-3" style={{ color: theme.colors.textDim }}>
							Press Enter or Escape to dismiss
						</p>
					</div>
				</div>
			</div>
		</>
	);
}

export default KeyboardMasteryCelebration;
