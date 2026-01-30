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

	// Check for null bytes (security issue on Unix systems)
	if (customPath.includes('\0')) {
		console.error(`Custom sync path contains null bytes: ${customPath}`);
		return false;
	}

	// Check for path traversal BEFORE normalization
	// Split by separator and check for literal ".." segments
	const segments = customPath.split(/[/\\]/);
	if (segments.includes('..')) {
		console.error(`Custom sync path contains traversal sequences: ${customPath}`);
		return false;
	}

	// Normalize the path to resolve any . segments and redundant separators
	const normalizedPath = path.normalize(customPath);

	// Reject paths that are too short (likely system directories)
	// Minimum reasonable path: /a/b (5 chars on Unix) or C:\a (4 chars on Windows)
	const minPathLength = process.platform === 'win32' ? 4 : 5;
	if (normalizedPath.length < minPathLength) {
		console.error(`Custom sync path is too short: ${customPath}`);
		return false;
	}

	// Check for Windows reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
	if (process.platform === 'win32') {
		const reservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
		const pathSegments = normalizedPath.split(/[/\\]/);
		for (const segment of pathSegments) {
			// Check the base name without extension
			const baseName = segment.split('.')[0];
			if (reservedNames.test(baseName)) {
				console.error(`Custom sync path contains Windows reserved name: ${customPath}`);
				return false;
			}
		}
	}

	// Reject known sensitive system directories
	// For Windows, check common sensitive paths across all drive letters
	const sensitiveRoots =
		process.platform === 'win32'
			? [
					'\\Windows',
					'\\Program Files',
					'\\Program Files (x86)',
					'\\System',
					'\\System32',
					'\\SysWOW64',
				]
			: ['/bin', '/sbin', '/usr/bin', '/usr/sbin', '/etc', '/var', '/tmp', '/dev', '/proc', '/sys'];

	const lowerPath = normalizedPath.toLowerCase();

	if (process.platform === 'win32') {
		// For Windows, check if any sensitive root appears after the drive letter
		// e.g., C:\Windows, D:\Windows, etc.
		for (const sensitive of sensitiveRoots) {
			const sensitiveLower = sensitive.toLowerCase();
			// Match pattern like "X:\Windows" or "X:\Windows\..."
			const drivePattern = /^[a-z]:/i;
			if (drivePattern.test(lowerPath)) {
				const pathWithoutDrive = lowerPath.slice(2); // Remove "C:" prefix
				if (
					pathWithoutDrive === sensitiveLower ||
					pathWithoutDrive.startsWith(sensitiveLower + '\\')
				) {
					console.error(`Custom sync path cannot be in sensitive system directory: ${customPath}`);
					return false;
				}
			}
		}
	} else {
		// Unix path checking
		for (const sensitive of sensitiveRoots) {
			if (lowerPath === sensitive || lowerPath.startsWith(sensitive + '/')) {
				console.error(`Custom sync path cannot be in sensitive system directory: ${customPath}`);
				return false;
			}
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
// WSL Detection (early, before app.ready)
// ============================================================================

/**
 * Detect if the current environment is WSL (Windows Subsystem for Linux).
 * This is a simplified version for early startup (before app.ready).
 * The full isWsl() from wslDetector.ts can be used after app.ready.
 */
function isWslEnvironment(): boolean {
	if (process.platform !== 'linux') {
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
} {
	const earlyStore = new Store<{
		crashReportingEnabled: boolean;
		disableGpuAcceleration: boolean;
	}>({
		name: 'maestro-settings',
		cwd: syncPath,
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
