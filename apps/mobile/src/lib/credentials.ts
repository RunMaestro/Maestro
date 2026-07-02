/**
 * credentials.ts - SecureStore-backed credential management for Maestro mobile
 *
 * Stores and retrieves the pairing credentials obtained via QR code scanning.
 * Credentials include: host, port, token (long-lived auth token from desktop),
 * pairingId (device ID from the pairing record), and deviceName.
 *
 * Part of M3 Mobile Expo App implementation (decision 15B QR pairing).
 */

import * as SecureStore from 'expo-secure-store';

const CREDENTIALS_KEY = 'maestro.pairing.active';

export interface MaestroCredentials {
	host: string;
	port: number;
	token: string;
	pairingId: string;
	deviceName: string;
}

/**
 * Store pairing credentials in secure storage.
 * Called after successfully scanning QR code and exchanging the pairing code.
 */
export async function storeCredentials(credentials: MaestroCredentials): Promise<void> {
	await SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify(credentials));
}

/**
 * Retrieve stored pairing credentials.
 * Returns null if no credentials are stored (app needs pairing).
 */
export async function getCredentials(): Promise<MaestroCredentials | null> {
	try {
		const stored = await SecureStore.getItemAsync(CREDENTIALS_KEY);
		if (!stored) return null;
		return JSON.parse(stored) as MaestroCredentials;
	} catch {
		return null;
	}
}

/**
 * Check if the app has stored credentials.
 * Used to determine if we should show the pairing screen.
 */
export async function hasCredentials(): Promise<boolean> {
	const creds = await getCredentials();
	return creds !== null;
}

/**
 * Clear stored credentials.
 * Used when unpairing or when credentials are invalid.
 */
export async function clearCredentials(): Promise<void> {
	await SecureStore.deleteItemAsync(CREDENTIALS_KEY);
}

/**
 * Build the WebSocket URL from stored credentials.
 * Returns null if no credentials are stored.
 */
export async function buildWebSocketUrlFromCredentials(sessionId?: string): Promise<string | null> {
	const creds = await getCredentials();
	if (!creds) return null;

	let url = `ws://${creds.host}:${creds.port}/${creds.token}/ws`;
	if (sessionId) {
		url += `?sessionId=${encodeURIComponent(sessionId)}`;
	}
	return url;
}
