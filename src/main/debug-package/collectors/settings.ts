/**
 * Settings Collector
 *
 * Collects application settings with sensitive data sanitized.
 * - API keys and tokens are replaced with [REDACTED]
 * - Usernames in paths are replaced with ~
 */

import os from 'os';
import Store from 'electron-store';

// Keys that contain sensitive data (case-insensitive matching)
const SENSITIVE_KEYS = [
	'apikey',
	'api_key',
	'authtoken',
	'auth_token',
	'clienttoken',
	'client_token',
	'password',
	'secret',
	'credential',
	'accesstoken',
	'access_token',
	'refreshtoken',
	'refresh_token',
	'privatekey',
	'private_key',
];

// Keys that contain paths which should have usernames sanitized
const PATH_KEYS = [
	'customsyncpath',
	'custompath',
	'ghpath',
	'customshellpath',
	'path',
	'cwd',
	'projectroot',
	'fullpath',
	'folderpath',
];

export interface SanitizedSettings {
	raw: Record<string, unknown>; // Sanitized settings object
	sanitizedFields: string[]; // List of fields that were sanitized
}

/**
 * Sanitize a file path by replacing the home directory with ~
 */
export function sanitizePath(pathStr: string): string {
	if (typeof pathStr !== 'string') return pathStr;
	const homeDir = os.homedir();
	// Handle both forward and backward slashes
	const normalizedPath = pathStr.replace(/\\/g, '/');
	const normalizedHome = homeDir.replace(/\\/g, '/');
	return normalizedPath.replace(normalizedHome, '~');
}

/**
 * Check if a key contains sensitive data based on its name
 */
function isSensitiveKey(key: string): boolean {
	const lowerKey = key.toLowerCase();
	return SENSITIVE_KEYS.some((sensitiveKey) => lowerKey.includes(sensitiveKey));
}

/**
 * Check if a key is a path that should be sanitized
 */
function isPathKey(key: string): boolean {
	const lowerKey = key.toLowerCase();
	return PATH_KEYS.some((pathKey) => lowerKey.includes(pathKey));
}

/**
 * Recursively sanitize an object, tracking what was sanitized
 */
function sanitizeObject(obj: unknown, sanitizedFields: string[], prefix: string = ''): unknown {
	if (obj === null || obj === undefined) {
		return obj;
	}

	if (Array.isArray(obj)) {
		return obj.map((item, index) => sanitizeObject(item, sanitizedFields, `${prefix}[${index}]`));
	}

	if (typeof obj === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			const fullKey = prefix ? `${prefix}.${key}` : key;

			if (isSensitiveKey(key)) {
				result[key] = '[REDACTED]';
				sanitizedFields.push(fullKey);
			} else if (typeof value === 'string' && isPathKey(key)) {
				result[key] = sanitizePath(value);
				if (result[key] !== value) {
					sanitizedFields.push(fullKey);
				}
			} else if (typeof value === 'object') {
				result[key] = sanitizeObject(value, sanitizedFields, fullKey);
			} else {
				result[key] = value;
			}
		}
		return result;
	}

	return obj;
}

/**
 * Collect application settings with sensitive data sanitized.
 */
export async function collectSettings(
	settingsStore: Store<any>,
	bootstrapStore?: Store<any>
): Promise<SanitizedSettings> {
	const sanitizedFields: string[] = [];

	// Get all settings from the store
	const allSettings = settingsStore.store || {};

	// Sanitize the settings
	const sanitized = sanitizeObject(allSettings, sanitizedFields) as Record<string, unknown>;

	// Add sync path info (just whether it's set, not the actual path)
	if (bootstrapStore) {
		const customSyncPath = bootstrapStore.get('customSyncPath');
		sanitized['_syncInfo'] = {
			hasCustomSyncPath: !!customSyncPath,
			customSyncPath: customSyncPath ? sanitizePath(customSyncPath) : undefined,
		};
	}

	return {
		raw: sanitized,
		sanitizedFields,
	};
}
