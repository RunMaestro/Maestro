/**
 * Platform substitute for src/web/utils/config.ts
 *
 * Uses SecureStore for production credentials obtained via QR pairing.
 * If no credentials are stored, the app navigates to the /pair screen.
 *
 * Part of M3 Mobile Expo App implementation (decision 6A QR pairing).
 */

import { getCredentials, hasCredentials, type MaestroCredentials } from '../src/lib/credentials';

/** In-memory cache for credentials after first load */
let cachedCredentials: MaestroCredentials | null = null;
let credentialsLoaded = false;

/**
 * Get credentials from SecureStore.
 * Returns null if no credentials are stored (app needs pairing).
 */
export async function getConfig(): Promise<MaestroCredentials | null> {
	// Return cached credentials if already loaded
	if (credentialsLoaded && cachedCredentials) {
		return cachedCredentials;
	}

	// Read from SecureStore
	const stored = await getCredentials();
	if (stored) {
		cachedCredentials = stored;
		credentialsLoaded = true;
		return stored;
	}

	return null;
}

/**
 * Check if credentials are available in SecureStore.
 */
export async function hasConfig(): Promise<boolean> {
	const config = await getConfig();
	return config !== null;
}

/**
 * Clear cached credentials. Call this when credentials are updated
 * (e.g., after pairing) to force re-read from SecureStore.
 */
export function clearCredentialsCache(): void {
	cachedCredentials = null;
	credentialsLoaded = false;
}

/**
 * Build the WebSocket URL for connecting to Maestro desktop.
 * Uses the stored credentials from SecureStore.
 */
export async function buildWebSocketUrl(sessionId?: string): Promise<string | null> {
	const config = await getConfig();
	if (!config) return null;

	let url = `ws://${config.host}:${config.port}/${config.token}/ws`;
	if (sessionId) {
		url += `?sessionId=${encodeURIComponent(sessionId)}`;
	}
	return url;
}

// Re-export hasCredentials for convenience
export { hasCredentials };
