/**
 * Store Utilities
 *
 * Helper functions for store operations including:
 * - Sync path resolution
 * - Early settings access (before app.ready)
 * - SSH remote configuration lookup
 */

import path from 'path';

import Store from 'electron-store';
import fsSync from 'fs';

import type { BootstrapSettings } from './types';
import type { SshRemoteConfig } from '../../shared/types';

// Re-export getDefaultShell from defaults for backward compatibility
export { getDefaultShell } from './defaults';

// ============================================================================
// Path Validation Utilities
// ============================================================================

/**
 * Validates a custom sync path for security and correctness.
 * @returns true if the path is valid, false otherwise
 */
function isValidSyncPath(customPath: string): boolean {
	// Path must be absolute
	if (!path.isAbsolute(customPath)) {
		console.error(`Custom sync path must be absolute: ${customPath}`);
		return false;
	}

	// Normalize the path to resolve any .. or . segments
	const normalizedPath = path.normalize(customPath);

	// Check for path traversal attempts (normalized path should match original intent)
	// If the normalized path is significantly different, it might indicate traversal
	if (normalizedPath.includes('..')) {
		console.error(`Custom sync path contains invalid traversal sequences: ${customPath}`);
		return false;
	}

	// Reject paths that are too short (likely system directories)
	// Minimum reasonable path: /a/b (5 chars on Unix) or C:\a (4 chars on Windows)
	const minPathLength = process.platform === 'win32' ? 4 : 5;
	if (normalizedPath.length < minPathLength) {
		console.error(`Custom sync path is too short: ${customPath}`);
		return false;
	}

	// Reject known sensitive system directories
	const sensitiveRoots =
		process.platform === 'win32'
			? ['C:\\Windows', 'C:\\Program Files', 'C:\\System']
			: ['/bin', '/sbin', '/usr/bin', '/usr/sbin', '/etc', '/var', '/tmp', '/dev', '/proc', '/sys'];

	const lowerPath = normalizedPath.toLowerCase();
	for (const sensitive of sensitiveRoots) {
		if (
			lowerPath === sensitive.toLowerCase() ||
			lowerPath.startsWith(sensitive.toLowerCase() + path.sep)
		) {
			console.error(`Custom sync path cannot be in sensitive system directory: ${customPath}`);
			return false;
		}
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
// Early Settings Access
// ============================================================================

/**
 * Get early settings that need to be read before app.ready.
 * Used for crash reporting and GPU acceleration settings.
 *
 * This creates a temporary store instance just for reading these values
 * before the full store initialization happens.
 */
export function getEarlySettings(syncPath: string): {
	crashReportingEnabled: boolean;
	disableGpuAcceleration: boolean;
} {
	const earlyStore = new Store<{
		crashReportingEnabled: boolean;
		disableGpuAcceleration: boolean;
	}>({
		name: 'maestro-settings',
		cwd: syncPath,
	});

	return {
		crashReportingEnabled: earlyStore.get('crashReportingEnabled', true),
		disableGpuAcceleration: earlyStore.get('disableGpuAcceleration', false),
	};
}

// ============================================================================
// SSH Remote Utilities
// ============================================================================

/**
 * Get SSH remote configuration by ID from a settings store.
 * Returns undefined if not found.
 *
 * Note: This is a lower-level function that takes a store instance.
 * For convenience, use getSshRemoteById() from the main stores module
 * which automatically uses the initialized settings store.
 */
export function findSshRemoteById(
	sshRemotes: SshRemoteConfig[],
	sshRemoteId: string
): SshRemoteConfig | undefined {
	return sshRemotes.find((r) => r.id === sshRemoteId);
}
