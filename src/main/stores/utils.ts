/**
 * Store Utilities
 *
 * Helper functions for store operations including:
 * - Sync path resolution
 * - Early settings access (before app.ready)
 * - SSH remote configuration lookup
 */

import { isWindows, isLinux } from '../../shared/platformDetection';
import { syncPathRejection } from '../../shared/maestro-lib/paths/syncPath';

import Store from 'electron-store';
import fsSync from 'fs';

import { parseJsonWithBom } from '../../shared/jsonUtils';
import type { BootstrapSettings } from './types';

// Re-export getDefaultShell from defaults for backward compatibility
export { getDefaultShell } from './defaults';

// ============================================================================
// Path Validation Utilities
// ============================================================================

/**
 * Validates a custom sync path for security and correctness.
 *
 * The rule lives in maestro-lib so a process without Electron (the CLI, the
 * TUI) rejects exactly the paths the desktop rejects and lands on the same
 * fallback directory.
 * @returns true if the path is valid, false otherwise
 */
function isValidSyncPath(customPath: string): boolean {
	const rejection = syncPathRejection(customPath);
	if (rejection) {
		console.error(rejection);
		return false;
	}
	return true;
}

// ============================================================================
// Sync Path Utilities
// ============================================================================

/**
 * Get the custom sync path from the bootstrap store.
 * Creates the directory if it doesn't exist.
 * Returns undefined if no custom path is configured, validation fails, or creation fails.
 */
export function getCustomSyncPath(bootstrapStore: Store<BootstrapSettings>): string | undefined {
	const customPath = bootstrapStore.get('customSyncPath');

	if (customPath) {
		// Validate the path before using it
		if (!isValidSyncPath(customPath)) {
			return undefined;
		}

		// Ensure the directory exists
		if (!fsSync.existsSync(customPath)) {
			try {
				fsSync.mkdirSync(customPath, { recursive: true });
			} catch {
				// If we can't create the directory, fall back to default
				console.error(`Failed to create custom sync path: ${customPath}, using default`);
				return undefined;
			}
		}
		return customPath;
	}

	return undefined;
}

// ============================================================================
// WSL Detection (early, before app.ready)
// ============================================================================

/**
 * Detect if the current environment is WSL (Windows Subsystem for Linux).
 * This is a simplified version for early startup (before app.ready).
 * The full isWsl() from wslDetector.ts can be used after app.ready.
 */
function isWslEnvironment(): boolean {
	if (!isLinux()) {
		return false;
	}

	try {
		if (fsSync.existsSync('/proc/version')) {
			const version = fsSync.readFileSync('/proc/version', 'utf8').toLowerCase();
			return version.includes('microsoft') || version.includes('wsl');
		}
	} catch {
		// Ignore read errors
	}

	return false;
}

// ============================================================================
// Early Settings Access
// ============================================================================

/**
 * Get early settings that need to be read before app.ready.
 * Used for crash reporting and GPU acceleration settings.
 *
 * This creates a temporary store instance just for reading these values
 * before the full store initialization happens.
 *
 * Note: In WSL environments, GPU acceleration is disabled by default due to
 * frequent GPU process crashes (EGL_EXT_create_context_robustness issues).
 * Users can still manually enable it if their WSL setup supports it.
 */
export function getEarlySettings(syncPath: string): {
	crashReportingEnabled: boolean;
	disableGpuAcceleration: boolean;
	useNativeTitleBar: boolean;
	autoHideMenuBar: boolean;
} {
	const earlyStore = new Store<{
		crashReportingEnabled: boolean;
		disableGpuAcceleration: boolean;
		useNativeTitleBar: boolean;
		autoHideMenuBar: boolean;
	}>({
		name: 'maestro-settings',
		cwd: syncPath,
		deserialize: parseJsonWithBom,
	});

	// Check if user has explicitly set GPU acceleration preference
	const explicitGpuSetting = earlyStore.get('disableGpuAcceleration');

	// In WSL, default to disabling GPU acceleration due to common EGL/GPU issues
	// unless the user has explicitly set a preference
	const isWsl = isWslEnvironment();
	const defaultDisableGpu = isWsl ? true : false;

	return {
		crashReportingEnabled: earlyStore.get('crashReportingEnabled', true),
		disableGpuAcceleration: explicitGpuSetting ?? defaultDisableGpu,
		useNativeTitleBar: earlyStore.get('useNativeTitleBar') ?? isWindows(),
		autoHideMenuBar: earlyStore.get('autoHideMenuBar', false),
	};
}

// ============================================================================
