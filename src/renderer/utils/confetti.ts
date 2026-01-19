/**
 * confetti.ts
 *
 * Lightweight confetti animation utility using canvas-confetti.
 * Provides a simple triggerConfetti() function that creates a celebratory
 * burst from the center of the screen with auto-cleanup.
 */

import confetti from 'canvas-confetti';

/**
 * Options for customizing the confetti animation
 */
export interface ConfettiOptions {
	/** Particle count (default: 150) */
	particleCount?: number;
	/** Spread angle in degrees (default: 70) */
	spread?: number;
	/** Origin point { x: 0-1, y: 0-1 } (default: center bottom { x: 0.5, y: 0.9 }) */
	origin?: { x: number; y: number };
	/** Custom colors array (default: celebratory palette) */
	colors?: string[];
	/** Whether to fire multiple bursts (default: true) */
	multiBurst?: boolean;
	/** Disable for users with reduced motion preference (default: true) */
	respectReducedMotion?: boolean;
	/** Skip confetti animation entirely (user preference from settings) */
	disabled?: boolean;
}

/**
 * Default celebratory color palette
 */
const DEFAULT_COLORS = [
	'#FFD700', // Gold
	'#FF6B6B', // Red
	'#4ECDC4', // Teal
	'#45B7D1', // Blue
	'#FFA726', // Orange
	'#BA68C8', // Purple
	'#F48FB1', // Pink
	'#FFEAA7', // Yellow
];

/**
 * Z-index for confetti canvas - high enough to be above most UI elements
 * but below modals (which typically use 99999)
 */
const CONFETTI_Z_INDEX = 99998;

/**
 * Triggers a confetti animation burst from the center of the screen.
 * Duration is approximately 2 seconds with auto-cleanup.
 *
 * @param options - Optional configuration for the confetti animation
 * @returns void
 *
 * @example
 * // Basic usage - center burst
 * triggerConfetti();
 *
 * @example
 * // Custom options
 * triggerConfetti({
 *   particleCount: 200,
 *   spread: 90,
 *   colors: ['#FF0000', '#00FF00', '#0000FF'],
 * });
 *
 * @example
 * // Fire from a specific location
 * triggerConfetti({
 *   origin: { x: 0.5, y: 0.5 }, // Center of screen
 *   multiBurst: false,
 * });
 */
export function triggerConfetti(options: ConfettiOptions = {}): void {
	const {
		particleCount = 150,
		spread = 70,
		origin = { x: 0.5, y: 0.9 },
		colors = DEFAULT_COLORS,
		multiBurst = true,
		respectReducedMotion = true,
		disabled = false,
	} = options;

	// Skip if disabled by user setting
	if (disabled) {
		return;
	}

	// Respect reduced motion preference
	if (respectReducedMotion) {
		const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (prefersReducedMotion) {
			return;
		}
	}

	const defaults = {
		particleCount,
		spread,
		startVelocity: 45,
		gravity: 1,
		decay: 0.9,
		drift: 0,
		scalar: 1.1,
		ticks: 200, // ~2 seconds at 60fps
		shapes: ['circle', 'square'] as ('circle' | 'square')[],
		colors,
		zIndex: CONFETTI_Z_INDEX,
		disableForReducedMotion: respectReducedMotion,
	};

	// Main center burst
	confetti({
		...defaults,
		origin,
		angle: 90,
	});

	if (multiBurst) {
		// Left burst - slightly delayed
		setTimeout(() => {
			confetti({
				...defaults,
				particleCount: Math.floor(particleCount * 0.6),
				origin: { x: origin.x - 0.3, y: origin.y },
				angle: 60,
			});
		}, 100);

		// Right burst - slightly delayed
		setTimeout(() => {
			confetti({
				...defaults,
				particleCount: Math.floor(particleCount * 0.6),
				origin: { x: origin.x + 0.3, y: origin.y },
				angle: 120,
			});
		}, 100);
	}
}

/**
 * Triggers an intense celebratory confetti burst with more particles
 * and additional star shapes. Great for major achievements.
 *
 * @param disabled - Skip confetti animation entirely (user preference from settings)
 *
 * @example
 * // For wizard completion or major milestones
 * triggerCelebration();
 */
export function triggerCelebration(disabled = false): void {
	// Skip if disabled by user setting
	if (disabled) {
		return;
	}

	triggerConfetti({
		particleCount: 300,
		spread: 100,
		multiBurst: true,
	});

	// Add a star burst from the center after a short delay
	setTimeout(() => {
		confetti({
			particleCount: 50,
			spread: 360,
			origin: { x: 0.5, y: 0.5 },
			startVelocity: 30,
			gravity: 0.8,
			scalar: 1.5,
			ticks: 250,
			shapes: ['star'] as 'star'[],
			colors: ['#FFD700', '#FFA500', '#FFFFFF'],
			zIndex: CONFETTI_Z_INDEX,
			disableForReducedMotion: true,
		});
	}, 300);
}

/**
 * Clears any active confetti animation immediately.
 * Useful for cleanup when navigating away or closing modals.
 */
export function clearConfetti(): void {
	confetti.reset();
}
