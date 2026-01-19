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

const CONTEXT = 'PowerManager';

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
 */
class PowerManager {
	/** ID of the active powerSaveBlocker, or null if not blocking */
	private blockerId: number | null = null;

	/** Set of active reasons for blocking sleep */
	private activeReasons: Set<string> = new Set();

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
			if (enabled && this.activeReasons.size > 0) {
				// Re-enable: start blocking if we have active reasons
				this.startBlocking();
			} else if (!enabled && this.blockerId !== null) {
				// Disable: stop any active blocking
				this.stopBlocking();
			}
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
	 * If this is the first reason and feature is enabled, starts blocking.
	 *
	 * @param reason - Identifier for why we're blocking (e.g., "session:abc123")
	 */
	addBlockReason(reason: string): void {
		if (this.activeReasons.has(reason)) {
			logger.debug(`Block reason already active: ${reason}`, CONTEXT);
			return;
		}

		this.activeReasons.add(reason);
		logger.debug(`Added block reason: ${reason} (total: ${this.activeReasons.size})`, CONTEXT);

		// Start blocking if this is the first reason and feature is enabled
		if (this.activeReasons.size === 1 && this.enabled && this.blockerId === null) {
			this.startBlocking();
		}
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

		// Stop blocking if no more reasons
		if (this.activeReasons.size === 0 && this.blockerId !== null) {
			this.stopBlocking();
		}
	}

	/**
	 * Clear all reasons and stop blocking.
	 * Useful for cleanup on app shutdown.
	 */
	clearAllReasons(): void {
		const count = this.activeReasons.size;
		this.activeReasons.clear();
		logger.info(`Cleared all ${count} block reasons`, CONTEXT);

		if (this.blockerId !== null) {
			this.stopBlocking();
		}
	}

	/**
	 * Get current power management status.
	 */
	getStatus(): PowerStatus {
		return {
			enabled: this.enabled,
			blocking: this.blockerId !== null,
			reasons: Array.from(this.activeReasons),
			platform: process.platform as 'darwin' | 'win32' | 'linux',
		};
	}

	/**
	 * Start the power save blocker.
	 * Uses 'prevent-display-sleep' which also prevents system sleep.
	 */
	private startBlocking(): void {
		if (this.blockerId !== null) {
			logger.debug('Already blocking, skipping start', CONTEXT);
			return;
		}

		try {
			// 'prevent-display-sleep' prevents both display and system sleep
			// This is the more aggressive option, appropriate for long-running AI tasks
			this.blockerId = powerSaveBlocker.start('prevent-display-sleep');
			logger.info(`Started power save blocker (id: ${this.blockerId})`, CONTEXT, {
				reasons: Array.from(this.activeReasons),
				platform: process.platform,
			});
		} catch (error) {
			logger.error('Failed to start power save blocker', CONTEXT, error);
			this.blockerId = null;
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
			logger.error('Error stopping power save blocker', CONTEXT, error);
		} finally {
			this.blockerId = null;
		}
	}
}

// Export singleton instance
export const powerManager = new PowerManager();
