/**
 * Version utility for ACP module
 *
 * Provides a safe way to get the Maestro app version that works
 * in both Electron main process and test environments.
 */

/**
 * Get the Maestro app version.
 * Falls back to package.json version if Electron app is not available.
 */
export function getAppVersion(): string {
	try {
		// Try to get version from Electron app
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { app } = require('electron');
		if (app && typeof app.getVersion === 'function') {
			return app.getVersion();
		}
	} catch {
		// Electron not available (e.g., in tests)
	}

	try {
		// Fall back to package.json
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const pkg = require('../../../package.json');
		return pkg.version || '0.0.0';
	} catch {
		// Package.json not available
	}

	return '0.0.0';
}
