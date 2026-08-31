/**
 * Power Manager - System Sleep Prevention
 *
 * Manages system sleep prevention using Electron's powerSaveBlocker API.
 * Uses reference counting to handle multiple concurrent activities (busy sessions, Auto Run).
 *
 * Platform Support:
 * - macOS: Full support via IOPMAssertionCreateWithName (like `caffeinate`)
 * - Windows: Full support via SetThreadExecutionState
 * - Linux: Varies by desktop environment, uses D-Bus or X11
 */

import { powerSaveBlocker } from 'electron';
import { logger } from './utils/logger';
import { captureException } from './utils/sentry';

const CONTEXT = 'PowerManager';

/**
 * The kind of sleep a caller needs to prevent.
 *
 * Per Electron's documentation:
 * - `prevent-app-suspension` - "Prevent the application from being suspended.
 *   Keeps system active but allows screen to be turned off."
 * - `prevent-display-sleep` - "Prevent the display from going to sleep."
 *
 * Nearly every caller wants the former. Background work needs the machine awake;
 * it does not need the panel lit. Ask for `prevent-display-sleep` only when a
 * human is meant to be looking at the screen.
 *
 * Why this distinction is load-bearing on macOS: a held display-sleep assertion
 * is how the OS decides a user is present. The Duet Activity Scheduler (dasd)
 * gates the whole discretionary maintenance tier on that signal, so an app that
 * holds one indefinitely stops Spotlight indexing, Photos analysis, XProtect
 * scans, database cleanups and software updates for as long as it runs. An
 * app-suspension blocker keeps timers firing without making that claim.
 */
export type PowerBlockerType = 'prevent-app-suspension' | 'prevent-display-sleep';

/**
 * Electron resolves competing blockers by precedence, not by recency:
 * "prevent-display-sleep has higher precedence over prevent-app-suspension.
 * Only the highest precedence type takes effect."
 *
 * A single process therefore gets one effective blocker, so we track a type per
 * reason and hold a blocker at the strongest type currently requested.
 */
const BLOCKER_PRECEDENCE: Record<PowerBlockerType, number> = {
	'prevent-app-suspension': 0,
	'prevent-display-sleep': 1,
};

/**
 * Status information returned by getStatus()
 */
export interface PowerStatus {
	/** Whether sleep prevention is enabled by user preference */
	enabled: boolean;
	/** Whether we are currently blocking sleep (enabled AND have active reasons) */
	blocking: boolean;
	/** List of active reasons for blocking (e.g., "session:abc123", "autorun:batch1") */
	reasons: string[];
	/** The blocker type currently in effect, or null when not blocking */
	blockerType: PowerBlockerType | null;
	/** Current platform */
	platform: 'darwin' | 'win32' | 'linux';
}

/**
 * Centralized power management for Maestro.
 *
 * Sleep prevention is only active when:
 * 1. The user has enabled the feature (setEnabled(true))
 * 2. There are active reasons to block sleep (busy sessions, Auto Run)
 *
 * Reasons follow a naming convention:
 * - "session:{sessionId}" - AI session is busy
 * - "autorun:{identifier}" - Auto Run is active
 * - "cue:run:{runId}" - Cue run is executing
 * - "groupchat:{groupChatId}" - Group chat round is in flight
 *
 * All of the above are background work and default to `prevent-app-suspension`.
 * Pass `prevent-display-sleep` explicitly, and only when the display itself is
 * the point.
 */
class PowerManager {
	/** ID of the active powerSaveBlocker, or null if not blocking */
	private blockerId: number | null = null;

	/** Active reasons for blocking sleep, each with the type it asked for */
	private activeReasons: Map<string, PowerBlockerType> = new Map();

	/** The type the active blocker was started with, or null when not blocking */
	private activeType: PowerBlockerType | null = null;

	/** User preference - whether sleep prevention feature is enabled */
	private enabled: boolean = false;

	constructor() {
		// Log platform support information on init
		const platform = process.platform;
		if (platform === 'linux') {
			logger.warn(
				'Sleep prevention on Linux varies by desktop environment. Works on GNOME, KDE, XFCE. May not work on minimal WMs.',
				CONTEXT
			);
		}
		logger.debug(`PowerManager initialized on platform: ${platform}`, CONTEXT);
	}

	/**
	 * Enable or disable the sleep prevention feature.
	 * When disabled, any active blockers are stopped.
	 * When enabled, blocking starts if there are active reasons.
	 */
	setEnabled(enabled: boolean): void {
		const wasEnabled = this.enabled;
		this.enabled = enabled;

		logger.info(`Sleep prevention ${enabled ? 'enabled' : 'disabled'}`, CONTEXT);

		if (wasEnabled !== enabled) {
			this.syncBlocker();
		}
	}

	/**
	 * Check if sleep prevention is enabled.
	 */
	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Add a reason to prevent sleep.
	 *
	 * @param reason - Identifier for why we're blocking (e.g., "session:abc123")
	 * @param type - What to prevent. Defaults to `prevent-app-suspension`, which
	 *   keeps the system awake while still letting the display sleep. Only pass
	 *   `prevent-display-sleep` when a human is meant to be watching the screen.
	 */
	addBlockReason(reason: string, type: PowerBlockerType = 'prevent-app-suspension'): void {
		if (this.activeReasons.get(reason) === type) {
			logger.debug(`Block reason already active: ${reason} (${type})`, CONTEXT);
			return;
		}

		this.activeReasons.set(reason, type);
		logger.debug(
			`Added block reason: ${reason} (${type}, total: ${this.activeReasons.size})`,
			CONTEXT
		);

		this.syncBlocker();
	}

	/**
	 * Remove a reason for blocking sleep.
	 * If no reasons remain, stops blocking.
	 *
	 * @param reason - Identifier to remove
	 */
	removeBlockReason(reason: string): void {
		if (!this.activeReasons.has(reason)) {
			logger.debug(`Block reason not found: ${reason}`, CONTEXT);
			return;
		}

		this.activeReasons.delete(reason);
		logger.debug(
			`Removed block reason: ${reason} (remaining: ${this.activeReasons.size})`,
			CONTEXT
		);

		this.syncBlocker();
	}

	/**
	 * Clear all reasons and stop blocking.
	 * Useful for cleanup on app shutdown.
	 */
	clearAllReasons(): void {
		const count = this.activeReasons.size;
		this.activeReasons.clear();
		logger.info(`Cleared all ${count} block reasons`, CONTEXT);

		this.syncBlocker();
	}

	/**
	 * Get current power management status.
	 */
	getStatus(): PowerStatus {
		return {
			enabled: this.enabled,
			blocking: this.blockerId !== null,
			reasons: Array.from(this.activeReasons.keys()),
			blockerType: this.activeType,
			platform: process.platform as 'darwin' | 'win32' | 'linux',
		};
	}

	/**
	 * The strongest blocker type any active reason is asking for, or null when
	 * there are no reasons. Electron only honours the highest-precedence type, so
	 * this is the one type the process can actually hold.
	 */
	private requiredType(): PowerBlockerType | null {
		let required: PowerBlockerType | null = null;
		for (const type of this.activeReasons.values()) {
			if (required === null || BLOCKER_PRECEDENCE[type] > BLOCKER_PRECEDENCE[required]) {
				required = type;
			}
		}
		return required;
	}

	/**
	 * Reconcile the live blocker with what the current reasons require.
	 *
	 * Single entry point for every state change, so adding a reason, removing one,
	 * or toggling the feature all converge on the same logic. A change of required
	 * type restarts the blocker, because Electron blockers are immutable once
	 * started.
	 */
	private syncBlocker(): void {
		const required = this.enabled ? this.requiredType() : null;

		if (required === this.activeType) return;

		if (this.blockerId !== null) {
			this.stopBlocking();
		}
		if (required !== null) {
			this.startBlocking(required);
		}
	}

	/**
	 * Start the power save blocker at the given type.
	 */
	private startBlocking(type: PowerBlockerType): void {
		if (this.blockerId !== null) {
			logger.debug('Already blocking, skipping start', CONTEXT);
			return;
		}

		try {
			this.blockerId = powerSaveBlocker.start(type);
			this.activeType = type;
			logger.info(`Started power save blocker (id: ${this.blockerId}, type: ${type})`, CONTEXT, {
				reasons: Array.from(this.activeReasons.keys()),
				platform: process.platform,
			});
		} catch (error) {
			void captureException(error);
			logger.error('Failed to start power save blocker', CONTEXT, error);
			this.blockerId = null;
			this.activeType = null;
		}
	}

	/**
	 * Stop the power save blocker.
	 */
	private stopBlocking(): void {
		if (this.blockerId === null) {
			logger.debug('Not blocking, skipping stop', CONTEXT);
			return;
		}

		try {
			// Verify the blocker is still active before stopping
			if (powerSaveBlocker.isStarted(this.blockerId)) {
				powerSaveBlocker.stop(this.blockerId);
				logger.info(`Stopped power save blocker (id: ${this.blockerId})`, CONTEXT);
			} else {
				logger.debug(`Power save blocker ${this.blockerId} was already stopped`, CONTEXT);
			}
		} catch (error) {
			void captureException(error);
			logger.error('Error stopping power save blocker', CONTEXT, error);
		} finally {
			this.blockerId = null;
			this.activeType = null;
		}
	}
}

// Export singleton instance
export const powerManager = new PowerManager();
